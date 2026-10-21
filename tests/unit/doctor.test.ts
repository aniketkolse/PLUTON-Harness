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

function makeTempProject(sandboxYaml: string): string {
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
  it('reports docker-cli as info and not fail when docker is missing and sandbox is native', async () => {
    const root = makeTempProject(`sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
`)
    const runFn = mockRun({
      'docker --version': { exitCode: 1, stderr: 'command not found: docker' },
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'wsl --status': { exitCode: 1, stderr: 'wsl: not found' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const dockerCli = checks.find((c) => c.id === 'docker-cli')
    expect(dockerCli).toBeDefined()
    expect(dockerCli?.status).toBe('info')
    expect(dockerCli?.message).toContain('not installed — optional (not required for native host execution)')

    const dockerDaemon = checks.find((c) => c.id === 'docker-daemon')
    expect(dockerDaemon).toBeUndefined()

    // Sandbox native probe should pass
    const sandboxCheck = checks.find((c) => c.id === 'sandbox')
    expect(sandboxCheck).toBeDefined()
    expect(sandboxCheck?.status).toBe('pass')

    // On Windows or when WSL fails in native mode, WSL should be info not warn
    const wslCheck = checks.find((c) => c.id === 'wsl2')
    if (wslCheck) {
      expect(wslCheck.status).toBe('info')
    }

    expect(doctorExitCode(checks)).toBe(0)
  })

  it('reports docker-daemon as info when docker cli is present but daemon is down and sandbox is native', async () => {
    const root = makeTempProject(`sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
`)
    const runFn = mockRun({
      'docker --version': { exitCode: 0, stdout: 'Docker version 27.0.0' },
      'docker info': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' },
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'wsl --status': { exitCode: 0, stdout: 'WSL is operational' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const dockerCli = checks.find((c) => c.id === 'docker-cli')
    expect(dockerCli).toBeDefined()
    expect(['pass', 'info']).toContain(dockerCli?.status)

    const dockerDaemon = checks.find((c) => c.id === 'docker-daemon')
    expect(dockerDaemon).toBeDefined()
    expect(dockerDaemon?.status).toBe('info')
    expect(dockerDaemon?.message).toContain('daemon not running — optional (not required for native host execution)')

    expect(doctorExitCode(checks)).toBe(0)
  })

  it('reports fail when docker is missing and sandbox is docker', async () => {
    const root = makeTempProject(`sandbox:
  kind: docker
`)
    const runFn = mockRun({
      'docker --version': { exitCode: 1, stderr: 'command not found: docker' },
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'wsl --status': { exitCode: 1, stderr: 'wsl: not found' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const dockerCli = checks.find((c) => c.id === 'docker-cli')
    expect(dockerCli).toBeDefined()
    expect(dockerCli?.status).toBe('fail')

    expect(doctorExitCode(checks)).toBe(1)
  })

  it('reports fail when docker daemon is unreachable and sandbox is docker', async () => {
    const root = makeTempProject(`sandbox:
  kind: docker
`)
    const runFn = mockRun({
      'docker --version': { exitCode: 0, stdout: 'Docker version 27.0.0' },
      'docker info': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon' },
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'wsl --status': { exitCode: 0, stdout: 'WSL is operational' },
    })

    const checks = await collectDoctorChecks({ cwd: root, runFn })
    const dockerDaemon = checks.find((c) => c.id === 'docker-daemon')
    expect(dockerDaemon).toBeDefined()
    expect(dockerDaemon?.status).toBe('fail')

    expect(doctorExitCode(checks)).toBe(1)
  })

  it('reports docker-cli as info and optional when no pluton.yaml is present', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'pluton-doctor-empty-'))
    tmpDirs.push(emptyDir)

    const runFn = mockRun({
      'docker --version': { exitCode: 1, stderr: 'command not found: docker' },
      'git --version': { exitCode: 0, stdout: 'git version 2.40.0' },
      'wsl --status': { exitCode: 1, stderr: 'wsl: not found' },
    })

    const checks = await collectDoctorChecks({ cwd: emptyDir, runFn, findProjectRoot: () => null })
    const configCheck = checks.find((c) => c.id === 'config')
    expect(configCheck).toBeDefined()
    expect(configCheck?.status).toBe('info')
    expect(configCheck?.message).toContain('no pluton.yaml found')

    const dockerCli = checks.find((c) => c.id === 'docker-cli')
    expect(dockerCli).toBeDefined()
    expect(dockerCli?.status).toBe('info')
    expect(dockerCli?.message).toContain('not installed — optional (not required for native host execution)')

    const wslCheck = checks.find((c) => c.id === 'wsl2')
    if (wslCheck) {
      expect(wslCheck.status).toBe('info')
    }

    expect(doctorExitCode(checks)).toBe(0)
  })
})
