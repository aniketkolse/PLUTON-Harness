#!/usr/bin/env node
/**
 * Documentation link gate (parity O5).
 *
 * Walks README.md, THIRD_PARTY_NOTICES.md and docs/**\/*.md in the repository
 * (or the tree given by --root), extracts relative Markdown link/image targets,
 * and fails when a target does not resolve to a file.
 *
 * Ignored: absolute URLs with a scheme (http:, https:, mailto:, …), protocol-
 * relative URLs (//), pure anchors (#…), fenced code blocks and inline code.
 * Percent-encoded paths are decoded before resolution.
 *
 * Usage:
 *   node scripts/verify-docs.mjs [--root <dir>]
 *
 * Exit code 0 = every relative link resolves; 1 = at least one dead link or
 * the tree could not be read. Dead links are printed to stderr, one per line,
 * so the release gate can surface them without mixing them into the summary.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readRoot(argv) {
  const index = argv.indexOf('--root')
  if (index === -1) return defaultRoot
  const value = argv[index + 1]
  if (!value) {
    console.error('verify-docs: --root requires a directory')
    process.exit(1)
  }
  return resolve(value)
}

const root = readRoot(process.argv.slice(2))

/** @returns {string[]} repo-relative markdown file paths, deterministic order. */
function collectMarkdownFiles() {
  const files = []
  for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md']) {
    if (existsSync(join(root, name))) files.push(name)
  }
  const docsDir = join(root, 'docs')
  if (existsSync(docsDir)) {
    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md')) files.push(relative(root, full).split(sep).join('/'))
      }
    }
    walk(docsDir)
  }
  return files
}

/**
 * Inline Markdown link targets, ignoring fenced blocks and inline code.
 * Matches `](target)`, `](target "title")`, images and links nested in links.
 * @returns {{target: string, line: number}[]}
 */
function extractLinks(text) {
  const links = []
  let inFence = false
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const withoutCode = line.replace(/`[^`]*`/g, '')
    for (const match of withoutCode.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      links.push({ target: match[1], line: i + 1 })
    }
  }
  return links
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

let checked = 0
const broken = []

for (const file of collectMarkdownFiles()) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const { target, line } of extractLinks(text)) {
    if (ABSOLUTE.test(target)) continue
    let raw = target
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1)
    const cut = Math.min(
      ...[raw.indexOf('#'), raw.indexOf('?')].filter((index) => index !== -1).concat(raw.length),
    )
    raw = raw.slice(0, cut)
    if (raw.length === 0) continue
    checked += 1

    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      broken.push({ file, line, target, reason: 'malformed percent-encoding' })
      continue
    }

    const absolute = decoded.startsWith('/') ? join(root, decoded) : resolve(dirname(join(root, file)), decoded)
    if (!absolute.startsWith(root + sep) && absolute !== root) {
      broken.push({ file, line, target, reason: 'escapes the repository root' })
      continue
    }
    if (!existsSync(absolute)) {
      broken.push({ file, line, target, reason: `missing (${relative(root, absolute).split(sep).join('/')})` })
    }
  }
}

for (const item of broken) {
  console.error(`${item.file}:${item.line}: ${item.target} -> ${item.reason}`)
}
console.log(
  `doc links: ${collectMarkdownFiles().length} file(s), ${checked} link(s) checked, ${broken.length} broken`,
)
process.exitCode = broken.length === 0 ? 0 : 1
