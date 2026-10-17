import { describe, expect, it } from 'vitest'
import { renderOrchestraInspector, type OrchestraInspectorData } from '../../src/tui/orchestra.ts'
import { createTheme } from '../../src/tui/theme.ts'

describe('renderOrchestraInspector enrichment', () => {
  const theme = createTheme()

  it('renders task write scopes, conflicts, and verification summaries', () => {
    const data: OrchestraInspectorData = {
      muses: [{ id: 'm1', slug: 'coder', role: 'coder', engine: 'mock', model: 'mock', state: 'working' }],
      tasks: [
        {
          id: 'task-1',
          title: 'Implement auth',
          state: 'running',
          ownerMuseSlug: 'coder',
          writeScope: ['src/auth/login.ts', 'src/auth/token.ts'],
          conflictNote: 'blocked by task-0 on package.json',
          retries: 1,
        },
        {
          id: 'task-2',
          title: 'Verify auth',
          state: 'completed',
          verificationSummary: '2/2 checks passed',
        },
      ],
      approvals: [],
      events: [],
      circuitTripped: true,
      circuitReason: '2 consecutive identical failures',
      usage: {
        totalInputTokens: 1250,
        totalOutputTokens: 340,
        totalCostUsd: 0.025,
      },
    }

    const lines = renderOrchestraInspector(data, 80, 40, theme)
    const text = lines.join('\n')

    expect(text).toContain('src/auth/login.ts')
    expect(text).toContain('blocked by task-0 on package.json')
    expect(text).toContain('retries: 1')
    expect(text).toContain('2/2 checks passed')
    expect(text).toContain('Circuit breaker: TRIPPED')
    expect(text).toContain('1250 in / 340 out')
  })
})
