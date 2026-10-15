import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OpenCodeEngineAdapter } from '../../src/engines/opencode/adapter.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'

/**
 * Opt-in live test against the real `opencode` binary and a free model.
 * Run with:  npm run test:live
 * (requires `opencode` on PATH or PLUTON_OPENCODE_BIN; no login needed for
 * opencode/* free models). NOT part of `npm run check` — never run silently.
 */

const enabled = process.env['PLUTON_LIVE_OPENCODE'] === '1'
const MODEL = process.env['PLUTON_LIVE_OPENCODE_MODEL'] ?? 'opencode/deepseek-v4.1-flash-free'
const RUN_RESUME = process.env['PLUTON_LIVE_OPENCODE_RESUME'] === '1'

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe.runIf(enabled)('opencode live (opt-in)', () => {
  it('discovers the installed engine and lists real models', async () => {
    const adapter = new OpenCodeEngineAdapter()
    const discovery = await adapter.discover()
    expect(discovery.installed).toBe(true)
    expect(discovery.version).toMatch(/opencode/i)
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((m) => m.id)).toContain(MODEL)
  })

  it('runs a full ACP session against the free model and returns the marker', async () => {
    const adapter = new OpenCodeEngineAdapter()
    const base = mkdtempSync(join(tmpdir(), 'pluton-live-open-'))
    const session = await adapter.startSession({
      muse: { id: 'muse_live', slug: 'live', role: 'probe', model: MODEL },
      workdir: base,
      env: {},
      configDir: join(base, 'engine-home'),
    })
    try {
      const events = await collect(
        session.sendPrompt({ text: 'Reply with exactly PLUTON_LIVE_OK and nothing else.', timeoutMs: 180_000 }),
      )
      const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
      expect(text).toContain('PLUTON_LIVE_OK')
      expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
    } finally {
      await session.close()
    }
  })

  it.runIf(RUN_RESUME)('resumes a previous native session via session/load', async () => {
    const adapter = new OpenCodeEngineAdapter()
    const base = mkdtempSync(join(tmpdir(), 'pluton-live-resume-'))
    const request = {
      muse: { id: 'muse_live', slug: 'live', role: 'probe', model: MODEL },
      workdir: base,
      env: {},
      configDir: join(base, 'engine-home'),
    }
    const first = await adapter.startSession(request)
    const token = first.info.resumeToken
    expect(token).toBeTruthy()
    await collect(first.sendPrompt({ text: 'Remember the codeword BANANA. Reply OK.', timeoutMs: 180_000 }))
    await first.close()

    const resumed = await adapter.startSession({ ...request, resumeToken: token ?? undefined })
    try {
      const events = await collect(
        resumed.sendPrompt({ text: 'What was the codeword? Reply with just the word.', timeoutMs: 180_000 }),
      )
      const text = events.filter((e) => e.kind === 'text').map((e) => e.text).join('')
      expect(text.toUpperCase()).toContain('BANANA')
    } finally {
      await resumed.close()
    }
  })
})
