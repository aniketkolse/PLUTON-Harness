/**
 * Protected-path pattern matching for the integration gate.
 *
 * Patterns and files are repo-relative; both sides are normalized (backslashes
 * to forward slashes, a leading `./` stripped) and matched case-sensitively
 * and verbatim:
 * - an empty pattern never matches;
 * - a plain path matches the exact file, or everything under it as a
 *   directory (`src/store` matches `src/store/store.ts`, never
 *   `src/storefront/x`);
 * - a trailing slash forces directory-prefix matching (`secrets/`);
 * - a pattern containing `*`, `**` or `?` is an anchored glob: `**` spans
 *   separators, `*` stays within one path segment and `?` matches exactly one
 *   non-separator character (the glob must match the whole path).
 */

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g

function normalize(input: string): string {
  let out = input.replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(REGEXP_SPECIALS, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** True when `file` (repo-relative, forward slashes) matches a protected-path pattern. */
export function matchProtectedPath(pattern: string, file: string): boolean {
  const normalizedPattern = normalize(pattern)
  const normalizedFile = normalize(file)
  if (normalizedPattern === '') return false
  if (/[*?]/.test(normalizedPattern)) return globToRegExp(normalizedPattern).test(normalizedFile)
  if (normalizedPattern.endsWith('/')) return normalizedFile.startsWith(normalizedPattern)
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`)
}
