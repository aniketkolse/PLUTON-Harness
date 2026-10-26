import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDoctorChecks, doctorExitCode } from '../../src/cli/commands/doctor.ts'
import type { RunOptions, RunResult } from '../../src/util/exec.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempProject(sandboxYaml = `sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode_by_platform:
      darwin: unconfined
      win32: unconfined
    acknowledge_unconfined: true
`): string {
  const root = mkdtempSync(join(tmpdir(), 'pluton-doctor-test-'))
  tmpDirs.push(root)
  mkdirSync(join(root, '.pluton', 'workspaces'), { recursive: true })
  mkdirSync(join(root, '.pluton', 'engine-homes'), { recursive: true })
  const content = `version: 1
project:
  name: doctor-demo
  repository: .
  default_branch: main
  verification: []
runtime:
  network_policy: open
${sandboxYaml}
muses: {}
`
  writeFileSync(join(root, 'pluton.yaml'), content, 'utf8')
  return root
}

function mockRun(
  routes: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
): (argv: string[], options?: RunOptions) => Promise<RunResult> {
  return async (argv: string[]) => {
    const key = argv.slice(0, 2).join(' ')
    const fallbackKey = argv[0] ?? ''
    const match = routes[key] ?? routes[fallbackKey]
    if (match) {
      return {
        argv,
        exitCode: match.exitCode,
        timedOut: false,
        stdout: match.stdout ?? '',
        stderr: match.stderr ?? '',
        truncated: false,
        durationMs: 5,
      }
    }
    return {
      argv,
      exitCode: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 5,
    }
  }
}

describe('doctor diagnostics', () => {
  it('probes native substrate and never probes Docker CLI or daemon', async () => {
    const root = makeTempProject()
    const calls: string[][] = []
    const routes = mockRun({
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'tmux -V': { exitCode: 0, stdout: 'tmux 3.4' },
    })
    const runFn: typeof routes = async (argv, options) => {
      calls.push(argv)
      return routes(argv, options)
    }

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    expect(calls.some((argv) => argv[0] === 'docker')).toBe(false)
    expect(checks.find((c) => c.id === 'docker-cli')).toBeUndefined()
    expect(checks.find((c) => c.id === 'docker-daemon')).toBeUndefined()

    // Sandbox native probe should be present
    const sandboxCheck = checks.find((c) => c.id === 'sandbox')
    expect(sandboxCheck).toBeDefined()
    expect(sandboxCheck?.status).toBe('pass')

    // Native enforcement check should be present
    const enforcementCheck = checks.find((c) => c.id === 'native-enforcement')
    expect(enforcementCheck).toBeDefined()

    // Platform check
    const platformCheck = checks.find((c) => c.id === 'platform')
    expect(platformCheck).toBeDefined()

    // Git check
    const gitCheck = checks.find((c) => c.id === 'git')
    expect(gitCheck?.status).toBe('pass')

    // Tmux check
    const tmuxCheck = checks.find((c) => c.id === 'tmux')
    expect(tmuxCheck?.status).toBe('pass')
  })

  it('reports config failure and does not call Docker when pluton.yaml is invalid', async () => {
    const root = makeTempProject()
    writeFileSync(join(root, 'pluton.yaml'), 'version: 1\nproject: invalid\n', 'utf8')
    const calls: string[][] = []
    const routes = mockRun({
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'tmux -V': { exitCode: 0, stdout: 'tmux 3.4' },
    })
    const runFn: typeof routes = async (argv, options) => {
      calls.push(argv)
      return routes(argv, options)
    }

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    expect(calls.some((argv) => argv[0] === 'docker')).toBe(false)
    const configCheck = checks.find((c) => c.id === 'config')
    expect(configCheck?.status).toBe('fail')
  })

  it('reports failure when legacy docker sandbox is configured', async () => {
    const root = makeTempProject(`sandbox:
  kind: docker
`)
    const runFn = mockRun({
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'tmux -V': { exitCode: 0, stdout: 'tmux 3.4' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const sandboxCheck = checks.find((c) => c.id === 'sandbox')
    expect(sandboxCheck).toBeDefined()
    expect(sandboxCheck?.status).toBe('fail')
    expect(sandboxCheck?.message).toContain('docker')
    expect(doctorExitCode(checks)).toBe(1)
  })

  it('reports info when no pluton.yaml is present', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'pluton-doctor-empty-'))
    tmpDirs.push(emptyDir)

    const runFn = mockRun({
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'tmux -V': { exitCode: 0, stdout: 'tmux 3.4' },
    })

    const checks = await collectDoctorChecks({ cwd: emptyDir, runFn, findProjectRoot: () => null })
    const configCheck = checks.find((c) => c.id === 'config')
    expect(configCheck).toBeDefined()
    expect(configCheck?.status).toBe('info')
    expect(configCheck?.message).toContain('no pluton.yaml found')
  })

  it('reports info when tmux is missing (optional for attach)', async () => {
    const root = makeTempProject()
    const runFn = mockRun({
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'tmux -V': { exitCode: 1, stderr: 'tmux: command not found' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const tmuxCheck = checks.find((c) => c.id === 'tmux')
    expect(tmuxCheck).toBeDefined()
    expect(tmuxCheck?.status).toBe('info')
    expect(tmuxCheck?.message).toContain('not installed')
  })
})
