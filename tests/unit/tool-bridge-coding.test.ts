import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PolicyDeniedError } from '../../src/domain/errors.ts'
import { PERMISSIONS } from '../../src/domain/permissions.ts'
import { openDatabase, type DatabaseSync } from '../../src/store/db.ts'
import { migrate } from '../../src/store/migrations.ts'
import { Store } from '../../src/store/store.ts'
import { PlutonToolBridge, type ToolBridgeLimits } from '../../src/tools/bridge.ts'

const tmpDirs: string[] = []
const openDbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {}
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const DEFAULT_LIMITS: ToolBridgeLimits = {
  maxChildrenPerTask: 10,
  maxBriefChars: 20_000,
  maxTeamSize: 10,
  maxToolResultChars: 100_000,
  defaultWaitSeconds: 10,
  waitHeartbeatSeconds: 5,
  approvalTtlMinutes: 60,
  maxRevisionsPerTask: 2,
}

function makeFixture() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-coding-tools-')))
  tmpDirs.push(dir)
  mkdirSync(join(dir, '.pluton', 'state'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const num = 42;\n')

  const db = openDatabase(join(dir, '.pluton', 'state', 'pluton.sqlite'))
  openDbs.push(db)
  migrate(db)
  const store = new Store(db)
  const project = store.ensureProject({
    name: 'coding-tools-test',
    rootPath: dir,
    configPath: join(dir, 'pluton.yaml'),
    defaultBranch: 'main',
  })

  store.syncMuses(project.id, [
    {
      id: 'coder-with-write',
      slug: 'coder-with-write',
      displayName: 'Coder With Write',
      role: 'coder',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: ['project.read', 'project.write', 'tests.run'],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/coder-write',
    },
    {
      id: 'reader-only',
      slug: 'reader-only',
      displayName: 'Reader Only',
      role: 'researcher',
      engineKind: 'mock',
      model: 'mock/model',
      instructionsFile: null,
      workspacePolicy: 'isolated-task-checkout',
      permissions: ['project.read'],
      approvalMode: 'ask-for-sensitive-actions',
      engineHome: '.pluton/engine-homes/reader',
    },
  ])

  const run = store.createRun({
    projectId: project.id,
    managerShipId: 'coder-with-write',
    goal: 'coding tools test',
    origin: 'cli',
    requestedBy: 'tester',
    acceptanceCriteria: [],
    budget: {
      maxConcurrentWorkers: 2,
      maxTasks: 20,
      maxDelegationDepth: 3,
      maxRunMinutes: 60,
      defaultTaskMinutes: 10,
    },
  })

  return { dir, store, project, run }
}

describe('Shared PLUTON coding tools in MCP bridge', () => {
  it('allows file.write to create and overwrite files within workspace', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const writeResult = await bridge.call('file.write', {
      path: 'src/new-file.ts',
      content: 'export const hello = "world";\n',
    })

    expect(writeResult.ok).toBe(true)
    expect(readFileSync(join(dir, 'src', 'new-file.ts'), 'utf8')).toBe(
      'export const hello = "world";\n',
    )
  })

  it('allows file.edit to perform targeted text replacement', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const editResult = await bridge.call('file.edit', {
      path: 'src/app.ts',
      oldText: 'num = 42',
      newText: 'num = 100',
    })

    expect(editResult.ok).toBe(true)
    const data = (editResult as { data: { replacements: number } }).data
    expect(data.replacements).toBe(1)
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('export const num = 100;\n')
  })

  it('rejects path traversal outside workspace', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const res = (await bridge.call('file.write', {
      path: '../../escape.txt',
      content: 'malicious',
    })) as { ok: boolean; error: { code: string; message: string } }

    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('policy_denied')
  })

  it('rejects writing to refused segments (.pluton, .git, node_modules)', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const res = (await bridge.call('file.write', {
      path: '.pluton/tamper.txt',
      content: 'bad',
    })) as { ok: boolean; error: { code: string; message: string } }

    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('policy_denied')
  })

  it('searches file contents with file.search', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const searchResult = await bridge.call('file.search', {
      pattern: 'num = 42',
    })

    expect(searchResult.ok).toBe(true)
    const data = (searchResult as { data: { matches: Array<{ path: string; line: number; text: string }> } }).data
    expect(data.matches.length).toBeGreaterThan(0)
    expect(data.matches[0]?.path).toMatch(/src[\\/]app\.ts/)
  })

  it('executes commands safely with command.exec', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'coder-with-write',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const execResult = await bridge.call('command.exec', {
      command: 'node -e "console.log(1+1)"',
    })

    expect(execResult.ok).toBe(true)
    const data = (execResult as { data: { exitCode: number; stdout: string; ok: boolean } }).data
    expect(data.ok).toBe(true)
    expect(data.exitCode).toBe(0)
    expect(data.stdout.trim()).toBe('2')
  })

  it('blocks file.write when caller lacks project.write permission', async () => {
    const { dir, store, project, run } = makeFixture()
    const bridge = new PlutonToolBridge({
      store,
      projectId: project.id,
      rootDir: dir,
      runId: run.id,
      callerShipId: 'reader-only',
      readRoots: [dir],
      limits: DEFAULT_LIMITS,
    })

    const res = (await bridge.call('file.write', {
      path: 'src/forbidden.ts',
      content: 'should fail',
    })) as { ok: boolean; error: { code: string; message: string } }

    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('policy_denied')
  })
})
