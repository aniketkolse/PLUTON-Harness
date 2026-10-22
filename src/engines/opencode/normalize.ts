/**
 * Re-export shim: ACP update normalization is engine-generic and lives in
 * `src/engines/acp/normalize.ts` (shared ACP normalization).
 * Kept here so existing imports (tests included) stay stable.
 */
export {
  normalizeSessionUpdate,
  summarizePromptResult,
  type NormalizedUpdate,
  type NormalizeContext,
  type PromptOutcome,
  type PromptResultSummary,
} from '../acp/normalize.ts'
