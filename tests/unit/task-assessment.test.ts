import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assessTask, allocateWorkers, assessmentToPromptSection } from '../../src/orchestrator/task-assessment.ts'

describe('task assessment (Phase 4 Batch 1)', () => {
  it('classifies a simple factual request as simple with one worker', () => {
    const a = assessTask({ goal: 'What is the default port?', maxConcurrentWorkers: 4 })
    expect(a.complexity).toBe('simple')
    expect(a.estimatedWorkers).toBe(1)
    expect(a.parallelizableUnits).toBe(1)
  })

  it('detects research signals', () => {
    const a = assessTask({ goal: 'Research and compare three database options', maxConcurrentWorkers: 4 })
    expect(a.requiredCapabilities).toContain('research')
    expect(a.requiredTools).toContain('search')
  })

  it('detects coding signals', () => {
    const a = assessTask({ goal: 'Implement a new endpoint and fix the bug', maxConcurrentWorkers: 4 })
    expect(a.requiredCapabilities).toContain('coding')
    expect(a.requiredTools).toContain('file_write')
  })

  it('detects testing signals and verification requirement', () => {
    const a = assessTask({ goal: 'Add unit tests and verify regression', maxConcurrentWorkers: 4 })
    expect(a.requiredCapabilities).toContain('testing')
    expect(a.verificationRequired).toBe(true)
  })

  it('bounds estimated workers by maxConcurrentWorkers', () => {
    const a = assessTask({ goal: 'Research A and research B and research C and research D', maxConcurrentWorkers: 2 })
    expect(a.estimatedWorkers).toBeLessThanOrEqual(2)
  })

  it('never returns zero workers', () => {
    const a = assessTask({ goal: '', maxConcurrentWorkers: 8 })
    expect(a.estimatedWorkers).toBeGreaterThanOrEqual(1)
  })

  it('allocateWorkers returns a bounded strategy', () => {
    const a = assessTask({ goal: 'Simple question', maxConcurrentWorkers: 4 })
    const alloc = allocateWorkers(a, 4)
    expect(alloc.workerCount).toBe(1)
    expect(alloc.strategy).toBe('single')
  })

  it('assessmentToPromptSection is bounded and includes key fields', () => {
    const a = assessTask({ goal: 'Implement X', maxConcurrentWorkers: 4 })
    const alloc = allocateWorkers(a, 4)
    const section = assessmentToPromptSection(a, alloc)
    expect(section).toContain('Complexity:')
    expect(section).toContain('Estimated useful workers:')
    expect(section.length).toBeLessThan(2000)
  })

  it('planning benchmark cases stay within expected bands', () => {
    const path = fileURLToPath(new URL('../benchmarks/planning-cases.json', import.meta.url))
    const cases = JSON.parse(readFileSync(path, 'utf8')) as Array<{
      id: string
      goal: string
      acceptance: string[]
      expectedComplexity: string[]
      expectedWorkers: [number, number]
      expectedCapabilities: string[]
    }>
    for (const c of cases) {
      const a = assessTask({ goal: c.goal, acceptanceCriteria: c.acceptance, maxConcurrentWorkers: 8 })
      expect(c.expectedComplexity, c.id).toContain(a.complexity)
      expect(a.estimatedWorkers, c.id).toBeGreaterThanOrEqual(c.expectedWorkers[0])
      expect(a.estimatedWorkers, c.id).toBeLessThanOrEqual(c.expectedWorkers[1])
      for (const cap of c.expectedCapabilities) {
        expect(a.requiredCapabilities, c.id).toContain(cap)
      }
    }
  })
})
