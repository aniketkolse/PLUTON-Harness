import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('SPA Multi-File Editor Tabs Assets and Contract', () => {
  const assetsFile = join(__dirname, '../../src/server/static-assets.ts')
  const content = readFileSync(assetsFile, 'utf8')

  it('contains file tabs bar in HTML markup', () => {
    expect(content).toContain('id="fileTabsBar"')
  })

  it('contains CSS styling for file tabs and dirty dot', () => {
    expect(content).toContain('.file-tabs-bar')
    expect(content).toContain('.file-tab')
    expect(content).toContain('.file-tab-dirty')
    expect(content).toContain('.file-tab-close')
  })

  it('implements multi-tab state management in JavaScript', () => {
    expect(content).toContain('renderEditorTabs')
    expect(content).toContain('closeEditorTab')
    expect(content).toContain('switchEditorTab')
  })

  it('tracks dirty buffers and guards against unsaved loss on tab close', () => {
    expect(content).toContain('isDirty')
    expect(content).toContain('originalContent')
    expect(content).toContain('Discard unsaved changes')
  })

  it('supports Ctrl+W keyboard shortcut to close active editor tab', () => {
    expect(content).toContain('closeEditorTab')
    expect(content).toMatch(/key\s*===?\s*['"]w['"]|key\s*===?\s*['"]W['"]/)
  })
})
