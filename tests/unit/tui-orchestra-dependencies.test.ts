import { describe, expect, it } from 'vitest'
import {
  renderOrchestraInspector,
  type OrchestraInspectorData,
} from '../../src/tui/orchestra.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('Orchestra Inspector with Task Dependencies', () => {
  const plain = createTheme({ color: false })

  it('renders task dependencies when present', () => {
    const data: OrchestraInspectorData = {
      muses: [
        {
          id: 'm1',
          slug: 'worker-a',
          role: 'worker',
          engine: 'qwen',
          model: 'qwen-2.5',
          state: 'working',
        },
      ],
      tasks: [
        {
          id: 'task_1',
          title: 'Implement storage',
          state: 'completed',
          ownerMuseSlug: 'worker-a',
        },
        {
          id: 'task_2',
          title: 'Implement API endpoint',
          state: 'running',
          ownerMuseSlug: 'worker-a',
          dependencies: ['task_1'],
        },
      ],
      approvals: [],
      events: [],
    }

    const lines = renderOrchestraInspector(data, 45, 25, plain)
    const fullText = lines.map((l) => stripAnsi(l)).join('\n')
    expect(fullText).toContain('Implement API endpoint')
    expect(fullText).toContain('needs: task_1')
  })
})
