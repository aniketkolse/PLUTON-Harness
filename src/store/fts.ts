/**
 * Sanitize a user search string for SQLite FTS5 MATCH queries.
 *
 * Extracts word tokens (Unicode letters, numbers, hyphens, underscores) and quotes
 * each token with prefix-matching wildcard (`"token"*`) to prevent FTS5 syntax
 * errors on punctuation, boolean operators, quotes, or unbalanced parentheses.
 */
export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed === '') return ''

  const tokens = trimmed.match(/[\p{L}\p{N}_-]+/gu)
  if (!tokens || tokens.length === 0) return ''

  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' ')
}
