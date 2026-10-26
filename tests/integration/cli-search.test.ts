import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

const CONFIG = `version: 1
project:
  name: cli-search-it
  repository: .
  default_branch: main
  verification: []
runtime:
  network_policy: open
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    acknowledge_unconfined: true
muses:
  supervisor:
    display_name: Supervisor
    role: supervisor
    workspace_policy: coordinator-read-only
    engine: mock
    model: mock/m
`

describe('CLI search', () => {
  let projectDir: string
  let sessionId: string
  let runId: string

  function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execFileSync('node', [BIN, ...args], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { stdout, stderr: '', exitCode: 0 }
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
    }
  }

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'pluton-search-it-'))
    writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)

    const session = store.createChatSession({
      projectId,
      shipId: 'supervisor',
      title: 'Search Testing Session',
    })
    sessionId = session.id

    store.appendChatMessage({
      sessionId,
      role: 'user',
      text: 'Can we investigate the database connection timeout issue?',
    })
    store.appendChatMessage({
      sessionId,
      role: 'assistant',
      text: 'Examining PostgreSQL pool logs for connection timeouts.',
    })

    const run = store.createRun({
      projectId,
      goal: 'Investigate DB timeout',
      origin: 'cli',
      requestedBy: 'operator',
      managerShipId: 'supervisor',
      acceptanceCriteria: ['diagnosed'],
      budget: {
        maxTasks: 3,
        maxConcurrentWorkers: 1,
        maxDelegationDepth: 0,
        maxRunMinutes: 10,
        defaultTaskMinutes: 5,
      },
    })
    runId = run.id

    store.appendEvent({
      projectId,
      runId,
      type: 'run.diagnostic',
      payload: { error: 'database connection timeout after 5000ms' },
    })

    store.close()
  })

  afterAll(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('displays search command help', () => {
    const res = runCli(['search', '--help'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('search')
    expect(res.stdout).toContain('--session')
    expect(res.stdout).toContain('--run')
  })

  it('searches both chat messages and events with --json', () => {
    const res = runCli(['search', 'connection timeout', '--json'])
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.query).toBe('connection timeout')
    expect(parsed.data.messages.length).toBeGreaterThanOrEqual(1)
    expect(parsed.data.events.length).toBeGreaterThanOrEqual(1)
    expect(parsed.data.messages[0].text).toContain('connection timeout')
    expect(parsed.data.events[0].runId).toBe(runId)
  })

  it('searches in human-readable format', () => {
    const res = runCli(['search', 'PostgreSQL'])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('Chat Messages')
    expect(res.stdout).toContain('PostgreSQL')
  })

  it('filters by session id', () => {
    const res = runCli(['search', 'database', '--session', sessionId, '--json'])
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.messages.length).toBeGreaterThanOrEqual(1)
    expect(parsed.data.events.length).toBe(0)
  })

  it('filters by run id', () => {
    const res = runCli(['search', 'database', '--run', runId, '--json'])
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.messages.length).toBe(0)
    expect(parsed.data.events.length).toBeGreaterThanOrEqual(1)
  })

  it('handles terms with no match', () => {
    const res = runCli(['search', 'nonexistenttermxyz999', '--json'])
    expect(res.exitCode).toBe(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.ok).toBe(true)
    expect(parsed.data.messages).toEqual([])
    expect(parsed.data.events).toEqual([])
  })
})
