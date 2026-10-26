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
    projectDir = mkdtempSync(join(tmpdir(), 'pluton-session-export-it-'))
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
  })

  afterAll(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch {}
  })

  it('exports session to stdout or file and re-imports successfully', () => {
    const exportRes = runCli(['session', 'export', sessionId, '--json'])
    expect(exportRes.exitCode).toBe(0)
    const exportEnvelope = JSON.parse(exportRes.stdout)
    expect(exportEnvelope.ok).toBe(true)
    expect(exportEnvelope.data.sessionId).toBe(sessionId)
    expect(exportEnvelope.data.jsonl).toContain('CLI Export Session Test')

    const outFile = join(projectDir, 'exported-session.jsonl')
    const fileExportRes = runCli(['session', 'export', sessionId, '-o', outFile, '--json'])
    expect(fileExportRes.exitCode).toBe(0)
    const fileEnvelope = JSON.parse(fileExportRes.stdout)
    expect(fileEnvelope.ok).toBe(true)
    expect(fileEnvelope.data.path).toBe(outFile)

    // Re-import from the exported file
    const importRes = runCli(['session', 'import', outFile, '--json'])
    expect(importRes.exitCode).toBe(0)
    const importEnvelope = JSON.parse(importRes.stdout)
    expect(importEnvelope.ok).toBe(true)
    expect(importEnvelope.data.sessionId).toBe(sessionId)
    expect(importEnvelope.data.messageCount).toBe(2)
  })
})
