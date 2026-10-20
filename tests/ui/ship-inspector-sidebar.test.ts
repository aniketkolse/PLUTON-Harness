import { describe, it, expect } from 'vitest'
import { STATIC_ASSETS } from '../../src/server/static-assets.ts'

describe('Right-Side Inspector Sidebar Assets', () => {
  it('contains #rightInspector with horizontal partition styles and toggle hook in index.html', () => {
    const indexHtml = STATIC_ASSETS['/index.html']?.content ?? ''
    expect(indexHtml).toContain('id="rightInspector"')
    expect(indexHtml).toContain('class="right-inspector is-hidden"')
    expect(indexHtml).toContain('aria-label="Ship Workers Activity Inspector"')
    expect(indexHtml).toContain('style="width: 440px;"')
    expect(indexHtml).toContain('id="rightInspectorClose"')
    expect(indexHtml).toContain('id="rightInspectorGrid"')
    expect(indexHtml).toContain('class="right-inspector-grid"')
    expect(indexHtml).toContain('id="shipActivityBadgeContainer"')
  })

  it('contains 440px width, equal-height partitions flex, independent stream scrolling, and responsive rules in app.css', () => {
    const appCss = STATIC_ASSETS['/app.css']?.content || ''
    expect(appCss).toContain('width: 440px')
    expect(appCss).toContain('.right-inspector')
    expect(appCss).toContain('.right-inspector-grid')
    expect(appCss).toContain('.worker-partition')
    expect(appCss).toContain('flex: 1 1 0')
    expect(appCss).toContain('min-height: 0')
    expect(appCss).toContain('.worker-partition-head')
    expect(appCss).toContain('.worker-stream')
    expect(appCss).toContain('overflow-y: auto')
    expect(appCss).toContain('min-height: 160px')
    expect(appCss).toContain('@media (max-width: 1000px)')
    expect(appCss).toContain('.activity-badge')
  })

  it('contains wiring in /app.js for toggling, close button, Esc key, worker SSE events and partition reconstitution', () => {
    const appJs = STATIC_ASSETS['/app.js']?.content ?? ''
    // Badge toggle
    expect(appJs).toContain('shipActivityBadgeContainer')
    expect(appJs).toContain('toggleRightInspector')
    // Close button
    expect(appJs).toContain('rightInspectorClose')
    // Esc key handling
    expect(appJs).toContain('closeTopOverlay')
    expect(appJs).toContain('rightInspector')
    // Worker SSE event handling
    expect(appJs).toContain('worker.')
    expect(appJs).toContain('handleWorkerEvent')
    expect(appJs).toContain('rightInspectorGrid')
    expect(appJs).toContain('worker-partition')
    expect(appJs).toContain('worker-stream')
    // Reconstitution on reconnect / page load
    expect(appJs).toContain('reconstituteWorkerPartitions')
    expect(appJs).toContain('updateInspectorPartitionsLayout')
  })
})
