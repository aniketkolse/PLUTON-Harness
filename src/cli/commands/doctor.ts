import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProjectRoot, loadConfig, stateDir, type LoadedConfig } from '../../config/load.ts'
import { registerBuiltinEngines, listEngineKinds, getEngineAdapter, type EngineCreateOptions } from '../../engines/registry.ts'
import { firstLine, run } from '../../util/exec.ts'
import { engineHomesDir } from '../../config/load.ts'
import { createNativeExecutionProvider } from '../../execution/factory.ts'
import { TMUX_NOT_INSTALLED_FIX } from '../../terminal/native.ts'
import { SCHEMA_VERSION } from '../../store/migrations.ts'
import { inspectDatabase } from '../../store/backup.ts'
import type { CheckResult } from '../output.ts'

const MIN_NODE_MAJOR = 24

export interface DoctorOptions {
  cwd: string
  runFn?: typeof run
  findProjectRoot?: typeof findProjectRoot
  /** Guided first-run mode: provides remediation hints for every failing check. */
  init?: boolean
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

    // 6a. Database accessibility + migration status (read-only; never creates or mutates)
    try {
      const dbPath = join(stateDir(root), 'pluton.sqlite')
      if (!existsSync(dbPath)) {
        checks.push({
          id: 'database',
          title: 'Database',
          status: 'info',
          message: 'not yet initialized — will be created on first run',
          fix: 'run `pluton run` (or any command that touches the store) to initialize the database',
        })
      } else {
        const inspected = inspectDatabase(dbPath)
        const currentVersion = inspected.schemaVersion
        const expected = SCHEMA_VERSION
        if (currentVersion > expected) {
          checks.push({
            id: 'database',
            title: 'Database schema',
            status: 'fail',
            message: `schema v${currentVersion} is newer than this build supports (v${expected}) — upgrade Pluton-Harness`,
            fix: 'upgrade pluton-harness to a version that supports this schema',
          })
        } else if (currentVersion < expected) {
          const pending = expected - currentVersion
          checks.push({
            id: 'database',
            title: 'Database schema',
            status: 'warn',
            message: `schema v${currentVersion}, ${pending} migration(s) pending to v${expected}`,
            fix: 'run `pluton run` (or any command that touches the store) to apply pending migrations',
          })
        } else {
          checks.push({
            id: 'database',
            title: 'Database schema',
            status: 'pass',
            message: `schema v${currentVersion} (integrity: ${inspected.integrity})`,
          })
        }
      }
    } catch (e) {
      checks.push({
        id: 'database',
        title: 'Database',
        status: 'fail',
        message: `cannot inspect SQLite database: ${(e as Error).message}`,
        fix: 'fix directory permissions on .pluton/state',
      })
    }
    // Engine checks per configured Ship
    const seen = new Set<string>()
    for (const [id, ship] of Object.entries(ships)) {
      const providerKey = ship.provider ?? ''
      const key = `${ship.engine}:${providerKey}`
      const adapter = safeAdapter(ship.engine, { rootDir: root, providerId: ship.provider })
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
        try {
          const disc = await adapter.discover()
          checks.push(
            disc.installed
              ? {
                  id: `engine:${ship.engine}${providerKey ? `:${providerKey}` : ''}`,
                  title: `Engine '${ship.engine}'${providerKey ? ` (provider: ${providerKey})` : ''}`,
                  status: 'pass',
                  message: `${disc.version ?? 'version unknown'} ${disc.binaryPath ? `(${disc.binaryPath})` : ''}`.trim(),
                }
              : {
                  id: `engine:${ship.engine}${providerKey ? `:${providerKey}` : ''}`,
                  title: `Engine '${ship.engine}'${providerKey ? ` (provider: ${providerKey})` : ''}`,
                  status: 'fail',
                  message: 'not installed / not on PATH',
                  fix: disc.fix,
                },
          )
        } catch (e) {
          checks.push({
            id: `engine:${ship.engine}${providerKey ? `:${providerKey}` : ''}`,
            title: `Engine '${ship.engine}'${providerKey ? ` (provider: ${providerKey})` : ''}`,
            status: 'fail',
            message: (e as Error).message,
          })
          continue
        }
      }
      try {
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
      } catch (e) {
        checks.push({
          id: `auth:${id}`,
          title: `Auth for ship '${id}'`,
          status: 'fail',
          message: (e as Error).message,
        })
      }
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

/**
 * Guided first-run remediation for `pluton doctor --init`.
 *
 * Produces human-readable, actionable remediation steps for every check that
 * is not `pass`. Never overwrites existing configuration; never exposes
 * secrets. Returns the ordered list of remediation steps.
 */
export function renderDoctorInit(checks: CheckResult[]): string {
  const steps: string[] = []
  let stepNo = 0

  for (const c of checks) {
    if (c.status === 'pass') continue
    stepNo += 1

    const label = `${stepNo}. ${c.title}`
    const lines: string[] = [label]

    if (c.status === 'fail') {
      lines.push(`   PROBLEM: ${c.message}`)
      if (c.fix) lines.push(`   FIX: ${c.fix}`)
    } else if (c.status === 'warn') {
      lines.push(`   NOTICE: ${c.message}`)
      if (c.fix) lines.push(`   GUIDANCE: ${c.fix}`)
    } else if (c.status === 'info') {
      lines.push(`   INFO: ${c.message}`)
      if (c.fix) lines.push(`   NEXT: ${c.fix}`)
    }

    steps.push(lines.join('\n'))
  }

  // Add a final summary and next steps
  const failCount = checks.filter((c) => c.status === 'fail').length
  const warnCount = checks.filter((c) => c.status === 'warn').length
  const infoCount = checks.filter((c) => c.status === 'info').length

  steps.push('')
  steps.push('Next steps:')
  if (failCount > 0) {
    steps.push(`  - Resolve the ${failCount} failure(s) above before running Pluton.`)
  }
  if (!checks.some((c) => c.id === 'config' && c.status === 'pass')) {
    steps.push(`  - Run \`pluton init\` to create pluton.yaml and private runtime directories.`)
  }
  if (warnCount > 0 || infoCount > 0) {
    steps.push(`  - Review the ${warnCount} warning(s) and ${infoCount} info item(s); they do not block startup.`)
  }
  steps.push(`  - Re-run \`pluton doctor\` to confirm all checks pass.`)

  return steps.join('\n')
}

function safeAdapter(kind: string, opts?: EngineCreateOptions): ReturnType<typeof getEngineAdapter> | null {
  try {
    return getEngineAdapter(kind, opts)
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
