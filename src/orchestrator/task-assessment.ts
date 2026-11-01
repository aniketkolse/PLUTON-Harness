import type { RunRecord } from '../domain/models.ts'

/**
 * Structured task assessment (Phase 4, Batch 1).
 *
 * A deterministic, code-level evaluation of a request. It is NOT a model
 * estimate and never becomes an unquestioned execution fact: it is recorded as
 * durable evidence (`run.assessed`) and compared against actual outcomes. The
 * manager receives it as a bounded signal and may follow or override it, but
 * every override is observable.
 */

export type TaskComplexity = 'simple' | 'moderate' | 'complex'
export type TaskCapability = 'research' | 'coding' | 'testing' | 'planning' | 'review'
export type ToolCategory = 'file_read' | 'file_write' | 'shell' | 'git' | 'search' | 'verification'
export type AllocationStrategy = 'single' | 'small_parallel' | 'bounded_parallel' | 'sequential_fallback'
export type AssessmentConfidence = 'high' | 'medium' | 'low'

export interface TaskAssessment {
  complexity: TaskComplexity
  estimatedWorkers: number
  requiredCapabilities: TaskCapability[]
  requiredTools: ToolCategory[]
  dependencyDepth: number
  parallelizableUnits: number
  verificationRequired: boolean
  resourceConstraints: { maxWorkers: number; maxTasks: number; maxDepth: number }
  confidence: AssessmentConfidence
  signals: string[]
}

export interface WorkerAllocation {
  workerCount: number
  strategy: AllocationStrategy
  reason: string
}

export interface AssessInput {
  goal: string
  acceptanceCriteria?: readonly string[]
  maxConcurrentWorkers: number
  maxTasks?: number
  maxDelegationDepth?: number
}

const RESEARCH_KW = ['research', 'investigate', 'analyze', 'explore', 'document', 'summarize', 'compare', 'find', 'understand', 'explain', 'audit', 'discover', 'study', 'inspect', 'gather', 'evidence']
const CODING_KW = ['implement', 'fix', 'bug', 'refactor', 'compile', 'build', 'function', 'class', 'endpoint', 'api', 'typescript', 'javascript', 'python', 'module', 'component', 'database', 'migration', 'deploy', 'lint', 'typecheck', 'code', 'edit', 'write']
const TESTING_KW = ['test', 'tests', 'spec', 'coverage', 'qa', 'verify', 'assert', 'regression', 'e2e', 'unit', 'integration', 'fixture', 'validation']
const PLANNING_KW = ['plan', 'coordinate', 'manage', 'supervise', 'orchestrate', 'delegate', 'schedule', 'roadmap', 'decompose', 'design']
const REVIEW_KW = ['review', 'inspect', 'audit', 'check']

const MULTI_STAGE_MARKERS = [' then ', ' after ', ' followed by ', ' and then ', ' first ', ' finally ', ' step ', ' stage ']
const PARALLEL_MARKERS = [' and ', ' plus ', ' also ', ' independently ', ' in parallel ', ' concurrently ', ' separate ']

function countHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase()
  let hits = 0
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) hits += 1
  }
  return hits
}

function splitUnits(text: string): number {
  // Count independent clauses/deliverables. Conservative: split on conjunctions
  // and commas, then require a verb-ish token to count as a unit.
  const parts = text.split(/[,;]|\band\b|\balso\b|\bplus\b/i).map((p) => p.trim()).filter((p) => p.length > 0)
  let units = 0
  for (const part of parts) {
    if (part.split(/\s+/).length >= 3) units += 1
  }
  return Math.max(1, units)
}

export function assessTask(input: AssessInput): TaskAssessment {
  const goal = input.goal ?? ''
  const criteria = input.acceptanceCriteria ?? []
  const text = `${goal}\n${criteria.join('\n')}`
  const lower = text.toLowerCase()
  const maxWorkers = Math.max(1, input.maxConcurrentWorkers)
  const maxTasks = input.maxTasks ?? 20
  const maxDepth = input.maxDelegationDepth ?? 3

  const signals: string[] = []
  const researchHits = countHits(text, RESEARCH_KW)
  const codingHits = countHits(text, CODING_KW)
  const testingHits = countHits(text, TESTING_KW)
  const planningHits = countHits(text, PLANNING_KW)
  const reviewHits = countHits(text, REVIEW_KW)

  if (researchHits > 0) signals.push(`research:${researchHits}`)
  if (codingHits > 0) signals.push(`coding:${codingHits}`)
  if (testingHits > 0) signals.push(`testing:${testingHits}`)
  if (planningHits > 0) signals.push(`planning:${planningHits}`)
  if (reviewHits > 0) signals.push(`review:${reviewHits}`)

  const multiStage = MULTI_STAGE_MARKERS.filter((m) => lower.includes(m)).length
  if (multiStage > 0) signals.push(`multi_stage:${multiStage}`)

  const parallelMarkers = PARALLEL_MARKERS.filter((m) => lower.includes(m)).length
  if (parallelMarkers > 0) signals.push(`parallel_markers:${parallelMarkers}`)

  const lengthSignal = goal.length > 400 ? 'long_goal' : goal.length > 120 ? 'medium_goal' : 'short_goal'
  signals.push(lengthSignal)

  const criteriaSignal = criteria.length > 3 ? 'many_criteria' : criteria.length > 0 ? 'some_criteria' : 'no_criteria'
  signals.push(criteriaSignal)

  const parallelUnits = Math.min(maxWorkers, splitUnits(goal))
  if (parallelUnits > 1) signals.push(`parallel_units:${parallelUnits}`)

  // Complexity classification
  let complexity: TaskComplexity = 'simple'
  const score =
    (researchHits + codingHits + testingHits + planningHits + reviewHits) +
    (multiStage * 2) +
    (criteria.length > 2 ? 2 : criteria.length > 0 ? 1 : 0) +
    (goal.length > 400 ? 2 : goal.length > 120 ? 1 : 0) +
    (parallelUnits > 2 ? 1 : 0)

  if (score >= 6) complexity = 'complex'
  else if (score >= 3) complexity = 'moderate'

  // Dependency depth estimate
  let dependencyDepth = 0
  if (multiStage > 0) dependencyDepth = Math.min(maxDepth, multiStage)
  if (complexity === 'complex' && dependencyDepth === 0) dependencyDepth = 1

  // Required capabilities
  const caps = new Set<TaskCapability>()
  if (researchHits > 0) caps.add('research')
  if (codingHits > 0) caps.add('coding')
  if (testingHits > 0) caps.add('testing')
  if (planningHits > 0) caps.add('planning')
  if (reviewHits > 0) caps.add('review')
  if (caps.size === 0) caps.add('research') // default: at least investigate
  const requiredCapabilities = [...caps]

  // Required tools
  const tools = new Set<ToolCategory>()
  if (researchHits > 0 || reviewHits > 0) tools.add('file_read')
  if (codingHits > 0) { tools.add('file_read'); tools.add('file_write'); tools.add('shell') }
  if (testingHits > 0) { tools.add('shell'); tools.add('verification') }
  if (reviewHits > 0) tools.add('git')
  if (codingHits > 0) tools.add('git')
  if (researchHits > 0) tools.add('search')
  if (tools.size === 0) tools.add('file_read')
  const requiredTools = [...tools]

  const verificationRequired = testingHits > 0 || codingHits > 0 || complexity === 'complex'

  // Confidence
  let confidence: AssessmentConfidence = 'low'
  const signalCount = signals.filter((s) => !s.endsWith('_goal') && !s.endsWith('_criteria')).length
  if (signalCount >= 3) confidence = 'high'
  else if (signalCount >= 1) confidence = 'medium'

  const estimatedWorkers = allocateWorkersInternal(complexity, parallelUnits, dependencyDepth, maxWorkers).workerCount

  return {
    complexity,
    estimatedWorkers,
    requiredCapabilities,
    requiredTools,
    dependencyDepth,
    parallelizableUnits: parallelUnits,
    verificationRequired,
    resourceConstraints: { maxWorkers, maxTasks, maxDepth },
    confidence,
    signals,
  }
}

function allocateWorkersInternal(
  complexity: TaskComplexity,
  parallelUnits: number,
  dependencyDepth: number,
  maxWorkers: number,
): WorkerAllocation {
  if (complexity === 'simple') {
    return { workerCount: 1, strategy: 'single', reason: 'simple request: single worker' }
  }
  if (parallelUnits <= 1) {
    return { workerCount: 1, strategy: 'single', reason: 'no independent units detected' }
  }
  if (complexity === 'moderate') {
    const count = Math.min(maxWorkers, Math.max(1, parallelUnits))
    return { workerCount: count, strategy: 'small_parallel', reason: `moderate request: ${String(parallelUnits)} independent units` }
  }
  // complex
  if (dependencyDepth > 2) {
    const count = Math.min(maxWorkers, Math.max(1, Math.min(2, parallelUnits)))
    return { workerCount: count, strategy: 'sequential_fallback', reason: 'complex but dependency-heavy: sequential fallback' }
  }
  const count = Math.min(maxWorkers, Math.max(1, parallelUnits))
  return { workerCount: count, strategy: 'bounded_parallel', reason: `complex request: ${String(parallelUnits)} independent units` }
}

export function allocateWorkers(assessment: TaskAssessment, maxConcurrentWorkers: number): WorkerAllocation {
  return allocateWorkersInternal(
    assessment.complexity,
    assessment.parallelizableUnits,
    assessment.dependencyDepth,
    Math.max(1, Math.min(maxConcurrentWorkers, assessment.resourceConstraints.maxWorkers)),
  )
}

export function assessmentToPromptSection(assessment: TaskAssessment, allocation: WorkerAllocation): string {
  return [
    'Task assessment (deterministic, evidence-backed; treat as a signal, not a command):',
    `- Complexity: ${assessment.complexity} (confidence: ${assessment.confidence})`,
    `- Estimated useful workers: ${String(allocation.workerCount)} (${allocation.strategy}) — ${allocation.reason}`,
    `- Parallelizable units: ${String(assessment.parallelizableUnits)}`,
    `- Dependency depth: ${String(assessment.dependencyDepth)}`,
    `- Required capabilities: ${assessment.requiredCapabilities.join(', ')}`,
    `- Required tools: ${assessment.requiredTools.join(', ')}`,
    `- Verification required: ${assessment.verificationRequired ? 'yes' : 'no'}`,
    `- Signals: ${assessment.signals.join(', ')}`,
  ].join('\n')
}

export function assessRun(run: RunRecord, maxConcurrentWorkers: number): { assessment: TaskAssessment; allocation: WorkerAllocation } {
  const assessment = assessTask({
    goal: run.goal,
    acceptanceCriteria: run.acceptanceCriteria,
    maxConcurrentWorkers,
    maxTasks: run.budget.maxTasks,
    maxDelegationDepth: run.budget.maxDelegationDepth,
  })
  const allocation = allocateWorkers(assessment, maxConcurrentWorkers)
  return { assessment, allocation }
}
