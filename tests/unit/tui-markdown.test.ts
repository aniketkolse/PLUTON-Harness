import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../src/tui/markdown.ts'
import { createTheme } from '../../src/tui/theme.ts'
import { stripAnsi } from '../../src/tui/width.ts'

describe('renderMarkdown', () => {
  const plain = createTheme({ color: false })
  const colored = createTheme({ color: true })

  it('renders plain text and wraps within given width', () => {
    const lines = renderMarkdown('A short paragraph.', 40, plain)
    expect(lines).toEqual(['A short paragraph.'])
  })

  it('renders headings with styling', () => {
    const lines = renderMarkdown('# Main Title\n## Sub Title', 60, plain)
    expect(lines[0]).toBe('Main Title')
    expect(lines[1]).toBe('Sub Title')

    const coloredLines = renderMarkdown('# Main Title', 60, colored)
    expect(stripAnsi(coloredLines[0]!)).toBe('Main Title')
    expect(coloredLines[0]).not.toBe('Main Title') // has ANSI
  })

  it('renders inline bold, italic, and code', () => {
    const text = 'Here is **bold**, *italic*, and `const a = 1`.'
    const plainLines = renderMarkdown(text, 80, plain)
    expect(plainLines[0]).toBe('Here is bold, italic, and const a = 1.')

    const coloredLines = renderMarkdown(text, 80, colored)
    expect(stripAnsi(coloredLines[0]!)).toBe('Here is bold, italic, and const a = 1.')
    expect(coloredLines[0]).toContain('\x1b[')
  })

  it('renders fenced code blocks with bordered box', () => {
    const md = '```ts\nconst x = 42\nconsole.log(x)\n```'
    const lines = renderMarkdown(md, 50, plain)
    expect(lines.length).toBeGreaterThanOrEqual(4)
    expect(lines[0]).toContain('ts')
    expect(lines.some((l) => l.includes('const x = 42'))).toBe(true)
    expect(lines.some((l) => l.includes('console.log(x)'))).toBe(true)
  })

  it('renders lists with bullet indentation', () => {
    const md = '- First point\n- Second point'
    const lines = renderMarkdown(md, 40, plain)
    expect(lines[0]).toContain('First point')
    expect(lines[1]).toContain('Second point')
  })

  it('renders diff code blocks with colored additions and deletions', () => {
    const md = '```diff\n- if (!claimed) {\n+ if (!!claimed) {\n```'
    const lines = renderMarkdown(md, 60, colored)
    const delLine = lines.find((l) => l.includes('if (!claimed)'))!
    const addLine = lines.find((l) => l.includes('if (!!claimed)'))!
    expect(delLine).toBeDefined()
    expect(addLine).toBeDefined()
    // Deletion should be styled with error/red role
    expect(delLine).toContain(colored.paint('error', '- if (!claimed) {').slice(0, 4))
    // Addition should be styled with success/green role
    expect(addLine).toContain(colored.paint('success', '+ if (!!claimed) {').slice(0, 4))
  })
})
