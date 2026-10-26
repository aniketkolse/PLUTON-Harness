import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProjectRoot, loadConfig, stateDir, type LoadedConfig } from '../../config/load.ts'
import { registerBuiltinEngines, listEngineKinds, getEngineAdapter } from '../../engines/registry.ts'
import { firstLine, run } from '../../util/exec.ts'
import { engineHomesDir } from '../../config/load.ts'
import { createNativeExecutionProvider } from '../../execution/factory.ts'
import { TMUX_NOT_INSTALLED_FIX } from '../../terminal/native.ts'
import type { CheckResult } from '../output.ts'

const MIN_NODE_MAJOR = 24

export interface DoctorOptions {
  cwd: string
  runFn?: typeof run
  findProjectRoot?: typeof findProjectRoot
}

export async function collectDoctorChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const exec = opts.runFn ?? run
  const findRoot = opts.findProjectRoot ?? findProjectRoot
  const checks: CheckResult[] = []
  registerBuiltinEngines()

  const root = findRoot(opts.cwd)
  let loadedConfig: LoadedConfig | null = null
  let configError: Error | null = null
  if (root) {
    try {
      loadedConfig = loadConfig(root)
    } catch (e) {
      configError = e as Error
    }
  }

  // 1. Node runtime
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { id: 'node', title: 'Node.js', status: 'pass', message: `v${process.versions.node}` }
      : {
          id: 'node',
          title: 'Node.js',
          status: 'fail',
          message: `v${process.versions.node} is too old (need >= ${MIN_NODE_MAJOR})`,
          fix: 'install Node.js 24 or newer',
        },
  )

  // 2. Platform capability: filesystem/network confinement requires Linux.
  if (process.platform === 'linux') {
    checks.push({
      id: 'platform',
      title: 'Platform',
      status: 'pass',
      message: 'linux (Landlock + user/mount/network/PID namespaces are available when the helper and kernel support them)',
    })
  } else {
    checks.push({
      id: 'platform',
      title: 'Platform',
      status: 'warn',
      message:
        `${process.platform} supports only mode unconfined with network_policy open; ` +
        'confined read-only/workspace-write/restricted/none sessions fail closed',
      fix: 'run confined work on Linux with the verified landlock-run helper',
    })
  }

  // 4. Git
  const git = await exec(['git', '--version'], { timeoutMs: 15_000 })
  checks.push(
    git.exitCode === 0
      ? { id: 'git', title: 'Git', status: 'pass', message: firstLine(git.stdout) }
      : { id: 'git', title: 'Git', status: 'fail', message: 'git not found', fix: 'install Git and ensure it is on PATH' },
  )

  // 5. Project config + storage
  if (!root) {
    checks.push({
      id: 'config',
      title: 'Project config',
      status: 'info',
      message: 'no pluton.yaml found from this directory upward',
      fix: 'run `pluton init` in the project you want to orchestrate',
    })
  } else if (configError !== null || loadedConfig === null) {
    checks.push({
      id: 'config',
      title: 'Project config',
      status: 'fail',
      message: configError?.message ?? 'could not load pluton.yaml',
      fix: 'fix pluton.yaml (see docs/MUSE_CONFIGURATION.md)',
    })
  } else {
    const ships = loadedConfig.config.ships
    checks.push({
      id: 'config',
      title: 'Project config',
      status: 'pass',
      message: `${root} (project '${loadedConfig.config.project.name}', ${Object.keys(ships).length} ship(s))`,
    })
    try {
      const sd = stateDir(root)
      mkdirSync(sd, { recursive: true })
      const probe = join(sd, `.write-test-${process.pid}`)
      writeFileSync(probe, 'ok')
      rmSync(probe)
      checks.push({ id: 'storage', title: 'State storage', status: 'pass', message: sd })
    } catch (e) {
      checks.push({
        id: 'storage',
        title: 'State storage',
        status: 'fail',
        message: `cannot write ${stateDir(root)}: ${(e as Error).message}`,
        fix: 'fix directory permissions on .pluton/state',
      })
    }
    // Engine checks per configured Ship
    const seen = new Set<string>()
    for (const [id, ship] of Object.entries(ships)) {
      const key = `${ship.engine}` // one discovery per engine kind is enough for install state
      const adapter = safeAdapter(ship.engine)
      if (!adapter) {
        checks.push({
          id: `engine:${ship.engine}`,
          title: `Engine '${ship.engine}' (ship ${id})`,
          status: 'fail',
          message: 'unknown engine kind — not in the engine registry',
          fix: `choose one of: ${listEngineKinds().map((k) => k.kind).join(', ')}`,
        })
        continue
      }
      const home = join(engineHomesDir(root), id)
      if (!seen.has(key)) {
        seen.add(key)
        const disc = await adapter.discover()
        checks.push(
          disc.installed
            ? {
                id: `engine:${ship.engine}`,
                title: `Engine '${ship.engine}'`,
                status: 'pass',
                message: `${disc.version ?? 'version unknown'} ${disc.binaryPath ? `(${disc.binaryPath})` : ''}`.trim(),
              }
            : {
                id: `engine:${ship.engine}`,
                title: `Engine '${ship.engine}'`,
                status: 'fail',
                message: 'not installed / not on PATH',
                fix: disc.fix,
              },
        )
      }
      const auth = await adapter.authStatus(home)
      checks.push(
        auth.configured
          ? { id: `auth:${id}`, title: `Auth for ship '${id}'`, status: 'pass', message: 'configured' }
          : {
              id: `auth:${id}`,
              title: `Auth for ship '${id}'`,
              status: 'warn',
              message: 'not configured — engine runs will fail until this is set up',
              fix: auth.hint,
            },
      )
    }
  }

  // 6. Native execution substrate (ADR-0013): can a confined engine start here?
  if (loadedConfig) {
    try {
      const provider = createNativeExecutionProvider({
        config: loadedConfig.config,
        rootDir: loadedConfig.rootDir,
      })
      const probe = await provider.probe()
      await provider.close()
      checks.push({
        id: 'sandbox',
        title: 'Sandbox (native)',
        status: probe.available ? 'pass' : 'fail',
        message: probe.detail,
        ...(probe.fix !== undefined ? { fix: probe.fix } : {}),
      })
      checks.push({
        id: 'native-enforcement',
        title: 'Native enforcement',
        status: probe.backend === 'landlock' ? 'info' : 'warn',
        message:
          probe.backend === 'landlock'
            ? 'Landlock enforces filesystem access; a private mount namespace provides a session tmpfs; a network namespace enforces restricted/none. CPU/memory limits are recorded but not cgroup-enforced.'
            : 'mode unconfined: filesystem and network access are not OS-confined. Confined modes fail closed on this platform.',
      })
    } catch (e) {
      checks.push({
        id: 'sandbox',
        title: 'Sandbox (native)',
        status: 'fail',
        message: (e as Error).message,
        fix: 'fix the sandbox section of pluton.yaml (native execution; confined modes need Linux and the verified landlock-run helper)',
      })
    }
  }

// 7. Disk space
  try {
    const fs = statfsSync(root ?? opts.cwd)
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3
    checks.push(
      freeGb >= 5
        ? { id: 'disk', title: 'Disk space', status: 'pass', message: `${freeGb.toFixed(1)} GB free` }
        : {
            id: 'disk',
            title: 'Disk space',
            status: 'warn',
            message: `only ${freeGb.toFixed(1)} GB free`,
            fix: 'free disk space; runs create checkouts and session state',
          },
    )
  } catch {
    checks.push({ id: 'disk', title: 'Disk space', status: 'info', message: 'could not stat the filesystem' })
  }

  // 8. Host tmux is used only by `pluton attach`; headless execution does not need it.
  const tmux = await exec(['tmux', '-V'], { timeoutMs: 15_000 })
  checks.push(
    tmux.exitCode === 0 && firstLine(tmux.stdout) !== ''
      ? { id: 'tmux', title: 'tmux', status: 'pass', message: firstLine(tmux.stdout) }
      : {
          id: 'tmux',
          title: 'tmux',
          status: 'info',
          message: 'not installed — `pluton attach` is unavailable; headless runs do not need it',
          fix: TMUX_NOT_INSTALLED_FIX,
        },
  )

  return checks
}

function safeAdapter(kind: string): ReturnType<typeof getEngineAdapter> | null {
  try {
    return getEngineAdapter(kind)
  } catch {
    return null
  }
}

export function doctorExitCode(checks: CheckResult[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0
}

export interface DoctorReport {
  checks: CheckResult[]
  exitCode: number
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks = await collectDoctorChecks(opts)
  return { checks, exitCode: doctorExitCode(checks) }
}

export function engineHomeExists(root: string, museId: string): boolean {
  return existsSync(join(engineHomesDir(root), museId))
}
