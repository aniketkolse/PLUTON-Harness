import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QwenEngineAdapter } from '../../src/engines/qwen/adapter.ts'
import type { EngineEvent } from '../../src/engines/contract/types.ts'

/**
 * Opt-in live test against the real `qwen --acp` (Qwen Code) process.
 *
 * Run with:
 *   PLUTON_LIVE_QWEN=1 npm run test:live
 * Requirements:
 * - Qwen Code installed (`npm install -g @qwen-code/qwen-code`) or
 *   PLUTON_QWEN_BIN pointing at its cli-entry.js (PLUTON_LIVE_QWEN_BIN also
 *   works and wins).
 * - Credentials available to the engine process: either OPENAI_API_KEY /
 *   OPENAI_BASE_URL / OPENAI_MODEL (any OpenAI-compatible endpoint) or
 *   DASHSCOPE_API_KEY, or a prior `qwen` login in this temp engine home.
 * - The model must be one the endpoint offers; override with
 *   PLUTON_LIVE_QWEN_MODEL (default cbai/glm-5.2 — the display name form; the
 *   adapter sends the engine's composite value verbatim).
 * Resume coverage additionally needs PLUTON_LIVE_QWEN_RESUME=1.
 *
 * NOT part of `npm run check` — never run silently. No secrets are printed:
 * failures show the engine's message only (Pluton never logs env values).
 */

const enabled = process.env['PLUTON_LIVE_QWEN'] === '1'
const BIN = process.env['PLUTON_QWEN_BIN'] ?? process.env['PLUTON_LIVE_QWEN_BIN']
const MODEL = process.env['PLUTON_LIVE_QWEN_MODEL'] ?? 'cbai/glm-5.2'
const RUN_RESUME = process.env['PLUTON_LIVE_QWEN_RESUME'] === '1'

function makeAdapter(): QwenEngineAdapter {
  return new QwenEngineAdapter(BIN ? { binaryPath: BIN } : {})
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe.runIf(enabled)('qwen live (opt-in)', () => {
  it('discovers the installed engine and reports its real version', async () => {
    const adapter = makeAdapter()
    const discovery = await adapter.discover()
    expect(discovery.installed).toBe(true)
    expect(discovery.version).toBeTruthy()
    expect(discovery.version).toMatch(/\d+\.\d+/)
  })

  it('lists real models from a live session/new handshake', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.source === 'engine')).toBe(true)
    // The configured model must be offered — by composite value or display name.
    expect(models.some((m) => m.id === MODEL || m.label === MODEL)).toBe(true)
  })

  it('runs a full ACP session, pins mode+model, and returns the marker', async () => {
    const adapter = makeAdapter()
    const base = mkdtempSync(join(tmpdir(), 'pluton-live-qwen-'))
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
      expect(events.filter((e) => e.kind === 'error')).toEqual([])
      expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
    } finally {
      await session.close()
    }
  })

  it.runIf(RUN_RESUME)('resumes a previous native session via session/load', async () => {
    const adapter = makeAdapter()
    const base = mkdtempSync(join(tmpdir(), 'pluton-live-qwen-resume-'))
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
