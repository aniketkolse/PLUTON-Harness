/** Type declarations for the embedded-asset verifier (plain ESM for `node`). */

export interface AssetVerificationResult {
  /** Names of every check that ran. */
  checks: string[]
  /** Human-readable descriptions of the checks that failed. */
  failures: string[]
}

/** Run every embedded-asset check against the served SPA assets. */
export function verifyAssets(): AssetVerificationResult
