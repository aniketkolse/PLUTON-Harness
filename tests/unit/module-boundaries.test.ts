import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * R4 module boundaries: the architecture is enforced, not aspirational.
 *
 * The rules below encode dependency *direction* (what may depend on what), not
 * today's complete call graph. They are deliberately principle-based so a new
 * file inside an existing layer is free, while a new inverted dependency fails
 * with the offending file and specifier.
 *
 * Two known composition edges still import `cli/` from outside it. They are
 * allowlisted, not blessed: each is tracked debt, and the test fails if the
 * entry disappears so the allowlist cannot silently rot.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

interface ImportEdge {
  /** repo-relative path under src/, posix separators */
  from: string
  /** repo-relative target path under src/, posix separators */
  to: string
  specifier: string
}

function listTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTsFiles(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files.sort()
}

/** Whole-line `//` comments and block comments; line structure is irrelevant here. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function relativeSpecifiers(text: string): string[] {
  const cleaned = stripComments(text)
  const specs = new Set<string>()
  for (const match of cleaned.matchAll(/\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?(['"])(\.[^'"]*)\1/g)) {
    specs.add(match[2]!)
  }
  for (const match of cleaned.matchAll(/\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g)) {
    specs.add(match[2]!)
  }
  return [...specs]
}

function resolveSpecifier(file: string, specifier: string): string | null {
  const base = resolve(SRC, dirname(file), specifier)
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) return null
  return relative(SRC, found).split(sep).join('/')
}

function areaOf(file: string): string {
  return file.includes('/') ? file.split('/')[0]! : file.replace(/\.ts$/, '')
}

function collectEdges(): { edges: ImportEdge[]; unresolved: string[] } {
  const edges: ImportEdge[] = []
  const unresolved: string[] = []
  for (const absolute of listTsFiles(SRC)) {
    const from = relative(SRC, absolute).split(sep).join('/')
    const text = readFileSync(absolute, 'utf8')
    for (const specifier of relativeSpecifiers(text)) {
      const to = resolveSpecifier(from, specifier)
      if (to === null) {
        unresolved.push(`${from} -> ${specifier}`)
        continue
      }
      edges.push({ from, to, specifier })
    }
  }
  return { edges, unresolved }
}

/** Directed dependency direction: a module may import only the listed areas. */
const LEAF_RULES: Record<string, readonly string[]> = {
  domain: [],
  util: ['domain'],
  config: ['domain'],
  store: ['domain', 'util'],
  workspace: ['domain', 'util'],
  bootstrap: ['config', 'domain', 'store'],
  version: [],
}

const PRESENTATION_AREA = new Set(['ui', 'tui'])
const PRESENTATION_FORBIDDEN = new Set([
  'cli',
  'server',
  'orchestrator',
  'store',
  'tools',
  'workspace',
  'sandbox',
  'execution',
  'config',
  'plan',
  'verify',
])

const ENGINES_FORBIDDEN = new Set([
  'cli',
  'server',
  'orchestrator',
  'tools',
  'workspace',
  'execution',
  'sandbox',
  'plan',
  'verify',
  'chat',
  'ui',
  'tui',
])

/**
 * Files outside `cli/` that still import it.
 * Allowlisted as tracked debt so module boundaries remain enforced.
 */
const CLI_IMPORT_ALLOWLIST = new Set<string>(['server/routes.ts'])

describe('module boundaries', () => {
  const { edges, unresolved } = collectEdges()

  it('parses the real import graph (the scanner is not vacuous)', () => {
    expect(edges.length).toBeGreaterThan(100)
    expect(edges.some((e) => e.from === 'cli/commands/logs.ts' && e.to === 'store/query.ts')).toBe(true)
    expect(edges.some((e) => e.from === 'domain/state.ts' && e.to === 'domain/errors.ts')).toBe(true)
    expect(edges.some((e) => e.from === 'cli/commands/status.ts' && e.to === 'store/query.ts')).toBe(true)
  })

  it('resolves every relative import inside src/', () => {
    expect(unresolved).toEqual([])
  })

  it('enforces dependency direction for the foundational layers', () => {
    const violations: string[] = []
    for (const edge of edges) {
      const allowed = LEAF_RULES[areaOf(edge.from)]
      if (allowed === undefined) continue
      const target = areaOf(edge.to)
      if (target === areaOf(edge.from)) continue
      if (!allowed.includes(target)) {
        violations.push(`${edge.from} imports ${edge.specifier} (${areaOf(edge.from)} may not depend on ${target})`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps presentation modules free of infrastructure and transport', () => {
    const violations: string[] = []
    for (const edge of edges) {
      if (!PRESENTATION_AREA.has(areaOf(edge.from))) continue
      if (PRESENTATION_FORBIDDEN.has(areaOf(edge.to))) {
        violations.push(
          `${edge.from} imports ${edge.specifier} (${areaOf(edge.from)} may not depend on ${areaOf(edge.to)})`,
        )
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps engine adapters below orchestration, transport and UI', () => {
    const violations: string[] = []
    for (const edge of edges) {
      if (areaOf(edge.from) !== 'engines') continue
      if (ENGINES_FORBIDDEN.has(areaOf(edge.to))) {
        violations.push(`${edge.from} imports ${edge.specifier} (engines may not depend on ${areaOf(edge.to)})`)
      }
    }
    expect(violations).toEqual([])
  })

  it('lets only the CLI import the server', () => {
    const violations = edges
      .filter((edge) => areaOf(edge.to) === 'server' && !['cli', 'server'].includes(areaOf(edge.from)))
      .map((edge) => `${edge.from} imports ${edge.specifier} (only cli/ may compose the server)`)
    expect(violations).toEqual([])
  })

  it('allows only the documented composition edges to import cli/', () => {
    const importers = edges.filter((edge) => areaOf(edge.to) === 'cli' && areaOf(edge.from) !== 'cli')
    const violations = importers
      .filter((edge) => !CLI_IMPORT_ALLOWLIST.has(edge.from))
      .map((edge) => `${edge.from} imports ${edge.specifier} (move shared logic out of cli/ or add a tracked allowlist entry)`)
    expect(violations).toEqual([])

    const used = new Set(importers.map((edge) => edge.from))
    const stale = [...CLI_IMPORT_ALLOWLIST].filter((file) => !used.has(file))
    expect(stale, 'remove allowlist entries that no longer import cli/').toEqual([])
  })
})
