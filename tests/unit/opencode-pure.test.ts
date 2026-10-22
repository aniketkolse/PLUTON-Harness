import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCmdShim, resolveOpenCodeBinary } from '../../src/engines/opencode/discover.ts'
import { normalizeSessionUpdate, summarizePromptResult } from '../../src/engines/opencode/normalize.ts'

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*',
  '',
].join('\r\n')

describe('opencode binary resolution', () => {
  it('parses the real npm .cmd shim for its .exe target', () => {
    const shimPath = win32.join('C:', 'npm', 'opencode.cmd')
    const exePath = win32.join('C:', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
    const found = parseCmdShim(
      shimPath,
      () => NPM_SHIM,
      (p) => p === exePath,
    )
    expect(found).toBe(exePath)
  })

  it('handles %~dp0 variants and refuses when no target exists', () => {
    const shimPath = win32.join('C:', 'n', 'x.cmd')
    const text = '"%~dp0\\bin\\tool.exe" %*'
    expect(parseCmdShim(shimPath, () => text, (p) => p === win32.join('C:', 'n', 'bin', 'tool.exe'))).toBe(
      win32.join('C:', 'n', 'bin', 'tool.exe'),
    )
    expect(parseCmdShim(shimPath, () => text, () => false)).toBeNull()
  })

  it('prefers PLUTON_OPENCODE_BIN and reports a broken override precisely', () => {
    const ok = resolveOpenCodeBinary({
      env: { PLUTON_OPENCODE_BIN: '/custom/opencode', PATH: '' },
      platform: 'linux',
      isFile: (p) => p === '/custom/opencode',
    })
    expect(ok).toMatchObject({ ok: true, binary: { path: '/custom/opencode', via: 'env' } })
    const broken = resolveOpenCodeBinary({
      env: { PLUTON_OPENCODE_BIN: '/missing/opencode', PATH: '' },
      platform: 'linux',
      isFile: () => false,
    })
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.fix).toMatch(/PLUTON_OPENCODE_BIN is set to '\/missing\/opencode'/)
  })

  it('scans PATH on win32 for opencode.exe, then .cmd shims', () => {
    const pathA = win32.join('C:', 'a')
    const pathB = win32.join('C:', 'b')
    const direct = resolveOpenCodeBinary({
      env: { PATH: `${pathA};${pathB}` },
      platform: 'win32',
      isFile: (p) => p === win32.join(pathB, 'opencode.exe'),
    })
    expect(direct).toMatchObject({ ok: true, binary: { path: win32.join(pathB, 'opencode.exe'), via: 'path' } })

    const shimDir = win32.join('C:', 'npm')
    const shim = resolveOpenCodeBinary({
      env: { PATH: shimDir },
      platform: 'win32',
      isFile: (p) =>
        p === win32.join(shimDir, 'opencode.cmd') ||
        p === win32.join(shimDir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
      readTextFile: () => NPM_SHIM,
    })
    expect(shim).toMatchObject({
      ok: true,
      binary: { path: win32.join(shimDir, 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'), via: 'cmd-shim' },
    })
  })

  it('finds a bare `opencode` on POSIX PATH and reports a precise failure otherwise', () => {
    const dir = '/usr/local/bin'
    const found = resolveOpenCodeBinary({
      env: { PATH: `/usr/bin:${dir}` },
      platform: 'linux',
      isFile: (p) => p === `${dir}/opencode`,
    })
    expect(found).toMatchObject({ ok: true, binary: { path: `${dir}/opencode`, via: 'path' } })

    const missing = resolveOpenCodeBinary({ env: { PATH: '/usr/bin' }, platform: 'linux', isFile: () => false })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.fix).toMatch(/install OpenCode/)
      expect(missing.looked).toEqual(['/usr/bin/opencode'])
    }
  })
})

describe('session update normalization', () => {
  it('maps message chunks, skips thoughts, and ignores unknown kinds', () => {
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }),
    ).toMatchObject({ events: [{ kind: 'text', text: 'hi' }], ignored: false })
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }),
    ).toMatchObject({ events: [], ignored: true })
    expect(normalizeSessionUpdate({ sessionUpdate: 'brand_new_kind' })).toMatchObject({ events: [], ignored: true })
    expect(normalizeSessionUpdate(null)).toMatchObject({ events: [], kind: null, ignored: true })
  })

  it('maps tool calls and terminal tool updates', () => {
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'tool_call', name: 'bash', title: 'run tests', status: 'pending' }),
    ).toMatchObject({ events: [{ kind: 'tool', name: 'bash', phase: 'start', summary: 'run tests' }] })
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'tool_call', name: 'x', status: 'completed' }).events,
    ).toHaveLength(2)
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'tool_call_update', kind: 'edit', status: 'failed' }),
    ).toMatchObject({ events: [{ kind: 'tool', name: 'edit', phase: 'end', isError: true }] })
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'tool_call_update', kind: 'edit', status: 'in_progress' }),
    ).toMatchObject({ events: [], ignored: true })
  })

  it('reports usage cost only when the engine states a USD amount', () => {
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0, currency: 'USD' } }),
    ).toMatchObject({ events: [{ kind: 'usage', costUsd: 0 }] })
    const nonUsd = normalizeSessionUpdate({
      sessionUpdate: 'usage_update',
      cost: { amount: 5, currency: 'EUR' },
    }).events[0]
    expect(nonUsd).toEqual({ kind: 'usage' })
  })

  it('flags a model change away from the pinned model', () => {
    const update = {
      sessionUpdate: 'config_option_update',
      configOptions: [{ id: 'model', currentValue: 'opencode/other' }],
    }
    const drift = normalizeSessionUpdate(update, { pinnedModel: 'opencode/pinned' })
    expect(drift.events).toMatchObject([{ kind: 'error', code: 'engine_model_changed' }])
    const same = normalizeSessionUpdate(update, { pinnedModel: 'opencode/other' })
    expect(same).toMatchObject({ events: [], ignored: true })
    const unmanaged = normalizeSessionUpdate(update)
    expect(unmanaged).toMatchObject({ events: [], ignored: true })
  })
})

describe('prompt result summarization', () => {
  it('maps stop reasons and carries token usage when present', () => {
    expect(summarizePromptResult({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } })).toEqual({
      outcome: 'success',
      summary: 'stopReason: end_turn',
      usage: { inputTokens: 5, outputTokens: 7 },
    })
    expect(summarizePromptResult({ stopReason: 'cancelled' })).toEqual({
      outcome: 'cancelled',
      summary: 'stopReason: cancelled',
    })
    expect(summarizePromptResult({})).toMatchObject({ outcome: 'unknown' })
    expect(summarizePromptResult({ stopReason: 'nonsense' })).toMatchObject({ outcome: 'unknown' })
  })
})
