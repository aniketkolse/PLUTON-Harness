import { describe, it, expect } from 'vitest'
import { renderQaQuestionCardHtml, STATIC_ASSETS } from '../../src/server/static-assets.ts'

describe('Interactive QA Question Card HTML', () => {
  it('renders options, dependent task badges, and submit button', () => {
    const html = renderQaQuestionCardHtml({
      id: 'app-q1',
      title: 'Heartbeat Timeout Strategy',
      description: 'Choose failover threshold',
      dependentTasks: ['task-coder-3'],
      options: ['3 Heartbeats', 'Manual Approval'],
    })
    expect(html).toContain('qa-card')
    expect(html).toContain('Heartbeat Timeout Strategy')
    expect(html).toContain('Choose failover threshold')
    expect(html).toContain('qa-badge')
    expect(html).toContain('task-coder-3')
    expect(html).toContain('Confirm & Unblock')
    expect(html).toContain('3 Heartbeats')
    expect(html).toContain('Manual Approval')
  })

  it('renders selected option if specified', () => {
    const html = renderQaQuestionCardHtml({
      id: 'app-q2',
      title: 'Database Engine',
      options: ['PostgreSQL', 'SQLite'],
      selectedOption: 'PostgreSQL',
    })
    expect(html).toContain('is-selected')
    expect(html).toContain('PostgreSQL')
  })

  it('renders resolved status when resolved', () => {
    const html = renderQaQuestionCardHtml({
      id: 'app-q3',
      title: 'Resolved Question',
      options: ['Option A', 'Option B'],
      selectedOption: 'Option A',
      resolved: true,
    })
    expect(html).toContain('qa-card')
    expect(html).toContain('qa-resolved')
  })

  it('includes QA styles in embedded app.css', () => {
    const css = STATIC_ASSETS['/app.css']?.content ?? ''
    expect(css).toContain('.qa-card')
    expect(css).toContain('.qa-badge')
    expect(css).toContain('.qa-option-btn')
  })

  it('includes QA question card handlers in embedded app.js', () => {
    const js = STATIC_ASSETS['/app.js']?.content ?? ''
    expect(js).toContain('renderQaQuestionCard')
    expect(js).toContain('/api/approvals/')
  })
})
