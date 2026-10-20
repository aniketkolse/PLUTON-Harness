import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { decideApproval } from '../../src/cli/commands/approvals.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import type { LoadedConfig } from '../../src/config/load.ts'
import type { ApprovalRecord } from '../../src/domain/models.ts'
import { engineAdapterForMuse } from '../../src/engines/approval.ts'
import type { EngineEvent, StartSessionRequest } from '../../src/engines/contract/types.ts'
import { createEngineApprovalChannel, pendingApprovalWaiterCount } from '../../src/engines/interactive-approval.ts'
import type { QwenEngineSession } from '../../src/engines/qwen/adapter.ts'
import type { Store } from '../../src/store/store.ts'
import { FakeAcpAgent, fakeSpawn } from '../helpers/fake-acp-agent.ts'
import { loadQwenFrames, scriptQwen } from '../helpers/qwen-script.ts'

/**
 * Adapter → channel → store seam (post-P1 hardening): a REAL QwenEngineAdapter
 * over the fake ACP transport (recorded v0.25.2 frames), the REAL durable
 * approval channel and the REAL store, decided through the operator funnel
 * (`decideApproval`). Proves the wire answer, the durable rows and session
 * closure agree — including that a late permission request after closure can
 * never mint an actionable approval.
 */

const frames = loadQwenFrames()
const permissionParams = frames.permissionRequest as Record<string, unknown>
const permissionCallId = (permissionParams['toolCall'] as { toolCallId: string }).toolCallId
const rejectOption = (permissionParams['options'] as Array<{ kind?: string; optionId?: string }>).find(
  (o) => typeof o.kind === 'string' && o.kind.startsWith('reject'),
)

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

function makeProject(): { ctx: ProjectContext; store: Store; projectId: string; rootDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'pluton-engine-seam-'))
  tmpDirs.push(rootDir)
  const loaded: LoadedConfig = {
    rootDir,
    configPath: join(rootDir, 'pluton.yaml'),
    config: {
      version: 1,
      project: { name: 'engine-seam-p', repository: '.', default_branch: 'main', verification: [] },
      runtime: {
        max_concurrent_workers: 2,
        max_team_size: 2,
        max_delegation_depth: 2,
        max_child_tasks_per_task: 5,
        max_tasks_per_run: 10,
        max_run_minutes: 10,
        default_task_minutes: 5,
        default_cpu_limit: 1,
        default_memory_mb: 512,
        max_retries_per_task: 1,
        max_revisions_per_task: 1,
        network_policy: 'restricted',
        max_prompt_chars: 1000,
        max_event_payload_chars: 1000,
        max_tool_result_chars: 1000,
        heartbeat_seconds: 5,
        approval_timeout_minutes: 10,
      },
      sandbox: { kind: 'local-process', local_process_acknowledged: true },
      git: { protected_paths: [], require_approval_for_main_branch_integration: false },
      muses: {
        worker: {
          display_name: 'Worker',
          role: 'coder',
          engine: 'mock',
          model: 'mock/model',
          workspace_policy: 'isolated-task-checkout',
          approval_mode: 'ask-for-sensitive-actions',
        },
      },
    },
  }
  const { store, projectId } = bootstrapStore(loaded)
  const ctx: ProjectContext = { rootDir, configPath: loaded.configPath, loaded }
  return { ctx, store, projectId, rootDir }
}

interface Seam {
  agent: FakeAcpAgent
  state: ReturnType<typeof scriptQwen>
  session: QwenEngineSession
  requested: ApprovalRecord[]
  ctx: ProjectContext
  store: Store
  projectId: string
}

async function startSeam(overrides: {
  permissionOnPrompt?: boolean
  onRequested?: (approval: ApprovalRecord) => void
} = {}): Promise<Seam> {
  const { ctx, store, projectId, rootDir } = makeProject()
  const agent = new FakeAcpAgent()
  const state = scriptQwen(agent, {
    promptUpdates: [],
    ...(overrides.permissionOnPrompt === true ? { permissionOnPrompt: true } : {}),
  })
  const spawn = fakeSpawn(() => agent)
  // The production factory as a project-root session sees it (no proven
  // checkout → no isolatedCheckout): qwen autonomous-bounded must resolve to
  // `auto` + interactive operator asks, never a standalone allow_once.
  const adapter = engineAdapterForMuse(
    { engineKind: 'qwen', approvalMode: 'autonomous-bounded' },
    { spawnFn: spawn.spawnFn, binaryPath: join('C:', 'tools', 'qwen', 'cli-entry.js') },
  )

  const requested: ApprovalRecord[] = []
  const channel = createEngineApprovalChannel({
    store,
    projectId,
    runId: null,
    taskId: null,
    museId: 'muse_seam',
    // No background timers: these tests drive every settlement explicitly.
    ttlMinutes: 0,
    pollIntervalMs: 0,
    onRequested: (approval) => {
      requested.push(approval)
      overrides.onRequested?.(approval)
    },
  })

  const req: StartSessionRequest = {
    muse: { id: 'muse_seam', slug: 'worker-seam', role: 'coder', model: 'cbai/glm-5.2' },
    workdir: rootDir,
    env: {},
    configDir: join(rootDir, '.pluton', 'engine-homes', 'worker-seam'),
    approvals: channel,
  }
  const session = (await adapter.startSession(req)) as QwenEngineSession
  return { agent, state, session, requested, ctx, store, projectId }
}

describe('engine approval seam: adapter → channel → store', () => {
  it('turns a real engine permission request into a durable row that only the operator funnel approves', async () => {
    let resolveRequested!: (approval: ApprovalRecord) => void
    const requestedOnce = new Promise<ApprovalRecord>((resolve) => {
      resolveRequested = resolve
    })
    const seam = await startSeam({
      permissionOnPrompt: true,
      onRequested: (approval) => resolveRequested(approval),
    })

    const events: EngineEvent[] = []
    const consume = (async () => {
      for await (const event of seam.session.sendPrompt({ text: 'edit qwen2-write.txt', timeoutMs: 30_000 })) {
        events.push(event)
      }
    })()

    // The engine's ask became a durable, actionable pending record…
    const record = await requestedOnce
    expect(record).toMatchObject({
      action: 'engine.permission',
      status: 'pending',
      runId: null,
      requestedByMuseId: 'muse_seam',
    })
    expect(seam.store.getApproval(record.id).status).toBe('pending')
    expect(JSON.stringify(record.scope)).toContain('"toolKind":"edit"')

    // …and only the operator funnel (the CLI path) approves it.
    const report = await decideApproval(seam.ctx, { approvalRef: record.id, decision: 'approve' })
    expect(report.approval.status).toBe('approved')

    await consume
    const [wireId] = [...seam.state.serverRequests.keys()]
    const response = seam.agent.receivedResponses.find((m) => m.id === wireId)
    expect(response?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'proceed_once' } })
    expect(seam.session.approvalDecisions).toEqual([
      { requestId: permissionCallId, decision: 'allow_once(interactive)' },
    ])
    expect(events).toContainEqual({
      kind: 'approval_request',
      requestId: permissionCallId,
      description: expect.stringContaining('allow_once(interactive)'),
    })
    expect(events.at(-1)).toMatchObject({ kind: 'result', outcome: 'success' })
    expect(seam.store.getApproval(record.id).status).toBe('approved')
    expect(pendingApprovalWaiterCount()).toBe(0)

    await seam.session.close()
    seam.store.close()
  })

  it('settles a pending engine request fail-closed when the session closes', async () => {
    let resolveRequested!: (approval: ApprovalRecord) => void
    const requestedOnce = new Promise<ApprovalRecord>((resolve) => {
      resolveRequested = resolve
    })
    const seam = await startSeam({ onRequested: (approval) => resolveRequested(approval) })

    // A live engine ask held open by the real channel (same path the transport
    // drives; no prompt needed to exercise it).
    const answer = seam.session.handleServerRequest('session/request_permission', permissionParams)
    const record = await requestedOnce
    expect(seam.store.getApproval(record.id).status).toBe('pending')

    await seam.session.close()
    const settled = await answer
    expect(settled?.result).toEqual({ outcome: { outcome: 'selected', optionId: rejectOption?.optionId } })
    expect(seam.store.getApproval(record.id).status).toBe('expired')
    expect(seam.session.approvalDecisions).toEqual([{ requestId: permissionCallId, decision: 'deny(operator)' }])
    expect(pendingApprovalWaiterCount()).toBe(0)
    seam.store.close()
  })

  it('mints no actionable approval for a permission request that arrives after closure', async () => {
    const seam = await startSeam({})
    await seam.session.close()
    const before = seam.store.listApprovalsByProject(seam.projectId).length
    const baseWaiters = pendingApprovalWaiterCount()

    const late = await seam.session.handleServerRequest('session/request_permission', permissionParams)

    expect(seam.store.listApprovalsByProject(seam.projectId)).toHaveLength(before)
    expect(seam.requested).toHaveLength(0)
    expect(pendingApprovalWaiterCount()).toBe(baseWaiters)
    expect(late?.result).toEqual({ outcome: { outcome: 'selected', optionId: rejectOption?.optionId } })
    expect(seam.session.approvalDecisions).toEqual([{ requestId: permissionCallId, decision: 'deny(session closed)' }])
    seam.store.close()
  })
})
