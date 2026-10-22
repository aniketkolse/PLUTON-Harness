/**
 * Pure helpers for the Pluton release gate (`scripts/release-check.mjs`).
 *
 * Dependency-free and side-effect-free so classification, manifest parsing,
 * leak scanning, link checking and the publication-eligibility decision can be
 * unit-tested directly. The CLI keeps every filesystem/subprocess concern.
 */

/** Files that must be present in `npm pack` output for the CLI to run. */
export const REQUIRED_PACK_FILES = [
  'package.json',
  'bin/pluton.js',
  'dist/cli/main.js',
  'dist/server/static-assets.js',
  'docker/worker/Dockerfile',
  'templates/teams/full-stack.yaml',
  'templates/roles/manager.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
]

/**
 * Release-gate outcome states (docs/RELEASE.md):
 * - pass: the check ran and its acceptance criteria were met.
 * - fail: the check ran and found a real technical defect.
 * - not-tested: the check did not run here (platform/network/optional tool);
 *   no result is established and the reason plus remediation accompany it.
 * - blocked: an external prerequisite or owner decision prevents the check or
 *   the release itself.
 */
export const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NOT_TESTED: 'not-tested',
  BLOCKED: 'blocked',
})

const STATUS_TAGS = {
  pass: 'PASS',
  fail: 'FAIL',
  'not-tested': 'NOT TESTED',
  blocked: 'BLOCKED',
}

/**
 * Changed paths from `git status --porcelain` (v1) output. The leading two
 * status columns are stripped per line — never by trimming the whole output
 * first, which would eat the first path's leading character.
 */
export function parseChangedFiles(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(2).trimStart())
}

/** Parse the JSON array printed by `npm pack --dry-run --json`. */
export function parsePackManifest(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('npm pack --dry-run --json printed no JSON manifest')
  }
  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0]?.files)) {
    throw new Error('unexpected npm pack manifest shape')
  }
  return { files: parsed[0].files.map((f) => String(f.path)) }
}

/**
 * Combine stdout/stderr (fallback: message) of a failed subprocess into one
 * bounded, single-line detail. stderr is placed last so real error text wins.
 */
export function formatErrorDetail(err, maxLines = 6) {
  const parts = []
  if (err && typeof err === 'object') {
    if (err.stdout) parts.push(String(err.stdout))
    if (err.stderr) parts.push(String(err.stderr))
  }
  if (parts.length === 0) parts.push(err instanceof Error ? err.message : String(err))
  return parts
    .join('\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-maxLines)
    .join(' | ')
}

/** Packaged files that must never ship (tests, local state, databases, logs, tarballs). */
export function findForbiddenPackFiles(files) {
  const forbiddenDir = /(^|\/)(tests?|coverage|\.pluton|node_modules)(\/|$)/i
  const forbiddenFile = /(^|\/)(\.env(\..+)?|[^/]+\.(env|sqlite|sqlite3|db|log|tgz))$/i
  return files.filter((f) => forbiddenDir.test(f) || forbiddenFile.test(f))
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A literal path as a regex that tolerates both raw separators (`C:\Users\x`)
 * and source-escaped ones (`C:\\Users\\x` in string literals), plus `/`
 * variants — compiled JS keeps both shapes depending on the original source.
 */
function pathToFlexibleRegex(p) {
  const segments = p.split(/[\\/]+/).filter((s) => s !== '')
  const body = segments.map(escapeRegExp).join('[\\\\/]{1,2}')
  // Keep the leading separator for absolute POSIX paths. Without it, a
  // single-segment home such as `/root` becomes the bare word `root` and
  // false-positives on ordinary prose (`the root directory`) and identifiers.
  return /^[\\/]/.test(p) ? `[\\\\/]${body}` : body
}

/**
 * Content patterns that must not appear in packaged files: host-local absolute
 * paths (the running machine's home/checkout, plus OS-shaped user profiles)
 * and credential-looking strings. Documentation placeholders (`/Users/you`,
 * `C:\Users\user`, …) are excluded.
 */
export function buildLeakPatterns({ homeDir, repoRoot, platform = process.platform }) {
  const patterns = []
  const push = (label, regex) => patterns.push({ label, regex })
  push(
    'Windows user-profile path',
    /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!you\b|your\b|user\b|username\b|example\b|name\b|Default\b|Public\b|Default User\b)[^\\/\s"'`]+/,
  )
  push(
    'macOS user-home path',
    /\/Users\/(?!you\b|your\b|user\b|username\b|example\b|shared\b|name\b)[A-Za-z0-9._-]+\//,
  )
  const flags = platform === 'win32' ? 'i' : ''
  if (homeDir) push('local home directory', new RegExp(pathToFlexibleRegex(homeDir), flags))
  if (repoRoot) push('local checkout path', new RegExp(pathToFlexibleRegex(repoRoot), flags))
  push('OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}\b/)
  push('GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/)
  push('GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/)
  push('npm token', /\bnpm_[A-Za-z0-9]{30,}\b/)
  push('AWS access key id', /\bAKIA[0-9A-Z]{16}\b/)
  push('private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/)
  return patterns
}

/** Labels of every leak pattern matching `text` (empty when the text is clean). */
export function scanTextForLeaks(text, patterns) {
  const hits = []
  for (const { label, regex } of patterns) {
    if (regex.test(text)) hits.push(label)
  }
  return hits
}

/** Find readFile results whose content matches any leak pattern. */
export function findContentLeaks({ files, readFile, patterns }) {
  const findings = []
  for (const file of files) {
    let text
    try {
      text = readFile(file)
    } catch {
      continue // unreadable packaged entry: manifest check owns existence
    }
    for (const label of scanTextForLeaks(text, patterns)) {
      findings.push({ file, label })
    }
  }
  return findings
}

/**
 * Relative markdown links (README, THIRD_PARTY_NOTICES) whose target file is
 * missing from the repository. Absolute URLs, pure anchors and non-file
 * schemes are skipped. `exists` receives the decoded repo-relative target.
 */
export function findBrokenRelativeLinks(text, exists) {
  const missing = []
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = (m[1] ?? '').trim().split(/\s+/)[0]
    if (!raw) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    const target = raw.split('#')[0].split('?')[0]
    if (!target) continue
    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {
      // keep the raw target
    }
    if (!exists(decoded)) missing.push(decoded)
  }
  return [...new Set(missing)]
}

/** Deep-equality of dependency maps without importing npm's comparator. */
export function sameDepMap(a, b) {
  const norm = (v) => {
    if (v === undefined || v === null) return '{}'
    const out = {}
    for (const key of Object.keys(v).sort()) out[key] = v[key]
    return JSON.stringify(out)
  }
  return norm(a) === norm(b)
}

/** Roll recorded results up into counts, the technical verdict and the exit code. */
export function summarize(results) {
  const count = (status) => results.filter((r) => r.status === status).length
  const failed = count(STATUS.FAIL)
  return {
    total: results.length,
    passed: count(STATUS.PASS),
    failed,
    notTested: count(STATUS.NOT_TESTED),
    blocked: count(STATUS.BLOCKED),
    technical: failed === 0 ? 'PASS' : 'FAIL',
    exitCode: failed === 0 ? 0 : 1,
  }
}

/**
 * Publication eligibility is a separate decision from technical validation:
 * a failed check, an active dirty-tree override, and unresolved
 * owner/infrastructure blockers each block publication independently, and the
 * reason string names every condition that currently applies.
 */
export function evaluatePublication({ failed = 0, blocked = 0, dirtyOverride = false } = {}) {
  const reasons = []
  if (failed > 0) reasons.push(`${failed} technical check(s) failed`)
  if (dirtyOverride) reasons.push('--allow-dirty override in effect; re-run on the committed release tree')
  if (blocked > 0) reasons.push(`${blocked} owner/infrastructure blocker(s) unresolved`)
  if (reasons.length === 0) {
    return {
      eligible: true,
      reason: 'automated validation is green; publishing still requires explicit human approval (docs/RELEASE.md)',
    }
  }
  const suffix = failed > 0 || blocked > 0 ? '; do not publish' : ''
  return { eligible: false, reason: reasons.join('; ') + suffix }
}

/** One printable line per recorded result (plus an indented `fix:` hint). */
export function renderResultLine(result) {
  const tag = STATUS_TAGS[result.status] ?? String(result.status).toUpperCase()
  const line = `[${tag}] ${result.label}${result.detail ? ` — ${result.detail}` : ''}`
  return result.fix ? `${line}\n        fix: ${result.fix}` : line
}
