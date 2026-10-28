import { describe, expect, it } from 'vitest'
import type { ApprovalMode, JsonValue } from '../../src/domain/models.ts'
import { permissionScope } from '../../src/engines/acp/options.ts'
import {
  ENGINE_SCOPE_LIMITS,
  evaluateEnginePermission,
  type EnginePermissionContext,
} from '../../src/policy/engine-permissions.ts'

/**
 * Engine permission policy: pure allow/ask/deny classification for the requests
 * an engine sends over ACP. The policy must never upgrade an unknown or
 * destructive action to `allow`, and `autonomous-bounded` must stay fail-closed.
 */

const WORKDIR = '/repo/.pluton/workspaces/task-1'
const PROJECT_ROOT = '/repo'

function context(overrides: Partial<EnginePermissionContext> = {}): EnginePermissionContext {
  return {
    approvalMode: 'ask-for-sensitive-actions',
    workspacePolicy: 'isolated-task-checkout',
    workdir: WORKDIR,
    projectRoot: PROJECT_ROOT,
    protectedPaths: ['secrets/*'],
    ...overrides,
  }
}

function evaluate(
  request: { description: string; scope: import('../../src/domain/models.ts').JsonValue },
  overrides: Partial<EnginePermissionContext> = {},
) {
  return evaluateEnginePermission(request, context(overrides))
}

describe('evaluateEnginePermission', () => {
  it('denies every request under autonomous-bounded, even a read', () => {
    const verdict = evaluate(
      { description: 'read src/app.ts', scope: { toolKind: 'read', paths: ['src/app.ts'] } },
      { approvalMode: 'autonomous-bounded' },
    )
    expect(verdict.outcome).toBe('deny')
    expect(verdict.risk).toBe('high')
    expect(verdict.reason).toMatch(/autonomous-bounded/)
  })

  it('allows a recognized read-only action inside the session workdir', () => {
    const verdict = evaluate({
      description: 'read src/app.ts',
      scope: { toolKind: 'read', paths: ['src/app.ts'] },
    })
    expect(verdict.outcome).toBe('allow')
    expect(verdict.risk).toBe('low')
  })

  it('asks on an unrecognized/empty request instead of silently allowing it', () => {
    const verdict = evaluate({ description: 'engine requested permission', scope: {} })
    expect(verdict.outcome).toBe('ask')
    expect(verdict.risk).toBe('medium')
  })

  it('denies destructive shell commands', () => {
    const verdict = evaluate({
      description: 'run a command',
      scope: { toolKind: 'execute', command: 'rm -rf /repo' },
    })
    expect(verdict.outcome).toBe('deny')
    expect(verdict.risk).toBe('high')
    expect(verdict.signals.some((s) => s.includes('command'))).toBe(true)
  })

  it('denies destructive argv commands even when the tool kind claims read', () => {
    const verdict = evaluate({
      description: 'read something',
      scope: { toolKind: 'read', argv: ['git', 'reset', '--hard'] },
    })
    expect(verdict.outcome).toBe('deny')
  })

  it('denies a relative path that escapes the session workdir', () => {
    const verdict = evaluate({
      description: 'edit a file',
      scope: { toolKind: 'edit', paths: ['../../outside.txt'] },
    })
    expect(verdict.outcome).toBe('deny')
    expect(verdict.reason).toMatch(/workdir/)
  })

  it('denies an absolute path outside the project root', () => {
    const verdict = evaluate({
      description: 'edit a file',
      scope: { toolKind: 'edit', paths: ['/etc/passwd'] },
    })
    expect(verdict.outcome).toBe('deny')
    expect(verdict.reason).toMatch(/outside/)
  })

  it('asks on a protected path rather than allowing it', () => {
    const verdict = evaluate({
      description: 'edit a protected file',
      scope: { toolKind: 'edit', paths: ['secrets/prod.env'] },
    })
    expect(verdict.outcome).toBe('ask')
    expect(verdict.risk).toBe('high')
  })

  it('asks on a sensitive file name', () => {
    const verdict = evaluate({
      description: 'edit the environment file',
      scope: { toolKind: 'edit', paths: ['.env'] },
    })
    expect(verdict.outcome).toBe('ask')
    expect(verdict.risk).toBe('high')
  })

  it('denies a manager-session write', () => {
    const verdict = evaluate(
      { description: 'edit src/app.ts', scope: { toolKind: 'edit', paths: ['src/app.ts'] } },
      { isManager: true, workspacePolicy: 'coordinator-read-only', workdir: PROJECT_ROOT },
    )
    expect(verdict.outcome).toBe('deny')
    expect(verdict.reason).toMatch(/manager|read-only/)
  })

  it('denies a write under the read-only workspace policy', () => {
    const verdict = evaluate(
      { description: 'edit src/app.ts', scope: { toolKind: 'edit', paths: ['src/app.ts'] } },
      { workspacePolicy: 'read-only' },
    )
    expect(verdict.outcome).toBe('deny')
  })

  it('denies an unknown approval mode instead of treating it as ask', () => {
    const verdict = evaluate(
      { description: 'read src/app.ts', scope: { toolKind: 'read', paths: ['src/app.ts'] } },
      { approvalMode: 'made-up-mode' as ApprovalMode },
    )
    expect(verdict.outcome).toBe('deny')
  })

  it('never lets a spoofed read-only kind hide a command', () => {
    const verdict = evaluate({
      description: 'read src/app.ts',
      scope: { toolKind: 'read', paths: ['src/app.ts'], command: 'powershell -Command Remove-Item -Recurse -Force .' },
    })
    expect(verdict.outcome).toBe('deny')
  })

  it('does not auto-allow a read without a concrete path', () => {
    const scopes: JsonValue[] = [
      { toolKind: 'read' },
      { toolKind: 'read', paths: [] },
      { toolKind: 'search' },
      { toolKind: 'list', locations: [] },
    ]
    for (const scope of scopes) {
      const verdict = evaluate({ description: 'read something', scope })
      expect(verdict.outcome).toBe('ask')
      expect(verdict.reason).toMatch(/no concrete path/)
    }
  })

  it('denies control-directory spellings that Win32 would resolve to .git/.pluton', () => {
    for (const path of ['.GIT/config', '.git./config', '.git /config', '.pluton./state', 'PLUTON~1/state']) {
      const verdict = evaluate(
        { description: 'read a file', scope: { toolKind: 'read', paths: [path] } },
        { platform: 'win32' },
      )
      expect(verdict.outcome, path).toBe('deny')
    }
  })

  it('keeps Linux case-sensitive path semantics', () => {
    const verdict = evaluate(
      { description: 'read a file', scope: { toolKind: 'read', paths: ['.GIT/config'] } },
      { platform: 'linux' },
    )
    expect(verdict.outcome).toBe('allow')
  })

  it('matches protected paths case-insensitively where the filesystem does', () => {
    const scope = { toolKind: 'read', paths: ['SECRETS/PROD.ENV'] }
    const win32 = evaluate({ description: 'read a protected file', scope }, { platform: 'win32' })
    expect(win32.outcome).toBe('ask')
    const linux = evaluate({ description: 'read a protected file', scope }, { platform: 'linux' })
    expect(linux.outcome).toBe('allow')
  })

  it('denies oversized commands, paths and path lists instead of deciding on truncation', () => {
    const longCommand = evaluate({
      description: 'run a command',
      scope: { toolKind: 'execute', command: 'x'.repeat(ENGINE_SCOPE_LIMITS.maxCommandChars + 1) },
    })
    expect(longCommand.outcome).toBe('deny')
    expect(longCommand.reason).toMatch(/too large/)

    const longPath = evaluate({
      description: 'read a file',
      scope: { toolKind: 'read', paths: ['x'.repeat(ENGINE_SCOPE_LIMITS.maxPathChars + 1)] },
    })
    expect(longPath.outcome).toBe('deny')

    const manyPaths = evaluate({
      description: 'read files',
      scope: {
        toolKind: 'read',
        paths: Array.from({ length: ENGINE_SCOPE_LIMITS.maxPaths + 1 }, (_, i) => `src/${String(i)}.ts`),
      },
    })
    expect(manyPaths.outcome).toBe('deny')
  })

  it('denies malformed or conflicting scope fields instead of guessing', () => {
    const scopes: JsonValue[] = [
      { toolKind: 'read', paths: ['src/app.ts'], argv: ['cat', 7] },
      { toolKind: 'read', paths: 'src/app.ts' },
      { toolKind: 'read', paths: ['src/app.ts'], command: { nested: 'rm -rf /' } },
      { toolKind: 'read', paths: ['src/app.ts'], oversized: true },
      { toolKind: 'read', paths: ['src/app.ts'], malformed: true },
    ]
    for (const scope of scopes) {
      const verdict = evaluate({ description: 'read a file', scope })
      expect(verdict.outcome).toBe('deny')
    }
  })

  it('does not auto-allow a recognized read with input it cannot map', () => {
    const verdict = evaluate({
      description: 'read a file',
      scope: {
        toolKind: 'read',
        paths: ['src/app.ts'],
        rawInput: { path: 'src/app.ts', shellCommand: 'rm -rf /repo' },
      },
    })
    expect(verdict.outcome).toBe('ask')
  })

  it('keeps a destructive signal from being downgraded by a later sensitive path', () => {
    const verdict = evaluate({
      description: 'read files',
      scope: { toolKind: 'read', paths: ['.env', '../outside.txt'] },
    })
    expect(verdict.outcome).toBe('deny')
  })
})

describe('permissionScope', () => {
  it('carries bounded command, path and cwd signals from rawInput', () => {
    const scope = permissionScope({
      toolCall: {
        kind: 'execute',
        title: 'run tests',
        locations: [{ path: 'src/app.ts' }],
        rawInput: {
          command: 'npm test',
          cwd: '/repo',
          path: 'src/app.ts',
          secret: 'must-not-be-copied',
        },
      },
      optionKinds: ['allow_once', 'reject_once'],
    })
    expect(scope).toMatchObject({
      toolKind: 'execute',
      command: 'npm test',
      cwd: '/repo',
      path: 'src/app.ts',
      paths: ['src/app.ts'],
      optionKinds: ['allow_once', 'reject_once'],
    })
    expect(JSON.stringify(scope)).not.toContain('must-not-be-copied')
  })

  it('marks over-limit command and path values instead of silently truncating them', () => {
    const scope = permissionScope({
      toolCall: {
        kind: 'read',
        rawInput: {
          command: 'x'.repeat(ENGINE_SCOPE_LIMITS.maxCommandChars + 100),
          path: 'p'.repeat(ENGINE_SCOPE_LIMITS.maxPathChars + 100),
        },
      },
      optionKinds: [],
    }) as Record<string, unknown>
    expect(scope['oversized']).toBe(true)
    expect((scope['command'] as string).length).toBe(ENGINE_SCOPE_LIMITS.maxCommandChars)
    expect((scope['path'] as string).length).toBe(ENGINE_SCOPE_LIMITS.maxPathChars)
  })

  it('preserves a complete command and path under the limits', () => {
    const command = 'npm test -- --runInBand'
    const path = 'src/features/permissions/engine-policy.ts'
    const scope = permissionScope({
      toolCall: { kind: 'execute', rawInput: { command, path } },
      optionKinds: [],
    }) as Record<string, unknown>
    expect(scope['command']).toBe(command)
    expect(scope['path']).toBe(path)
    expect(scope['oversized']).toBeUndefined()
    expect(scope['malformed']).toBeUndefined()
  })

  it('flags excessive path lists without dropping the decision input', () => {
    const locations = Array.from({ length: ENGINE_SCOPE_LIMITS.maxPaths + 5 }, (_, i) => ({
      path: `src/${String(i)}.ts`,
    }))
    const scope = permissionScope({ toolCall: { kind: 'read', locations }, optionKinds: [] }) as Record<
      string,
      unknown
    >
    expect(scope['oversized']).toBe(true)
    expect((scope['paths'] as unknown[]).length).toBe(ENGINE_SCOPE_LIMITS.maxPaths)
  })

  it('marks conflicting command spellings and malformed argv as malformed', () => {
    const conflict = permissionScope({
      toolCall: { kind: 'execute', rawInput: { command: 'echo safe', cmd: 'rm -rf /repo' } },
      optionKinds: [],
    }) as Record<string, unknown>
    expect(conflict['malformed']).toBe(true)

    const badArgv = permissionScope({
      toolCall: { kind: 'execute', rawInput: { argv: ['echo', 7] } },
      optionKinds: [],
    }) as Record<string, unknown>
    expect(badArgv['malformed']).toBe(true)
  })

  it('marks nested input Pluton cannot map so the policy cannot auto-allow it', () => {
    const scope = permissionScope({
      toolCall: { kind: 'read', rawInput: { path: 'src/app.ts', script: 'rm -rf /repo' } },
      optionKinds: [],
    }) as Record<string, unknown>
    expect(scope['unrecognizedInput']).toBe(true)
    expect(JSON.stringify(scope)).not.toContain('rm -rf')
  })
})
