import { describe, expect, it, vi } from 'vitest'
import {
  parseSlash,
  executeSlash,
  getCommandSuggestions,
  getUnknownCommandSuggestions,
  type SlashContext,
} from '../../src/chat/commands.ts'

describe('parseSlash', () => {
  it('parses commands with and without arguments', () => {
    expect(parseSlash('/help')).toEqual({ command: 'help', args: '' })
    expect(parseSlash('/run build a feature')).toEqual({ command: 'run', args: 'build a feature' })
    expect(parseSlash('/STATUS')).toEqual({ command: 'status', args: '' })
    expect(parseSlash('/approve app_123')).toEqual({ command: 'approve', args: 'app_123' })
  })

  it('returns null for non-slash or empty input', () => {
    expect(parseSlash('hello world')).toBeNull()
    expect(parseSlash('')).toBeNull()
    expect(parseSlash('/')).toBeNull()
    expect(parseSlash('/   ')).toBeNull()
    expect(parseSlash('  /help  ')).toEqual({ command: 'help', args: '' })
  })
})

describe('getCommandSuggestions', () => {
  it('returns all commands for bare /', () => {
    const list = getCommandSuggestions('/')
    expect(list.length).toBeGreaterThanOrEqual(8)
    expect(list.some((c) => c.name === 'help')).toBe(true)
    expect(list.some((c) => c.name === 'run')).toBe(true)
  })

  it('filters commands by prefix', () => {
    const rList = getCommandSuggestions('/r')
    expect(rList.some((c) => c.name === 'run')).toBe(true)
    expect(rList.some((c) => c.name === 'runs')).toBe(true)
    expect(rList.every((c) => c.name.startsWith('r'))).toBe(true)
  })
})

describe('getUnknownCommandSuggestions', () => {
  it('suggests closest commands for typos', () => {
    const suggestions = getUnknownCommandSuggestions('runn')
    expect(suggestions).toContain('/run')
    expect(suggestions).toContain('/runs')
  })

  it('suggests /approvals for approv', () => {
    const suggestions = getUnknownCommandSuggestions('approv')
    expect(suggestions.some((s) => s.startsWith('/approv'))).toBe(true)
  })
})

describe('executeSlash', () => {
  function makeMockContext(): SlashContext {
    return {
      session: { id: 'chat_test1' },
      muse: { id: 'muse_1', slug: 'operator' },
      status: vi.fn(async () => 'Status: all good'),
      runs: vi.fn(async (limit: number) => `Runs (${limit})`),
      approvalsList: vi.fn(async () => 'Pending approvals: none'),
      approve: vi.fn(async (ref: string) => `Approved ${ref}`),
      deny: vi.fn(async (ref: string) => `Denied ${ref}`),
      startRun: vi.fn(async (goal: string) => `Started run for: ${goal}`),
      newSession: vi.fn(async () => 'Started new session chat_test2'),
      help: vi.fn(() => 'Help message'),
    }
  }

  it('routes known slash commands to context methods', async () => {
    const ctx = makeMockContext()

    expect(await executeSlash(ctx, '/help')).toEqual({ output: 'Help message' })
    expect(await executeSlash(ctx, '/status')).toEqual({ output: 'Status: all good' })
    expect(await executeSlash(ctx, '/runs')).toEqual({ output: 'Runs (10)' })
    expect(await executeSlash(ctx, '/approvals')).toEqual({ output: 'Pending approvals: none' })
    expect(await executeSlash(ctx, '/approve app_1')).toEqual({ output: 'Approved app_1' })
    expect(await executeSlash(ctx, '/deny app_2')).toEqual({ output: 'Denied app_2' })
    expect(await executeSlash(ctx, '/run do something')).toEqual({ output: 'Started run for: do something' })
    expect(await executeSlash(ctx, '/new')).toEqual({ output: 'Started new session chat_test2', newSession: true })
    expect(await executeSlash(ctx, '/quit')).toEqual({ output: 'Goodbye.', exit: true })
    expect(await executeSlash(ctx, '/exit')).toEqual({ output: 'Goodbye.', exit: true })
  })

  it('validates required arguments for /run, /approve, /deny', async () => {
    const ctx = makeMockContext()

    expect(await executeSlash(ctx, '/run')).toEqual({ output: 'usage: /run <goal>' })
    expect(await executeSlash(ctx, '/approve')).toEqual({ output: 'usage: /approve <ref>' })
    expect(await executeSlash(ctx, '/deny')).toEqual({ output: 'usage: /deny <ref>' })
  })

  it('returns a notice and suggestions for unknown slash command', async () => {
    const ctx = makeMockContext()
    const res = await executeSlash(ctx, '/unknowncmd')
    expect(res?.output).toContain("unknown command '/unknowncmd'")
    expect(res?.output).toContain('/help')
  })
})
