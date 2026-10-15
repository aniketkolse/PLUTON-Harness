import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProjectRoot, loadConfig, stateDir } from '../../config/load.ts'
import { registerBuiltinEngines, listEngineKinds, getEngineAdapter } from '../../engines/registry.ts'
import { firstLine, run } from '../../util/exec.ts'
import { engineHomesDir } from '../../config/load.ts'
import type { CheckResult } from '../output.ts'

const MIN_NODE_MAJOR = 24

export interface DoctorOptions {
  cwd: string
}

export async function collectDoctorChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  registerBuiltinEngines()

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

  // 2. Platform + WSL2 (Windows)
  if (process.platform === 'win32') {
    const r = await run(['wsl', '--status'], { timeoutMs: 15_000 })
    if (r.exitCode === 0) {
      checks.push({
        id: 'wsl2',
        title: 'WSL2',
        status: 'pass',
        message: 'WSL is present (used by Docker Desktop for Linux worker containers)',
      })
    } else {
      checks.push({
        id: 'wsl2',
        title: 'WSL2',
        status: 'warn',
        message: 'WSL not detected — the supported Windows setup uses WSL2 + Docker Desktop',
        fix: 'install WSL2 (wsl --install) and Docker Desktop with the WSL2 backend',
      })
    }
  } else {
    checks.push({
      id: 'platform',
      title: 'Platform',
      status: process.platform === 'linux' ? 'pass' : 'warn',
      message: `${process.platform} (Linux is the fully supported daemon host)`,
    })
  }

  // 3. Docker CLI + daemon
  const dockerCli = await run(['docker', '--version'], { timeoutMs: 15_000 })
  if (dockerCli.exitCode === 0) {
    checks.push({ id: 'docker-cli', title: 'Docker CLI', status: 'pass', message: firstLine(dockerCli.stdout) })
    const info = await run(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 })
    if (info.exitCode === 0 && info.stdout.trim().length > 0) {
      checks.push({
        id: 'docker-daemon',
        title: 'Docker daemon',
        status: 'pass',
        message: `server ${info.stdout.trim()}`,
      })
    } else {
      checks.push({
        id: 'docker-daemon',
        title: 'Docker daemon',
        status: 'fail',
        message: 'daemon not reachable — worker containers cannot start',
        fix: 'start Docker Desktop (or the docker engine) and re-run `pluton doctor`',
      })
    }
  } else {
    checks.push({
      id: 'docker-cli',
      title: 'Docker CLI',
      status: 'fail',
      message: 'docker not found on PATH',
      fix: 'install Docker Desktop (Windows) or docker engine (Linux)',
    })
  }

  // 4. Git
  const git = await run(['git', '--version'], { timeoutMs: 15_000 })
  checks.push(
    git.exitCode === 0
      ? { id: 'git', title: 'Git', status: 'pass', message: firstLine(git.stdout) }
      : { id: 'git', title: 'Git', status: 'fail', message: 'git not found', fix: 'install Git and ensure it is on PATH' },
  )

  // 5. Project config + storage
  const root = findProjectRoot(opts.cwd)
  if (!root) {
    checks.push({
      id: 'config',
      title: 'Project config',
      status: 'info',
      message: 'no pluton.yaml found from this directory upward',
      fix: 'run `pluton init` in the project you want to orchestrate',
    })
  } else {
    try {
      const loaded = loadConfig(root)
      checks.push({
        id: 'config',
        title: 'Project config',
        status: 'pass',
        message: `${root} (project '${loaded.config.project.name}', ${Object.keys(loaded.config.muses).length} muse(s))`,
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
      // Engine checks per configured Muse
      const seen = new Set<string>()
      for (const [id, muse] of Object.entries(loaded.config.muses)) {
        const key = `${muse.engine}` // one discovery per engine kind is enough for install state
        const adapter = safeAdapter(muse.engine)
        if (!adapter) {
          checks.push({
            id: `engine:${muse.engine}`,
            title: `Engine '${muse.engine}' (muse ${id})`,
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
                  id: `engine:${muse.engine}`,
                  title: `Engine '${muse.engine}'`,
                  status: 'pass',
                  message: `${disc.version ?? 'version unknown'} ${disc.binaryPath ? `(${disc.binaryPath})` : ''}`.trim(),
                }
              : {
                  id: `engine:${muse.engine}`,
                  title: `Engine '${muse.engine}'`,
                  status: 'fail',
                  message: 'not installed / not on PATH',
                  fix: disc.fix,
                },
          )
        }
        const auth = await adapter.authStatus(home)
        checks.push(
          auth.configured
            ? { id: `auth:${id}`, title: `Auth for muse '${id}'`, status: 'pass', message: 'configured' }
            : {
                id: `auth:${id}`,
                title: `Auth for muse '${id}'`,
                status: 'warn',
                message: 'not configured — engine runs will fail until this is set up',
                fix: auth.hint,
              },
        )
      }
    } catch (e) {
      checks.push({
        id: 'config',
        title: 'Project config',
        status: 'fail',
        message: (e as Error).message,
        fix: 'fix pluton.yaml (see docs/MUSE_CONFIGURATION.md)',
      })
    }
  }

  // 6. Disk space
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
            fix: 'free disk space; runs create checkouts and container layers',
          },
    )
  } catch {
    checks.push({ id: 'disk', title: 'Disk space', status: 'info', message: 'could not stat the filesystem' })
  }

  // 7. tmux — honesty check
  checks.push({
    id: 'tmux',
    title: 'tmux',
    status: 'info',
    message:
      'provided inside the Linux worker image; native-Windows tmux is NOT part of the supported path (ADR-0010). Container-side verification happens when the worker image is provisioned.',
  })

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

export function engineHomeExists(root: string, museId: string): boolean {
  return existsSync(join(engineHomesDir(root), museId))
}
