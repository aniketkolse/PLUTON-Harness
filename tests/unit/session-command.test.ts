import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { ValidationError } from '../../src/domain/errors.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { exportRun, exportSession, importRun, importSession } from '../../src/cli/commands/session.ts'

const CONFIG = `version: 1
project:
  name: session-command-unit
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

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): ProjectContext {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-session-command-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), CONFIG, 'utf8')
  const loaded = loadConfig(dir)
  return { rootDir: loaded.rootDir, configPath: loaded.configPath, loaded }
}

function seedSession(ctx: ProjectContext): string {
  const { store, projectId } = bootstrapStore(ctx.loaded)
  try {
    const session = store.createChatSession({ projectId, shipId: 'supervisor', title: 'Unit export' })
    store.appendChatMessage({ sessionId: session.id, role: 'user', text: 'hello' })
    store.appendChatMessage({ sessionId: session.id, role: 'assistant', text: 'world' })
    return session.id
  } finally {
    store.close()
  }
}

describe('session CLI command helpers', () => {
  it('exports a session to JSONL with and without an output file', () => {
    const ctx = project()
    const sessionId = seedSession(ctx)

    const inline = exportSession(ctx, sessionId)
    expect(inline.sessionId).toBe(sessionId)
    expect(inline.path).toBeUndefined()
    expect(inline.jsonl).toContain('"type":"session"')
    expect(inline.jsonl).toContain('Unit export')

    const out = join(ctx.rootDir, 'session.jsonl')
    const written = exportSession(ctx, sessionId, { out })
    expect(written.path).toBe(out)
    expect(readFileSync(out, 'utf8')).toBe(written.jsonl)
  })

  it('imports a session into a fresh project', () => {
    const source = project()
    const sessionId = seedSession(source)
    const file = join(source.rootDir, 'session.jsonl')
    exportSession(source, sessionId, { out: file })

    const target = project()
    const result = importSession(target, file)
    expect(result.messageCount).toBe(2)
    expect(result.sessionId).toBe(sessionId)

    const { store } = bootstrapStore(target.loaded)
    try {
      const messages = store.listChatMessages(result.sessionId, { limit: 10 })
      expect(messages).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('rejects empty session and run identifiers before touching the store', () => {
    const ctx = project()
    expect(() => exportSession(ctx, '')).toThrow(ValidationError)
    expect(() => exportRun(ctx, '')).toThrow(ValidationError)
    expect(() => importSession(ctx, '')).toThrow(ValidationError)
    expect(() => importRun(ctx, '')).toThrow(ValidationError)
  })

  it('writes run exports when given an output path and reports missing files', () => {
    expect(existsSync(join(project().rootDir, 'missing.jsonl'))).toBe(false)
    const ctx = project()
    const missing = join(ctx.rootDir, 'does-not-exist.jsonl')
    expect(() => importSession(ctx, missing)).toThrow()
    expect(() => importRun(ctx, missing)).toThrow()
  })
})
