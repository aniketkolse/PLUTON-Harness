/**
 * Environment construction for engine child processes (ADR-0008).
 *
 * Two rules apply to every engine:
 * 1. The engine gets a *sanitized allowlist* of the host environment — never
 *    the operator's full environment (tokens in unrelated variables, cloud
 *    credentials, etc. must not leak into an engine process).
 * 2. Per-Ship state directories (engine homes) are redirected into the Ship's
 *    private config dir so engines cannot read the user's global config and
 *    authentication is per-Ship.
 *
 * Secret material (API keys) reaches the engine only through explicitly
 * allowlisted environment variables supplied by the operator, never through
 * Pluton config files, argv, the database, events or logs (prompt §2.7).
 */

/** Platform essentials a Node CLI may need to function on Windows/POSIX. */
export const PLATFORM_ENV_KEEP: readonly string[] = [
  'PATH',
  'Path',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'WINDIR',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
]

/** Copy the platform-essential allowlist out of the host environment. */
export function copyPlatformEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PLATFORM_ENV_KEEP) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/**
 * Copy explicitly allowlisted variables (e.g. `OPENAI_*` credential names an
 * engine understands) from the host environment. Empty values are skipped so
 * an unset-but-present variable never reaches the engine as an empty string.
 */
export function copyAllowlistedEnv(
  keys: readonly string[],
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}
