import { join } from 'node:path'
import { copyAllowlistedEnv, copyPlatformEnv } from '../acp/env.ts'

/**
 * Environment for a Muse's Qwen Code process (ADR-0008).
 *
 * Verified against Qwen Code v0.25.2 (2026-10-16):
 * - `QWEN_DIR` relocates the CLI's entire state dir (`~/.qwen` equivalent:
 *   settings, oauth creds, sessions, projects) — probes with an isolated
 *   QWEN_DIR wrote nothing outside it.
 * - Home redirection (USERPROFILE/HOME) is applied as a second isolation
 *   layer, mirroring what the live probes used.
 * - Auth reaches the engine only through allowlisted variables: OPENAI_* /
 *   DASHSCOPE_* (an OpenAI-compatible endpoint or DashScope). No secret ever
 *   travels through Pluton config, argv, the database, events or logs.
 */

/** Credential-bearing variables Qwen Code understands (exact names from the v0.25.2 bundle). */
export const QWEN_AUTH_ENV_KEYS: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_BASE',
  'OPENAI_API_VERSION',
  'DASHSCOPE_API_KEY',
  'DASHSCOPE_BASE_URL',
]

export function qwenStateDir(configDir: string): string {
  return join(configDir, 'qwen')
}

export function buildQwenEnv(
  configDir: string,
  extra: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env = copyPlatformEnv(source)
  Object.assign(env, copyAllowlistedEnv(QWEN_AUTH_ENV_KEYS, source))
  env['QWEN_DIR'] = qwenStateDir(configDir)
  env['NO_COLOR'] = '1'
  if (platform === 'win32') env['USERPROFILE'] = configDir
  else env['HOME'] = configDir
  return { ...env, ...extra }
}
