import { normalizeFilePath } from '../orchestrator/lease-manager.ts'

export interface CheckExecutionEvidence {
  name: string
  command: readonly string[]
  status: 'passed' | 'failed'
  exitCode: number | null
  note?: string | null
}

export interface VerificationEvidence {
  changedFiles: string[]
  gitDiff: string
  checkResults: CheckExecutionEvidence[]
  workerClaims?: { outcome?: string; summary?: string }
}

export interface CriterionVerificationStatus {
  criterion: string
  status: 'verified' | 'failed' | 'unverified'
  evidence: string
}

export interface IndependentVerificationReport {
  verdict: 'verified' | 'failed' | 'unverified'
  tamperDetected: boolean
  tamperReasons: string[]
  sensitiveExposure: string[]
  criteria: CriterionVerificationStatus[]
  summary: string
  repairedNeeded?: boolean
}

const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pkcs12|pfx|p12)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml)$/i,
]

export function detectSensitiveFiles(files: string[]): string[] {
  const sensitive: string[] = []
  for (const f of files) {
    const norm = normalizeFilePath(f)
    const base = norm.split('/').pop() ?? norm
    if (SENSITIVE_PATTERNS.some((p) => p.test(base))) {
      sensitive.push(f)
    }
  }
  return sensitive
}

export function detectTestTampering(diff: string, changedFiles: string[]): { tampered: boolean; reasons: string[] } {
  const reasons: string[] = []

  // 1. Check for deleted test files
  const testFiles = changedFiles.filter((f) => /test|spec/i.test(f))
  for (const tf of testFiles) {
    const deletedRegex = new RegExp(`diff --git a/${tf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} b/dev/null`, 'i')
    if (deletedRegex.test(diff) || diff.includes(`--- a/${tf}\n+++ /dev/null`)) {
      reasons.push(`Deleted test file: '${tf}'`)
    }
  }

  // 2. Scan added lines in diff for disabled or weakened test assertions
  const lines = diff.split('\n')
  let currentFile = testFiles.length === 1 ? testFiles[0]! : ''

  for (const line of lines) {
    if (line.startsWith('diff --git a/')) {
      const match = line.match(/diff --git a\/(.+?) b\//)
      currentFile = match ? match[1] ?? '' : ''
      continue
    }

    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const addedContent = line.slice(1).trim()

    const isTestFile = currentFile ? /test|spec/i.test(currentFile) : testFiles.length > 0
    if (isTestFile) {
      if (/\b(it|test|describe)\.skip\b/.test(addedContent)) {
        reasons.push(`Disabled/skipped test added in '${currentFile || 'test file'}': ${addedContent}`)
      } else if (/\b(xit|xtest|xdescribe)\b/.test(addedContent)) {
        reasons.push(`Disabled test (xit/xtest) added in '${currentFile || 'test file'}': ${addedContent}`)
      } else if (/^\/\/\s*expect\(/.test(addedContent) || /^\/\*\s*expect\(/.test(addedContent)) {
        reasons.push(`Commented out test assertion in '${currentFile || 'test file'}': ${addedContent}`)
      }
    }
  }

  return {
    tampered: reasons.length > 0,
    reasons,
  }
}

export class IndependentVerifier {
  verifyCriteria(
    goal: string,
    acceptanceCriteria: string[],
    evidence: VerificationEvidence,
  ): IndependentVerificationReport {
    const sensitive = detectSensitiveFiles(evidence.changedFiles)
    const tampering = detectTestTampering(evidence.gitDiff, evidence.changedFiles)

    const criteriaStatuses: CriterionVerificationStatus[] = []
    const allChecksPassed =
      evidence.checkResults.length > 0 && evidence.checkResults.every((c) => c.status === 'passed')
    const anyCheckFailed = evidence.checkResults.some((c) => c.status === 'failed')

    // If tampering detected or sensitive files exposed, hard failure immediately
    if (tampering.tampered || sensitive.length > 0) {
      for (const c of acceptanceCriteria) {
        criteriaStatuses.push({
          criterion: c,
          status: 'failed',
          evidence: tampering.tampered
            ? `Failed due to test tampering: ${tampering.reasons.join('; ')}`
            : `Failed due to sensitive file exposure: ${sensitive.join(', ')}`,
        })
      }
      return {
        verdict: 'failed',
        tamperDetected: tampering.tampered,
        tamperReasons: tampering.reasons,
        sensitiveExposure: sensitive,
        criteria: criteriaStatuses,
        summary: tampering.tampered ? 'Verification failed: test tampering detected' : 'Verification failed: sensitive file exposure',
      }
    }

    // If no changes were made and no checks ran
    if (evidence.changedFiles.length === 0 && evidence.checkResults.length === 0) {
      for (const c of acceptanceCriteria) {
        criteriaStatuses.push({
          criterion: c,
          status: 'unverified',
          evidence: 'No code changes recorded in workspace diff and no verification checks executed',
        })
      }
      return {
        verdict: 'unverified',
        tamperDetected: false,
        tamperReasons: [],
        sensitiveExposure: [],
        criteria: criteriaStatuses,
        summary: 'Cannot verify completion: no code diff and no checks executed',
      }
    }

    // Evaluate each acceptance criterion against code diff and test evidence
    for (const c of acceptanceCriteria) {
      const lower = c.toLowerCase()
      const isTestCriterion = lower.includes('test') || lower.includes('pass') || lower.includes('check')

      if (isTestCriterion) {
        if (anyCheckFailed) {
          criteriaStatuses.push({
            criterion: c,
            status: 'failed',
            evidence: 'Verification test checks failed',
          })
        } else if (allChecksPassed) {
          criteriaStatuses.push({
            criterion: c,
            status: 'verified',
            evidence: `Passed verification checks (${evidence.checkResults.map((r) => r.name).join(', ')})`,
          })
        } else {
          criteriaStatuses.push({
            criterion: c,
            status: 'unverified',
            evidence: 'No test check evidence executed for this criterion',
          })
        }
      } else {
        // Feature criterion: check if relevant checks passed or files exist in changedFiles
        if (anyCheckFailed) {
          criteriaStatuses.push({
            criterion: c,
            status: 'failed',
            evidence: 'Implementation failed verification test suite',
          })
        } else if (allChecksPassed || evidence.changedFiles.length > 0) {
          criteriaStatuses.push({
            criterion: c,
            status: 'verified',
            evidence: allChecksPassed
              ? `Verified across checks (${evidence.checkResults.map((r) => r.name).join(', ')})`
              : `Implemented across ${evidence.changedFiles.length} file(s) with clean diff`,
          })
        } else {
          criteriaStatuses.push({
            criterion: c,
            status: 'unverified',
            evidence: 'Insufficient diff or check evidence',
          })
        }
      }
    }

    const hasFailed = criteriaStatuses.some((c) => c.status === 'failed')
    const allVerified =
      (criteriaStatuses.length > 0 && criteriaStatuses.every((c) => c.status === 'verified')) ||
      (criteriaStatuses.length === 0 && allChecksPassed)

    let verdict: 'verified' | 'failed' | 'unverified' = 'unverified'
    if (hasFailed) {
      verdict = 'failed'
    } else if (allVerified) {
      verdict = 'verified'
    }

    return {
      verdict,
      tamperDetected: false,
      tamperReasons: [],
      sensitiveExposure: [],
      criteria: criteriaStatuses,
      summary: `${criteriaStatuses.filter((c) => c.status === 'verified').length}/${criteriaStatuses.length} criteria verified independently`,
    }
  }
}
