import { describe, expect, it, vi } from 'vitest'
import {
  executeSlash,
  COMMAND_REGISTRY,
  type SlashContext,
} from '../../src/chat/commands.ts'

describe('Model and Cancel Slash Commands', () => {
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
      models: vi.fn(async () => 'Available models:\n  - gpt-4o (current)\n  - claude-3-5-sonnet'),
      model: vi.fn(async (name?: string) =>
        name ? `Switched model to ${name}` : 'Current model: gpt-4o',
      ),
      cancel: vi.fn(async (runId?: string) =>
        runId ? `Cancelled run ${runId}` : 'Cancelled active run run_123',
      ),
    }
  }

  it('includes /models, /model, and /cancel in COMMAND_REGISTRY', () => {
    const names = COMMAND_REGISTRY.map((c) => c.name)
    expect(names).toContain('models')
    expect(names).toContain('model')
    expect(names).toContain('cancel')
  })

  it('routes /models to ctx.models()', async () => {
    const ctx = makeMockContext()
    const res = await executeSlash(ctx, '/models')
    expect(ctx.models).toHaveBeenCalled()
    expect(res?.output).toContain('Available models')
  })

  it('routes /model without args to ctx.model("")', async () => {
    const ctx = makeMockContext()
    const res = await executeSlash(ctx, '/model')
    expect(ctx.model).toHaveBeenCalledWith('')
    expect(res?.output).toContain('Current model: gpt-4o')
  })

  it('routes /model with args to ctx.model("claude-3-5-sonnet")', async () => {
    const ctx = makeMockContext()
    const res = await executeSlash(ctx, '/model claude-3-5-sonnet')
    expect(ctx.model).toHaveBeenCalledWith('claude-3-5-sonnet')
    expect(res?.output).toContain('Switched model to claude-3-5-sonnet')
  })

  it('routes /cancel to ctx.cancel() with optional runId', async () => {
    const ctx = makeMockContext()
    const res1 = await executeSlash(ctx, '/cancel')
    expect(ctx.cancel).toHaveBeenCalledWith('')
    expect(res1?.output).toContain('Cancelled active run run_123')

    const res2 = await executeSlash(ctx, '/cancel run_999')
    expect(ctx.cancel).toHaveBeenCalledWith('run_999')
    expect(res2?.output).toContain('Cancelled run run_999')
  })
})
