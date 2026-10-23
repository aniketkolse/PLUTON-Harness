import { describe, expect, it } from 'vitest'
import {
  renderOrchestraInspector,
  type OrchestraInspectorData,
} from '../../src/tui/orchestra.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('renderOrchestraInspector', () => {
  const plain = createTheme({ color: false })
  const colored = createTheme({ color: true })

  it('renders Ships, Task list, Pending approvals, and Recent events', () => {
    const data: OrchestraInspectorData = {
      ships: [
        {
          id: 'm1',
          slug: 'manager',
          role: 'supervisor',
          engine: 'opencode',
          model: 'claude-3-5-sonnet',
          state: 'working',
        },
        {
          id: 'm2',
          slug: 'worker-a',
          role: 'worker',
          engine: 'opencode',
          model: 'opencode/glm-5.3-flash-free',
          state: 'idle',
        },
      ],
      tasks: [
        { id: 't1', title: 'research auth', state: 'completed', ownerShipSlug: 'researcher' },
        { id: 't2', title: 'implement fix', state: 'running', ownerShipSlug: 'worker-a' },
      ],
      approvals: [{ id: 'app_1', action: 'shell', reason: 'run test script' }],
      events: [{ seq: 1, type: 'task.started', summary: 'Task t2 started' }],
    }

    const lines = renderOrchestraInspector(data, 35, 20, plain)
    expect(lines.length).toBeLessThanOrEqual(20)

    const fullText = lines.join('\n')
    expect(fullText).toContain('ORCHESTRA')
    expect(fullText).toContain('Ships')
    expect(fullText).toContain('manager')
    expect(fullText).toContain('working')
    expect(fullText).toContain('Task graph')
    expect(fullText).toContain('implement fix')
    expect(fullText).toContain('Pending approvals')
    expect(fullText).toContain('Recent events')
  })

  it('renders gracefully when tasks and approvals are empty', () => {
    const data: OrchestraInspectorData = {
      muses: [{ id: 'm1', slug: 'manager', role: 'supervisor', engine: 'mock', model: 'mock-1', state: 'idle' }],
      tasks: [],
      approvals: [],
      events: [],
    }
    const lines = renderOrchestraInspector(data, 30, 15, plain)
    const fullText = lines.join('\n')
    expect(fullText).toContain('(no active tasks)')
    expect(fullText).toContain('(none)')
  })
})
