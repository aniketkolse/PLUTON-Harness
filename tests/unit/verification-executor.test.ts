import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import type { RunBudget } from '../../src/domain/models.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import {
  buildVerificationEnvironment,
  createVerificationExecutor,
  createVerificationSnapshot,
  VerificationIsolationUnavailableError,
  type VerificationExecutionRequest,
} from '../../src/verify/executor.ts'
import { runVerificationChecks } from '../../src/verify/runner.ts'

const dirs: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Pluton',
      GIT_AUTHOR_EMAIL: 'pluton@localhost',
      GIT_COMMITTER_NAME: 'Pluton',
      GIT_COMMITTER_EMAIL: 'pluton@localhost',
    },
  })
}

function seedRepo(): string {
  const dir = tmp('pluton-verify-exec-')
  git(dir, ['init', '-b', 'main'])
  writeFileSync(join(dir, 'app.txt'), 'seed\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.name=Pluton', '-c', 'user.email=pluton@localhost', 'commit', '-m', 'seed'])
  return dir
}

const BUDGET: RunBudget = {
  maxConcurrentWorkers: 1,
  maxTasks: 4,
  maxDelegationDepth: 1,
  maxRunMinutes: 10,
  defaultTaskMinutes: 5,
}

function fixture(cwd: string): { store: Store; projectId: string; runId: string; taskId: string } {
  const db = openDatabase(join(tmp('pluton-verify-exec-db-'), 'pluton.sqlite'))
  dbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'verify-executor',
    rootPath: cwd,
    configPath: join(cwd, 'pluton.yaml'),
    defaultBranch: 'main',
  })
  store.syncMuses(project.id, [
    {
      id: 'worker',
      slug: 'worker',
      displayName: 'Worker',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: [],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/worker',
    },
  ])
  const run = store.createRun({
    projectId: project.id,
    goal: 'verify safely',
    origin: 'cli',
    requestedBy: 'test',
    acceptanceCriteria: [],
    managerMuseId: 'worker',
    budget: BUDGET,
  })
  const task = store.createTask({
    runId: run.id,
    title: 'verify task',
    brief: 'do work',
    acceptanceCriteria: [],
    assigneeMuseId: 'worker',
  })
  store.setTaskState(task.id, 'queued')
  store.setTaskState(task.id, 'admitted')
  store.setTaskState(task.id, 'running')
  store.setTaskState(task.id, 'verifying')
  return { store, projectId: project.id, runId: run.id, taskId: task.id }
}

function request(cwd: string, command: string[]): VerificationExecutionRequest {
  return {
    command,
    cwd,
    env: {},
    timeoutMs: 10_000,
    maxOutputBytes: 10_000,
    network: 'none',
    workspaceRoot: cwd,
  }
}

describe('dedicated verification executor', () => {
  it('fails closed before spawning anything when OS confinement is unavailable', async () => {
    const repo = seedRepo()
    const marker = join(repo, 'must-not-exist.txt')
    const executor = createVerificationExecutor({ platform: 'win32' })
    await expect(
      executor.run(
        request(repo, [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'host execution')`,
        ]),
      ),
    ).rejects.toBeInstanceOf(VerificationIsolationUnavailableError)
    expect(existsSync(marker)).toBe(false)
  })

  it('builds an explicit minimal environment without host credentials or workspace paths', () => {
    const snapshot = tmp('pluton-verify-env-')
    const env = buildVerificationEnvironment(snapshot, {
      PATH: '/usr/bin:/bin',
      HOME: '/home/operator',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      OPENCODE_CONFIG: '/home/operator/.config/opencode',
      PLUTON_STATE_DIR: '/home/operator/.pluton',
      LANG: 'en_US.UTF-8',
    })
    expect(env['PATH']).toBe('/usr/bin:/bin')
    expect(env['HOME']).toBe(join(snapshot, 'home'))
    expect(env['TMPDIR']).toBe(join(snapshot, 'tmp'))
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(env['SSH_AUTH_SOCK']).toBeUndefined()
    expect(env['OPENCODE_CONFIG']).toBeUndefined()
    expect(env['PLUTON_STATE_DIR']).toBeUndefined()
  })

  it('runs checks in a disposable snapshot and records the executor identity', async () => {
    const repo = seedRepo()
    const { store, projectId, runId, taskId } = fixture(repo)
    let observed: VerificationExecutionRequest | null = null
    const executor = {
      id: 'test-executor',
      async run(req: VerificationExecutionRequest) {
        observed = req
        writeFileSync(join(req.cwd, 'check-output.txt'), 'inside snapshot\n')
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          truncated: false,
          executor: 'test-executor',
        }
      },
    }

    const report = await runVerificationChecks({
      store,
      projectId,
      runId,
      taskId,
      checks: [{ name: 'snapshot', command: [process.execPath, '-e', 'process.exit(0)'] }],
      cwd: repo,
      workspaceId: null,
      artifactsDir: tmp('pluton-verify-artifacts-'),
      executor,
    })

    expect(report.allPassed).toBe(true)
    expect(report.results[0]?.executor).toBe('test-executor')
    expect(observed).not.toBeNull()
    expect((observed as VerificationExecutionRequest | null)?.cwd).not.toBe(repo)
    expect((observed as VerificationExecutionRequest | null)?.env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
    expect(existsSync(join(repo, 'check-output.txt'))).toBe(false)
    expect(report.evidence.worktreeFingerprint).toBe(report.evidence.postWorktreeFingerprint)
  })

  it('records an isolation refusal as a failed check instead of executing it on the host', async () => {
    const repo = seedRepo()
    const marker = join(repo, 'host-executed.txt')
    const { store, projectId, runId, taskId } = fixture(repo)
    const executor = createVerificationExecutor({ platform: 'win32' })

    const report = await runVerificationChecks({
      store,
      projectId,
      runId,
      taskId,
      checks: [
        {
          name: 'must-not-run',
          command: [
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'host execution')`,
          ],
        },
      ],
      cwd: repo,
      workspaceId: null,
      artifactsDir: tmp('pluton-verify-artifacts-'),
      executor,
    })

    expect(report.allPassed).toBe(false)
    expect(report.results[0]?.status).toBe('failed')
    expect(report.results[0]?.note).toMatch(/isolation/i)
    expect(existsSync(marker)).toBe(false)
  })

  it.runIf(
    process.platform === 'linux' && createVerificationExecutor().availability?.available === true,
  )('runs a real check inside a snapshot created under the system temp directory', async () => {
    const repo = seedRepo()
    const snapshot = createVerificationSnapshot(repo)
    try {
      const executor = createVerificationExecutor()
      const result = await executor.run({
        command: [
          process.execPath,
          '-e',
          "require('node:fs').writeFileSync('snapshot-ran.txt', 'yes')",
        ],
        cwd: snapshot,
        workspaceRoot: snapshot,
        env: {},
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        network: 'none',
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(snapshot, 'snapshot-ran.txt'))).toBe(true)
    } finally {
      rmSync(snapshot, { recursive: true, force: true })
    }
  })

  it.runIf(
    process.platform === 'linux' && createVerificationExecutor().availability?.available === true,
  )('denies host AF_UNIX sockets even when the network policy is none', async () => {
    const repo = seedRepo()
    const snapshot = createVerificationSnapshot(repo)
    const socketPath = join(tmpdir(), `pluton-verify-unix-${process.pid}-${Date.now()}.sock`)
    const server = createServer((socket) => socket.end('HOST_IPC_REACHED'))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      const executor = createVerificationExecutor()
      const result = await executor.run({
        command: [
          process.execPath,
          '-e',
          [
            "const net = require('node:net')",
            `const socket = net.connect(${JSON.stringify(socketPath)})`,
            "socket.on('connect', () => { console.log('CONNECTED'); socket.destroy() })",
            "socket.on('error', (error) => { console.log('DENIED:' + error.code); process.exit(0) })",
          ].join(';'),
        ],
        cwd: snapshot,
        workspaceRoot: snapshot,
        env: {},
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        network: 'none',
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('DENIED:EPERM')
      expect(result.stdout).not.toContain('CONNECTED')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(socketPath, { force: true })
      rmSync(snapshot, { recursive: true, force: true })
    }
  })
})
