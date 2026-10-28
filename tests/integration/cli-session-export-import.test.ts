import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

const CONFIG = `version: 1
project:
  name: cli-session-export-it
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

describe('CLI session export/import', () => {
  let projectDir: string
  let sessionId: string
  let exportFile: string
  const tempDirs: string[] = []

  function runCli(
    args: string[],
    cwd = projectDir,
  ): { stdout: string; stderr: string; exitCode: number } {
    try {
      const stdout = execFileSync('node', [BIN, ...args], {
        cwd,
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
    projectDir = mkdtempSync(join(tmpdir(), 'pluton-session-export-it-'))
    tempDirs.push(projectDir)
    writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

    const loaded = loadConfig(projectDir)
    const { store, projectId } = bootstrapStore(loaded)

    const session = store.createChatSession({
      projectId,
      shipId: 'supervisor',
      title: 'CLI Export Session Test',
    })
    sessionId = session.id

    store.appendChatMessage({
      sessionId,
      role: 'user',
      text: 'What needs refactoring?',
    })
    store.appendChatMessage({
      sessionId,
      role: 'assistant',
      text: 'Session and run export/import.',
    })
    store.close()

    exportFile = join(projectDir, 'exported-session.jsonl')
    const prepared = runCli(['session', 'export', sessionId, '-o', exportFile, '--json'])
    if (prepared.exitCode !== 0) {
      throw new Error(`failed to prepare session export: ${prepared.stderr || prepared.stdout}`)
    }
  })

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  it('exports a session and imports it into a fresh project', () => {
    const exportRes = runCli(['session', 'export', sessionId, '--json'])
    expect(exportRes.exitCode).toBe(0)
    const exportEnvelope = JSON.parse(exportRes.stdout)
    expect(exportEnvelope.ok).toBe(true)
    expect(exportEnvelope.data.sessionId).toBe(sessionId)
    expect(exportEnvelope.data.jsonl).toContain('CLI Export Session Test')

    const outFile = exportFile
    const fileExportRes = runCli(['session', 'export', sessionId, '-o', outFile, '--json'])
    expect(fileExportRes.exitCode).toBe(0)
    const fileEnvelope = JSON.parse(fileExportRes.stdout)
    expect(fileEnvelope.ok).toBe(true)
    expect(fileEnvelope.data.path).toBe(outFile)

    // A fresh project is the only safe destination: importing into the source
    // database would overwrite the session id, so the store refuses it.
    const freshDir = mkdtempSync(join(tmpdir(), 'pluton-session-import-it-'))
    tempDirs.push(freshDir)
    writeFileSync(join(freshDir, 'pluton.yaml'), CONFIG)

    const importRes = runCli(['session', 'import', outFile, '--json'], freshDir)
    expect(importRes.exitCode).toBe(0)
    const importEnvelope = JSON.parse(importRes.stdout)
    expect(importEnvelope.ok).toBe(true)
    expect(importEnvelope.data.sessionId).toBe(sessionId)
    expect(importEnvelope.data.messageCount).toBe(2)
  })

  it('refuses to re-import into the same database without changing it', () => {
    const importRes = runCli(['session', 'import', exportFile, '--json'])
    expect(importRes.exitCode).not.toBe(0)
    expect(importRes.stderr + importRes.stdout).toContain('would overwrite existing session')

    const loaded = loadConfig(projectDir)
    const { store } = bootstrapStore(loaded)
    try {
      expect(store.listChatMessages(sessionId)).toHaveLength(2)
      expect(store.getChatSession(sessionId).title).toBe('CLI Export Session Test')
    } finally {
      store.close()
    }
  })

  it('requires --workspace-root when the exported workspace path is foreign', () => {
    const lines = readFileSync(exportFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, any>)
    const foreign = structuredClone(lines)
    foreign[1]!.data.workspaceRoot = join(projectDir, 'workspace-that-does-not-exist')
    const foreignFile = join(projectDir, 'foreign-session.jsonl')
    writeFileSync(foreignFile, foreign.map((line) => JSON.stringify(line)).join('\n') + '\n')

    const freshDir = mkdtempSync(join(tmpdir(), 'pluton-session-ws-it-'))
    tempDirs.push(freshDir)
    writeFileSync(join(freshDir, 'pluton.yaml'), CONFIG)

    const refused = runCli(['session', 'import', foreignFile, '--json'], freshDir)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr + refused.stdout).toContain('cannot be used on this host')

    const localRoot = mkdtempSync(join(tmpdir(), 'pluton-session-local-ws-'))
    tempDirs.push(localRoot)
    const accepted = runCli(
      ['session', 'import', foreignFile, '--workspace-root', localRoot, '--json'],
      freshDir,
    )
    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout).ok).toBe(true)

    const loaded = loadConfig(freshDir)
    const { store } = bootstrapStore(loaded)
    try {
      expect(store.getChatSession(sessionId).workspaceRoot).toBe(realpathSync.native(localRoot))
    } finally {
      store.close()
    }
  })
})
