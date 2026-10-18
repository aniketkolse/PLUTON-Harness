import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

/**
 * Structural regression test for .github/workflows/ci.yml.
 *
 * The `yaml` parser validates the syntax; the assertions pin the properties
 * the release process depends on (platform matrix, read-only permissions, no
 * secrets, no publish steps). Actual workflow execution can only be verified
 * on GitHub runners — that remains NOT TESTED until the repository is pushed.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml')

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

interface WorkflowJob {
  'runs-on'?: string
  steps?: WorkflowStep[]
  strategy?: { matrix?: { os?: string[] } }
}

interface WorkflowDoc {
  on?: unknown
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

describe('ci workflow', () => {
  const text = readFileSync(workflowPath, 'utf8')
  const doc = parse(text) as WorkflowDoc

  it('is valid YAML with the expected triggers', () => {
    expect(doc).toBeTruthy()
    expect(doc.on).toBeTruthy()
    expect(Object.keys(doc.on as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['push', 'pull_request', 'workflow_dispatch']),
    )
  })

  it('uses least-privilege permissions and references no secrets', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
    expect(text).not.toContain('${{ secrets.')
    expect(text).not.toContain('NODE_AUTH_TOKEN')
  })

  it('runs the gate on Linux, macOS and Windows with Node 24', () => {
    const matrix = doc.jobs?.validate?.strategy?.matrix?.os ?? []
    expect(matrix).toEqual(expect.arrayContaining(['ubuntu-latest', 'macos-latest', 'windows-latest']))

    const steps = doc.jobs?.validate?.steps ?? []
    const setupNode = steps.find((s) => s.uses?.startsWith('actions/setup-node'))
    expect(setupNode?.with?.['node-version']).toBe(24)

    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'))
    expect(checkout?.with?.['persist-credentials']).toBe(false)

    const runs = steps.map((s) => s.run ?? '')
    expect(runs).toContain('npm ci')
    expect(runs).toContain('npm run release:check')
    expect(runs).toContain('npm run smoke:package')
  })

  it('runs the opt-in Docker/tmux E2E on Linux with an explicit flag', () => {
    const job = doc.jobs?.['e2e-docker']
    expect(job?.['runs-on']).toBe('ubuntu-latest')
    const e2eStep = (job?.steps ?? []).find((s) => s.run?.includes('vitest.e2e.config.ts'))
    expect(e2eStep).toBeTruthy()
    expect(e2eStep?.env?.['PLUTON_E2E_DOCKER']).toBe('1')
  })

  it('never publishes, tags or releases', () => {
    expect(text).not.toMatch(/npm\s+publish/)
    expect(text).not.toMatch(/gh\s+release/)
    expect(text).not.toMatch(/git\s+tag/)
    expect(text).not.toMatch(/git\s+push/)
  })
})
