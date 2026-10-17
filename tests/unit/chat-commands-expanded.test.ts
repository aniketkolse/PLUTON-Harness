import { describe, expect, it, vi } from 'vitest'
import {
  COMMAND_REGISTRY,
  executeSlash,
  getCommandSuggestions,
  type SlashContext,
} from '../../src/chat/commands.ts'

describe('expanded slash command registry and execution', () => {
  it('registers /plan, /sessions, /doctor, and /permissions in COMMAND_REGISTRY', () => {
    const names = COMMAND_REGISTRY.map((c) => c.name)
    expect(names).toContain('plan')
    expect(names).toContain('sessions')
    expect(names).toContain('doctor')
    expect(names).toContain('permissions')
  })

  it('provides autocomplete suggestions for new commands', () => {
    const pSuggestions = getCommandSuggestions('p')
    const pNames = pSuggestions.map((s) => s.name)
    expect(pNames).toContain('plan')
    expect(pNames).toContain('permissions')

    const dSuggestions = getCommandSuggestions('doc')
    expect(dSuggestions.map((s) => s.name)).toContain('doctor')

    const sSuggestions = getCommandSuggestions('sess')
    expect(sSuggestions.map((s) => s.name)).toContain('sessions')
  })

  it('routes /plan commands to ctx.plan', async () => {
    const planMock = vi.fn().mockResolvedValue('Plan graph output')
    const ctx: SlashContext = {
      session: { id: 'sess-1' },
      muse: { id: 'm-1', slug: 'lead' },
      status: vi.fn(),
      runs: vi.fn(),
      approvalsList: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      startRun: vi.fn(),
      newSession: vi.fn(),
      help: () => 'help',
      plan: planMock,
    }

    const res = await executeSlash(ctx, '/plan Build auth')
    expect(planMock).toHaveBeenCalledWith('Build auth')
    expect(res?.output).toBe('Plan graph output')
  })

  it('routes /sessions commands to ctx.sessions', async () => {
    const sessionsMock = vi.fn().mockResolvedValue('Sessions list')
    const ctx: SlashContext = {
      session: { id: 'sess-1' },
      muse: { id: 'm-1', slug: 'lead' },
      status: vi.fn(),
      runs: vi.fn(),
      approvalsList: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      startRun: vi.fn(),
      newSession: vi.fn(),
      help: () => 'help',
      sessions: sessionsMock,
    }

    const res = await executeSlash(ctx, '/sessions')
    expect(sessionsMock).toHaveBeenCalledWith('')
    expect(res?.output).toBe('Sessions list')
  })

  it('routes /doctor commands to ctx.doctor', async () => {
    const doctorMock = vi.fn().mockResolvedValue('Doctor checks pass')
    const ctx: SlashContext = {
      session: { id: 'sess-1' },
      muse: { id: 'm-1', slug: 'lead' },
      status: vi.fn(),
      runs: vi.fn(),
      approvalsList: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      startRun: vi.fn(),
      newSession: vi.fn(),
      help: () => 'help',
      doctor: doctorMock,
    }

    const res = await executeSlash(ctx, '/doctor')
    expect(doctorMock).toHaveBeenCalled()
    expect(res?.output).toBe('Doctor checks pass')
  })

  it('routes /permissions commands to ctx.permissions', async () => {
    const permissionsMock = vi.fn().mockResolvedValue('Effective permissions')
    const ctx: SlashContext = {
      session: { id: 'sess-1' },
      muse: { id: 'm-1', slug: 'lead' },
      status: vi.fn(),
      runs: vi.fn(),
      approvalsList: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      startRun: vi.fn(),
      newSession: vi.fn(),
      help: () => 'help',
      permissions: permissionsMock,
    }

    const res = await executeSlash(ctx, '/permissions')
    expect(permissionsMock).toHaveBeenCalledWith('')
    expect(res?.output).toBe('Effective permissions')
  })
})
