import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatRun, type ChatPlan } from '../../src/cli/commands/chat.ts'
import { bootstrapStore } from '../../src/bootstrap.ts'
import type { ProjectContext } from '../../src/cli/context.ts'
import { loadConfig } from '../../src/config/load.ts'
import { NotFoundError, ValidationError } from '../../src/domain/errors.ts'
import { MockEngineAdapter } from '../../src/engines/mock/adapter.ts'
import { ScriptedIo } from '../helpers/scripted-io.ts'
import { stripAnsi } from '../../src/tui/width.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

const CONFIG_NATIVE = `version: 1
project:
  name: cli-chat-it
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
runtime:
  max_concurrent_workers: 2
  max_team_size: 4
  max_delegation_depth: 3
  max_child_tasks_per_task: 5
  max_tasks_per_run: 10
  max_run_minutes: 30
  default_task_minutes: 10
  default_cpu_limit: 2
  default_memory_mb: 2048
  max_retries_per_task: 1
  network_policy: open
  max_prompt_chars: 60000
  max_event_payload_chars: 8000
  max_tool_result_chars: 120000
  heartbeat_seconds: 30
muses:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.status
      - run.list
      - run.inspect
      - run.start
      - approvals.list
`

const CONFIG_LOCAL = CONFIG_NATIVE

function makeFixture(yaml = CONFIG_NATIVE): { ctx: ProjectContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pluton-chat-test-'))
  tmpDirs.push(dir)
  writeFileSync(join(dir, 'pluton.yaml'), yaml, 'utf8')
  const loaded = loadConfig(dir)
  return { ctx: { rootDir: dir, configPath: join(dir, 'pluton.yaml'), loaded }, dir }
}

describe('pluton chat CLI command', () => {
  it('resolves default supervisor muse when museRef is omitted', async () => {
    const { ctx } = makeFixture()
    const { plan } = await chatRun(ctx, { json: true })
    expect(plan.museSlug).toBe('supervisor')
    expect(plan.mode).toBe('native')
    expect(plan.resumed).toBe(false)
    expect(plan.messageCount).toBe(0)
    expect(plan.bridge).toBeNull()
  })

  it('throws NotFoundError when museRef does not exist', async () => {
    const { ctx } = makeFixture()
    await expect(chatRun(ctx, { museRef: 'nonexistent-muse', json: true })).rejects.toThrow(NotFoundError)
  })

  it('throws ValidationError when muse is disabled in config', async () => {
    const yamlWithOld = CONFIG_LOCAL + `  old-muse:
    display_name: Old Muse
    role: coder
    engine: mock
    model: mock/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    permissions:
      - project.status
`
    const { ctx, dir } = makeFixture(yamlWithOld)
    // Run once to sync into DB
    await chatRun(ctx, { json: true })

    // Now remove old-muse from pluton.yaml
    writeFileSync(join(dir, 'pluton.yaml'), CONFIG_LOCAL, 'utf8')
    const reloadedCtx: ProjectContext = {
      rootDir: dir,
      configPath: join(dir, 'pluton.yaml'),
      loaded: loadConfig(dir),
    }

    await expect(chatRun(reloadedCtx, { museRef: 'old-muse', json: true })).rejects.toThrow(ValidationError)
    await expect(chatRun(reloadedCtx, { museRef: 'old-muse', json: true })).rejects.toThrow(/disabled/)
  })

  it('--json returns exact plan without constructing adapter or starting engine', async () => {
    const { ctx } = makeFixture()
    const adapterSpy = vi.fn()
    const { exitCode, plan } = await chatRun(
      ctx,
      { json: true },
      { adapterFor: adapterSpy as any },
    )
    expect(exitCode).toBe(0)
    expect(adapterSpy).not.toHaveBeenCalled()
    expect(plan).toMatchObject({
      museSlug: 'supervisor',
      engineKind: 'mock',
      model: 'mock/model-a',
      mode: 'native',
      resumed: false,
      messageCount: 0,
      bridge: null,
    })
  })

  it('throws ValidationError on non-TTY without --json', async () => {
    const { ctx } = makeFixture()
    const nonTtyIo = new ScriptedIo()
    ;(nonTtyIo as any).isTty = false
    await expect(chatRun(ctx, {}, { io: nonTtyIo })).rejects.toThrow(ValidationError)
    await expect(chatRun(ctx, {}, { io: nonTtyIo })).rejects.toThrow(/interactive terminal/)
  })

  it('picks latest session on --continue and explicit session on --resume', async () => {
    const { ctx } = makeFixture()
    // First: create a session and add messages via plan
    const { plan: firstPlan } = await chatRun(ctx, { json: true })

    // Resume first session explicitly
    const { plan: resumePlan } = await chatRun(ctx, { resume: firstPlan.sessionId, json: true })
    expect(resumePlan.sessionId).toBe(firstPlan.sessionId)
    expect(resumePlan.resumed).toBe(true)

    // Continue should also pick firstPlan
    const { plan: continuePlan } = await chatRun(ctx, { continue: true, json: true })
    expect(continuePlan.sessionId).toBe(firstPlan.sessionId)
    expect(continuePlan.resumed).toBe(true)
  })

  it('throws NotFoundError on --resume with unknown session id', async () => {
    const { ctx } = makeFixture()
    await expect(chatRun(ctx, { resume: 'chat_unknown999', json: true })).rejects.toThrow(NotFoundError)
  })

  it('throws ValidationError on --resume for session belonging to another project', async () => {
    const { ctx } = makeFixture()
    const { store } = bootstrapStore(ctx.loaded)
    const foreignProj = store.ensureProject({
      name: 'foreign-proj',
      rootPath: join(ctx.rootDir, 'foreign-root'),
      configPath: join(ctx.rootDir, 'foreign-root', 'pluton.yaml'),
      defaultBranch: 'main',
    })
    const foreignSession = store.createChatSession({ projectId: foreignProj.id, museId: 'supervisor' })
    store.close()

    await expect(chatRun(ctx, { resume: foreignSession.id, json: true })).rejects.toThrow(ValidationError)
    await expect(chatRun(ctx, { resume: foreignSession.id, json: true })).rejects.toThrow(/another project/)
  })

  it('takes native adapter path and resolves native plan with no container', async () => {
    const { ctx } = makeFixture()
    const { plan } = await chatRun(ctx, { json: true })

    expect(plan.mode).toBe('native')
    expect(plan.containerName).toBeNull()
  })

  it('runs interactive loop: sends user prompt, receives response, handles /exit', async () => {
    const { ctx } = makeFixture()
    const io = new ScriptedIo()
    const adapter = new MockEngineAdapter({
      script: [
        {
          text: 'Operator proxy ready.',
          outcome: 'success',
        },
      ],
    })

    const runPromise = chatRun(
      ctx,
      {},
      {
        io,
        adapterFor: () => adapter,
      },
    )

    // Wait a tick for start() to finish
    await new Promise((r) => setTimeout(r, 30))

    io.send('Hello from test')
    await new Promise((r) => setTimeout(r, 50))

    expect(io.commits.some((c) => c.includes('Hello from test'))).toBe(true)
    expect(io.commits.some((c) => c.includes('Operator proxy ready.'))).toBe(true)
    // The You/PLUTON turn labels are rendered in frames, not committed as stream text.
    const frameText = io.frames.map((f) => stripAnsi(f.lines.join('\n'))).join('\n')
    expect(frameText).toMatch(/(?:👤|>)\s*You/)
    expect(frameText).toContain('PLUTON')

    io.send('/exit')
    const { exitCode } = await runPromise
    expect(exitCode).toBe(0)
  })
})
