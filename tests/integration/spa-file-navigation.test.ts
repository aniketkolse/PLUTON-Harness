import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('SPA File Navigation Assets and Contract', () => {
  const assetsFile = join(__dirname, '../../src/server/static-assets.ts')
  const content = readFileSync(assetsFile, 'utf8')

  it('contains file search input and breadcrumbs elements in HTML', () => {
    expect(content).toContain('id="fileSearchInput"')
    expect(content).toContain('id="fileBreadcrumbs"')
    expect(content).toContain('id="fileSearchResults"')
  })

  it('contains CSS definitions for breadcrumbs and file search', () => {
    expect(content).toContain('.file-breadcrumbs')
    expect(content).toContain('.file-search-input')
  })

  it('implements on-demand directory expansion in JavaScript', () => {
    expect(content).toContain('/api/files?dir=')
    expect(content).toContain('expandedDirs')
  })

  it('implements recursive file search handling in JavaScript', () => {
    expect(content).toContain('/api/files/search')
    expect(content).toContain('searchWorkspace')
  })

  it('defines flat minimal SVG icons for directories and files', () => {
    expect(content).toContain('file-icon-dir')
    expect(content).toContain('file-chevron')
  })
})
