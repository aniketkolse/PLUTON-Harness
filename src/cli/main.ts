/**
 * Pluton-Harness CLI entry point.
 *
 * Conventions (prompt §1.1):
 * - `--json` (or PLUTON_JSON=1) switches a command to machine mode: stdout is
 *   exactly one JSON envelope ({ ok, data } | { ok, error }), diagnostics and
 *   human progress stay on stderr, exit code still reflects success/failure.
 * - Commands that are not implemented yet are registered as explicit stubs so
 *   scripts fail with a stable `not_implemented` code instead of a usage error.
 */
import { join } from 'node:path'
import { Command } from 'commander'
import { ConfigError, InternalError, NotImplementedError, PlutonError, ValidationError } from '../domain/errors.ts'
import { stateDir } from '../config/load.ts'
import { TERMINAL_TASK_STATES } from '../domain/state.ts'
import { registerBuiltinEngines } from '../engines/registry.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict, runVerificationChecks } from '../verify/runner.ts'
import { PLUTON_VERSION } from '../version.ts'
import { bootstrapStore } from '../bootstrap.ts'
import { requireProject } from './context.ts'
import { collectDoctorChecks, doctorExitCode } from './commands/doctor.ts'
import { runInit, type TeamTemplate } from './commands/init.ts'
import { mcpServe } from './commands/mcp.ts'
import { runRun } from './commands/run.ts'
import { createMuse, editMuse, engineList, listMuses, modelList, showMuse } from './commands/muse.ts'
import { sandboxBuildImage, sandboxProbe } from './commands/sandbox.ts'
import { DEFAULT_WORKER_IMAGE_TAG, type WorkerImageProfile } from '../sandbox/image.ts'
import {
  graphHuman,
  graphView,
  runByRef,
  runDetail,
  runLine,
  statusRuns,
  taskById,
  taskListHuman,
} from './commands/status.ts'
import { emitOk, renderChecks, runCommand, stdIo, summarizeChecks, table } from './output.ts'

const TEAM_TEMPLATES: readonly TeamTemplate[] = ['full-stack', 'bugfix', 'repository-analysis']

registerBuiltinEngines()

const program = new Command()
  .name('pluton')
  .description(
    'Pluton-Harness: a local-first control plane coordinating a team of AI coding Muses ' +
      'across different engines, models, workspaces and terminals.',
  )
  .version(PLUTON_VERSION)
  .option('--json', 'machine-readable output: one JSON document on stdout (also via PLUTON_JSON=1)')

const io = stdIo

function jsonMode(cmd: Command): boolean {
  const opts = cmd.optsWithGlobals() as { json?: boolean }
  return opts.json === true || process.env.PLUTON_JSON === '1' || process.env.PLUTON_JSON === 'true'
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

program
  .command('version')
  .description('print version and runtime information')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const data = {
        name: 'pluton-harness',
        version: PLUTON_VERSION,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      }
      emitOk(io, json, `pluton-harness ${data.version} (node ${data.node}, ${data.platform})`, data)
    })
  })

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('check the environment: Node, WSL2, Docker, git, project config, engine installs')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const checks = await collectDoctorChecks({ cwd: process.cwd() })
      const summary = summarizeChecks(checks)
      emitOk(
        io,
        json,
        `${renderChecks(checks)}\n\n${summary.pass} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`,
        { checks, summary },
      )
      return doctorExitCode(checks)
    })
  })

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('create pluton.yaml + role prompts from a team template (never overwrites existing files)')
  .option('--team <template>', `team template: ${TEAM_TEMPLATES.join(' | ')}`, 'full-stack')
  .option('--name <name>', 'project name (default: repository directory name)')
  .action(async (opts: { team: string; name?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      if (!TEAM_TEMPLATES.includes(opts.team as TeamTemplate)) {
        throw new ValidationError(
          `unknown team template '${opts.team}'; available: ${TEAM_TEMPLATES.join(', ')}`,
        )
      }
      const result = await runInit({
        cwd: process.cwd(),
        team: opts.team as TeamTemplate,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
      })
      const human = [
        `Initialized Pluton project in ${result.rootDir} (team: ${result.team})`,
        result.createdFiles.length > 0 ? `created:\n${result.createdFiles.map((f) => `  ${f}`).join('\n')}` : '',
        result.skippedFiles.length > 0
          ? `skipped (already existed):\n${result.skippedFiles.map((f) => `  ${f}`).join('\n')}`
          : '',
        result.gitignoreUpdated ? 'updated .gitignore with private runtime paths' : '',
        result.notes.map((n) => `note: ${n}`).join('\n'),
      ]
        .filter((s) => s.length > 0)
        .join('\n')
      emitOk(io, json, human, result)
    })
  })

// ---------------------------------------------------------------------------
// muse
// ---------------------------------------------------------------------------

const museCmd = program.command('muse').description('inspect and configure Muses (team members)')

museCmd
  .command('list')
  .description('list configured Muses')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const muses = listMuses(ctx.loaded.config)
      const manager = muses.find((m) => m.role === 'supervisor') ?? null
      const rows: string[][] = [['ID', 'NAME', 'ROLE', 'ENGINE', 'MODEL', 'WORKSPACE']]
      for (const m of muses) {
        rows.push([m.id, m.displayName, m.role, m.engine, m.model, m.workspacePolicy])
      }
      const human =
        muses.length === 0
          ? 'no muses configured — edit pluton.yaml or run `pluton muse create`'
          : `${table(rows)}\n\nmanager: ${manager ? manager.id : '(none — a run cannot start)'}`
      emitOk(io, json, human, { muses, manager: manager?.id ?? null, count: muses.length })
    })
  })

museCmd
  .command('show <muse>')
  .description('show one Muse: config, engine install, auth, instructions file')
  .action(async (museId: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const detail = await showMuse(ctx, museId)
      const lines = [
        `muse:        ${detail.id} (${detail.displayName})`,
        `role:        ${detail.role}`,
        `engine:      ${detail.engine}${detail.discovery ? ` — ${detail.discovery.installed ? 'installed' : 'NOT installed'}` : ' — unknown engine kind'}`,
        `model:       ${detail.model}`,
        `workspace:   ${detail.workspacePolicy}`,
        `approval:    ${detail.approvalMode}`,
        `permissions: ${detail.permissions.length > 0 ? detail.permissions.join(', ') : '(default)'}`,
        `engine home: ${detail.engineHome}`,
        `instructions: ${detail.instructionsPath ?? '(none)'}${detail.instructionsExists === false ? ' — FILE MISSING' : ''}`,
        detail.auth ? `auth:        ${detail.auth.configured ? 'configured' : `NOT configured — ${detail.auth.hint}`}` : '',
      ].filter((s) => s.length > 0)
      emitOk(io, json, lines.join('\n'), detail)
    })
  })

museCmd
  .command('create <id>')
  .description('add a Muse to pluton.yaml (validated before the file is touched)')
  .requiredOption('--engine <kind>', 'engine kind (see `pluton engine list`)')
  .requiredOption('--model <model>', 'exact provider-qualified model id for that engine')
  .option('--display-name <name>', 'human display name (default: id)')
  .option('--role <role>', 'supervisor | researcher | coder | tester | reviewer | custom', 'custom')
  .option('--instructions-file <path>', 'role prompt file, relative to the project root')
  .option('--workspace-policy <policy>', 'coordinator-read-only | read-only | isolated-task-checkout')
  .option('--approval-mode <mode>', 'autonomous-bounded | ask-for-sensitive-actions | ask-always')
  .option('--permission <permission...>', 'grant a permission (repeatable)')
  .action(
    async (
      museId: string,
      opts: {
        engine: string
        model: string
        displayName?: string
        role: string
        instructionsFile?: string
        workspacePolicy?: string
        approvalMode?: string
        permission?: string[]
      },
      cmd: Command,
    ) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const result = createMuse(ctx, {
          id: museId,
          engine: opts.engine,
          model: opts.model,
          ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
          ...(opts.role !== undefined ? { role: opts.role } : {}),
          ...(opts.instructionsFile !== undefined ? { instructionsFile: opts.instructionsFile } : {}),
          ...(opts.workspacePolicy !== undefined ? { workspacePolicy: opts.workspacePolicy } : {}),
          ...(opts.approvalMode !== undefined ? { approvalMode: opts.approvalMode } : {}),
          ...(opts.permission !== undefined ? { permissions: opts.permission } : {}),
        })
        emitOk(
          io,
          json,
          `created muse '${museId}' in ${result.configPath}\nrun \`pluton doctor\` to verify engine install and auth`,
          { museId, muse: result.muse, configPath: result.configPath },
        )
      })
    },
  )

museCmd
  .command('edit <muse>')
  .description('change fields of an existing Muse in pluton.yaml (validated before writing)')
  .option('--display-name <name>', 'human display name')
  .option('--role <role>', 'supervisor | researcher | coder | tester | reviewer | custom')
  .option('--engine <kind>', 'engine kind (see `pluton engine list`)')
  .option('--model <model>', 'exact provider-qualified model id')
  .option('--instructions-file <path>', 'role prompt file, relative to the project root')
  .option('--workspace-policy <policy>', 'coordinator-read-only | read-only | isolated-task-checkout')
  .option('--approval-mode <mode>', 'autonomous-bounded | ask-for-sensitive-actions | ask-always')
  .option('--permission <permission...>', 'replace the permission list with these values (repeatable)')
  .action(
    async (
      museId: string,
      opts: {
        displayName?: string
        role?: string
        engine?: string
        model?: string
        instructionsFile?: string
        workspacePolicy?: string
        approvalMode?: string
        permission?: string[]
      },
      cmd: Command,
    ) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const result = editMuse(ctx, museId, {
          ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
          ...(opts.role !== undefined ? { role: opts.role } : {}),
          ...(opts.engine !== undefined ? { engine: opts.engine } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.instructionsFile !== undefined ? { instructionsFile: opts.instructionsFile } : {}),
          ...(opts.workspacePolicy !== undefined ? { workspacePolicy: opts.workspacePolicy } : {}),
          ...(opts.approvalMode !== undefined ? { approvalMode: opts.approvalMode } : {}),
          ...(opts.permission !== undefined ? { permissions: opts.permission } : {}),
        })
        emitOk(
          io,
          json,
          `updated muse '${museId}' (${result.changed.join(', ')}) in ${result.configPath}`,
          { museId, changed: result.changed, muse: result.muse, configPath: result.configPath },
        )
      })
    },
  )

const museModelCmd = museCmd.command('model').description('model catalogue of a Muse\'s engine')

museModelCmd
  .command('list <muse>')
  .description('list model ids the Muse\'s engine reports (fails when the engine cannot list models)')
  .action(async (museId: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const models = await modelList(ctx, museId)
      const muse = ctx.loaded.config.muses[museId]
      const engine = muse ? muse.engine : 'unknown'
      const rows: string[][] = [['MODEL ID', 'LABEL', 'SOURCE']]
      for (const m of models) rows.push([m.id, m.label ?? '', m.source])
      const human =
        models.length === 0
          ? `engine '${engine}' reported no models`
          : `${table(rows)}\n\nset one with: pluton muse edit ${museId} --model <MODEL ID>`
      emitOk(io, json, human, { muse: museId, engine, models })
    })
  })

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

const engineCmd = program.command('engine').description('inspect engine adapters')

engineCmd
  .command('list')
  .description('list registered engine kinds with install status (honest: dev-only engines are labeled)')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const engines = await engineList()
      const rows: string[][] = [['KIND', 'DEV-ONLY', 'INSTALLED', 'VERSION', 'DESCRIPTION']]
      for (const e of engines) {
        rows.push([
          e.kind,
          e.devOnly ? 'yes' : 'no',
          e.discovery ? (e.discovery.installed ? 'yes' : 'no') : '?',
          e.discovery?.version ?? '',
          e.description,
        ])
      }
      emitOk(io, json, table(rows), { engines })
    })
  })

// ---------------------------------------------------------------------------
// sandbox — substrate probe and worker image (Phase 5, ADR-0004)
// ---------------------------------------------------------------------------

const sandboxCmd = program
  .command('sandbox')
  .description('probe the sandbox substrate (Docker) and provision the worker image')

sandboxCmd
  .command('probe')
  .description('report whether Muse containers can start here, and the worker image state')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await sandboxProbe(ctx)
      const lines = [
        `sandbox: ${report.sandbox.kind} — ${report.sandbox.available ? 'available' : 'UNAVAILABLE'}`,
        `detail:  ${report.sandbox.detail}`,
        report.image ? `image:   ${report.image.image} — ${report.image.detail}` : '',
        ...report.warnings.map((w) => `warning: ${w}`),
        report.dispatchReady ? 'dispatch: ready' : 'dispatch: NOT ready',
      ].filter((s) => s.length > 0)
      emitOk(io, json, lines.join('\n'), report)
      return report.dispatchReady ? 0 : 1
    })
  })

sandboxCmd
  .command('build-image')
  .description('build the worker image, verify tmux/node inside it, and record the image id')
  .option('--tag <tag>', `image tag (default: sandbox.image from pluton.yaml, else ${DEFAULT_WORKER_IMAGE_TAG})`)
  .option('--base <ref>', 'override the base image, e.g. an exact digest reference')
  .option('--engines', 'engines profile: also install the pinned engine CLIs for container-mode runs')
  .action(async (opts: { tag?: string; base?: string; engines?: boolean }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { record, configTagMismatch } = await sandboxBuildImage(ctx, {
        ...(opts.tag !== undefined ? { tag: opts.tag } : {}),
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        ...(opts.engines === true ? { profile: 'engines' satisfies WorkerImageProfile } : {}),
      })
      const human = [
        `built ${record.image}`,
        `image id: ${record.imageId}`,
        `profile: ${record.profile}`,
        `tmux: ${record.tmuxVersion}   node: ${record.nodeVersion}`,
        'recorded in .pluton/state/worker-image.json',
        record.profile === 'engines'
          ? ''
          : 'note: container-mode runs need the engines profile — rebuild with `pluton sandbox build-image --engines`',
        configTagMismatch
          ? `note: pluton.yaml pins a different tag — set sandbox.image: ${record.image} to use this build`
          : '',
      ].filter((s) => s.length > 0)
      emitOk(io, json, human.join('\n'), record)
    })
  })

// ---------------------------------------------------------------------------
// status / task / graph — read durable state (Phase 3)
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('show recent runs and their task-state counts from durable state')
  .option('--run <id>', 'show one run in detail (full id or unique suffix)')
  .option('--limit <n>', 'how many runs to list (default 10)', '10')
  .action(async (opts: { run?: string; limit: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const limit = Number.parseInt(opts.limit, 10)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ValidationError('--limit must be an integer between 1 and 500')
      }
      const { store } = bootstrapStore(ctx.loaded)
      try {
        if (opts.run !== undefined) {
          const run = runByRef(store, opts.run)
          const detail = runDetail(store, run.id)
          const counts = Object.entries(detail.summary.taskCounts)
            .map(([state, n]) => `${state}:${n}`)
            .join('  ')
          const human = [
            `run      ${detail.summary.run.id}`,
            `goal     ${detail.summary.run.goal}`,
            `state    ${detail.summary.run.state}`,
            `manager  ${detail.summary.run.managerMuseId}`,
            `budget   max_tasks=${detail.summary.run.budget.maxTasks} depth=${detail.summary.run.budget.maxDelegationDepth} workers=${detail.summary.run.budget.maxConcurrentWorkers}`,
            `tasks    ${detail.summary.totalTasks}${counts ? ` (${counts})` : ''}`,
            `events   ${detail.recentEvents.length} most recent`,
            ...detail.recentEvents.map((e) => `  #${e.seq} ${e.type}${e.taskId ? ` task=${e.taskId.slice(-8)}` : ''}`),
          ].join('\n')
          emitOk(io, json, human, detail)
        } else {
          const runs = statusRuns(store, limit)
          const human =
            runs.length === 0
              ? 'no runs recorded yet (create one with `pluton run --goal <text>`)'
              : runs
                  .map((s) => {
                    const counts = Object.entries(s.taskCounts)
                      .map(([state, n]) => `${state}:${n}`)
                      .join(' ')
                    return `${runLine(s.run)}${counts ? `  [${counts}]` : ''}`
                  })
                  .join('\n')
          emitOk(io, json, human, { runs })
        }
      } finally {
        store.close()
      }
    })
  })

const taskCmd = program.command('task').description('inspect tasks recorded in durable state')

taskCmd
  .command('list <run>')
  .description('list tasks of a run (full run id or unique suffix)')
  .action(async (runRef: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { store } = bootstrapStore(ctx.loaded)
      try {
        const run = runByRef(store, runRef)
        const tasks = store.listTasks(run.id)
        emitOk(io, json, taskListHuman(tasks), { runId: run.id, count: tasks.length, tasks })
      } finally {
        store.close()
      }
    })
  })

taskCmd
  .command('show <task>')
  .description('show one task with its dependencies (full id or unique suffix)')
  .action(async (taskRef: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { store } = bootstrapStore(ctx.loaded)
      try {
        const task = taskById(store, taskRef)
        const edges = store.listEdges(task.runId).filter(
          (e) => e.fromTaskId === task.id || e.toTaskId === task.id,
        )
        const human = [
          `task      ${task.id}`,
          `title     ${task.title}`,
          `state     ${task.state} (attempt ${task.attempt})`,
          `run       ${task.runId}`,
          `parent    ${task.parentTaskId ?? '(root)'}   depth ${task.depth}`,
          `assignee  ${task.assigneeMuseId ?? '(unassigned)'}`,
          `workspace ${task.workspaceId ?? '(none)'}`,
          `engine    session ${task.engineSessionId ?? '(none)'}`,
          `created   ${task.createdAt}`,
          task.startedAt ? `started   ${task.startedAt}` : '',
          task.completedAt ? `completed ${task.completedAt}` : '',
          task.acceptanceCriteria.length > 0
            ? `acceptance:\n${task.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`
            : '',
          edges.length > 0
            ? `edges:\n${edges
                .map((e) => `  ${e.fromTaskId.slice(-8)} --${e.kind}--> ${e.toTaskId.slice(-8)}`)
                .join('\n')}`
            : '',
          task.result !== null ? `result: ${JSON.stringify(task.result)}` : '',
          task.failure !== null ? `failure: ${JSON.stringify(task.failure)}` : '',
          '',
          `brief:\n${task.brief}`,
        ]
          .filter((s) => s.length > 0)
          .join('\n')
        emitOk(io, json, human, { task, edges })
      } finally {
        store.close()
      }
    })
  })

program
  .command('graph <run>')
  .description('show the delegation + dependency graph of a run (full run id or unique suffix)')
  .action(async (runRef: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { store } = bootstrapStore(ctx.loaded)
      try {
        const run = runByRef(store, runRef)
        const view = graphView(store, run.id)
        emitOk(io, json, graphHuman(view), view)
      } finally {
        store.close()
      }
    })
  })

// ---------------------------------------------------------------------------
// mcp — the restricted tool bridge as a standalone stdio server (ADR-0007).
// stdout is the MCP protocol channel here: no emitOk/runCommand, no tables.
// ---------------------------------------------------------------------------

const mcpCmd = program
  .command('mcp')
  .description('engine-facing restricted tool bridge (internal; stdout carries the protocol)')

mcpCmd
  .command('serve')
  .description('serve Pluton tools over stdio for one engine session (--run/--muse, optional --task)')
  .requiredOption('--run <id>', 'run id (full or unique suffix)')
  .requiredOption('--muse <id>', 'calling Muse id or slug')
  .option('--task <id>', 'task id for a task-scoped session (omit for manager scope)')
  .action(async (opts: { run: string; muse: string; task?: string }) => {
    try {
      const ctx = requireProject(process.cwd())
      await mcpServe(ctx, {
        runRef: opts.run,
        museRef: opts.muse,
        ...(opts.task !== undefined ? { taskRef: opts.task } : {}),
      })
    } catch (e) {
      const err =
        e instanceof PlutonError ? e : new InternalError(e instanceof Error ? e.message : String(e))
      process.stderr.write(`pluton mcp serve: ${err.code}: ${err.message}\n`)
      process.exitCode = 1
    }
  })

// ---------------------------------------------------------------------------
// verify — run the project verification checks and record the verdict
// (Phase 7: the only path from `verifying` to `completed`)
// ---------------------------------------------------------------------------

program
  .command('verify')
  .description('run the project verification checks for a run and record the verdict (verifying → completed|failed)')
  .requiredOption('--run <id>', 'run id (full id or unique suffix)')
  .option('--task <id>', 'verify exactly one task (must be in verifying)')
  .action(async (opts: { run: string; task?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { store, projectId } = bootstrapStore(ctx.loaded)
      try {
        const run = runByRef(store, opts.run)
        const checks = ctx.loaded.config.project.verification
        if (checks.length === 0) {
          throw new ConfigError(
            'no verification checks are configured under project.verification in pluton.yaml; refusing to verify without evidence',
          )
        }
        const targets =
          opts.task !== undefined
            ? [taskById(store, opts.task)]
            : store.listTasks(run.id).filter((t) => t.state === 'verifying')
        if (targets.length === 0) {
          throw new ValidationError(`run ${run.id} has no tasks in 'verifying'; nothing to verify`)
        }
        const artifactsDir = join(stateDir(ctx.loaded.rootDir), 'artifacts')
        const taskReports: {
          taskId: string
          title: string
          verdict: 'completed' | 'failed'
          summary: string
          checks: { name: string; status: string; exitCode: number | null; note: string | null }[]
        }[] = []
        for (const task of targets) {
          if (task.state !== 'verifying') {
            throw new ValidationError(`task ${task.id} is '${task.state}'; only a task in 'verifying' can be verified`)
          }
          const ws = store.getWorkspaceByTask(task.id)
          const report = await runVerificationChecks({
            store,
            projectId,
            runId: run.id,
            taskId: task.id,
            checks,
            cwd: ws !== null ? ws.path : ctx.loaded.rootDir,
            workspaceId: ws !== null ? ws.id : null,
            artifactsDir,
          })
          const verdict = applyTaskVerificationVerdict(store, task.id)
          taskReports.push({
            taskId: task.id,
            title: task.title,
            verdict: verdict.state,
            summary: verdict.summary,
            checks: report.results.map((r) => ({
              name: r.name,
              status: r.status,
              exitCode: r.exitCode,
              note: r.note,
            })),
          })
        }
        const runVerdict = finalizeRunVerdict(store, run.id)
        const finalRun = store.getRun(run.id)
        // A run can stay open with tasks that are NOT awaiting verification:
        // dependents are only admissible once their dependency is `completed`,
        // so they sit `queued` behind an unverified (or failed) dependency and
        // `pluton verify` cannot close the run. Name them honestly instead of
        // claiming everything awaits verification.
        const remaining = store.listTasks(run.id)
        const stillVerifying = remaining.filter((t) => t.state === 'verifying')
        const blockedTasks = remaining.filter(
          (t) => !TERMINAL_TASK_STATES.has(t.state) && t.state !== 'verifying',
        )
        const human: string[] = []
        for (const tr of taskReports) {
          human.push(`task ${tr.taskId}  ${tr.title}  → ${tr.verdict}  (${tr.summary})`)
          for (const c of tr.checks) {
            human.push(
              `  [${c.status}] ${c.name}` +
                (c.exitCode !== null ? ` (exit ${String(c.exitCode)})` : '') +
                (c.note !== null ? ` — ${c.note}` : ''),
            )
          }
        }
        human.push(
          runVerdict !== null
            ? `run ${finalRun.id}  → ${finalRun.state}`
            : `run ${finalRun.id}  → ${finalRun.state} (not closed: ${
                [
                  ...(stillVerifying.length > 0 ? [`${stillVerifying.length} task(s) awaiting verification`] : []),
                  ...(blockedTasks.length > 0
                    ? [
                        `blocked behind unverified dependencies: ${blockedTasks
                          .map((t) => `${t.id} (${t.state})`)
                          .join(', ')}`,
                      ]
                    : []),
                ].join('; ') || 'no run verdict recorded'
              })`,
        )
        emitOk(io, json, human.join('\n'), {
          run: { id: finalRun.id, state: finalRun.state },
          tasks: taskReports,
          runVerdict,
          ...(blockedTasks.length > 0 ? { blockedTasks: blockedTasks.map((t) => t.id) } : {}),
        })
      } finally {
        store.close()
      }
    })
  })

// ---------------------------------------------------------------------------
// run — create a supervised run and drive it to a verdict (Phase 6)
// ---------------------------------------------------------------------------

program
  .command('run')
  .description('start an orchestration run: the Manager Muse plans and delegates through the restricted tool bridge')
  .option('--goal <text>', 'what the run must achieve (required)')
  .option(
    '--acceptance <criterion>',
    'acceptance criterion (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option('--manager <muse>', 'Muse that coordinates the run (default: the supervisor-role Muse)')
  .option('--request-id <id>', 'idempotency key: retrying with the same id never creates a second run')
  .action(
    async (opts: { goal?: string; acceptance: string[]; manager?: string; requestId?: string }, cmd: Command) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const summary = await runRun(ctx, {
          goal: opts.goal ?? '',
          acceptance: opts.acceptance,
          ...(opts.manager !== undefined ? { managerRef: opts.manager } : {}),
          ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
        })
        const counts = Object.entries(summary.taskCounts)
          .map(([state, n]) => `${state}:${n}`)
          .join('  ')
        const human = [
          `run      ${summary.runId}`,
          `state    ${summary.state}`,
          `outcome  ${summary.outcome ?? '(in progress)'}`,
          `tasks    ${counts || '(none)'}`,
          ...(summary.managerSummary !== null ? [`summary  ${summary.managerSummary}`] : []),
          ...(summary.verificationPending ? [`next: pluton verify --run ${summary.runId}`] : []),
          ...(summary.blockedTasks.length > 0
            ? [
                `note: ${summary.blockedTasks.length} task(s) blocked behind unverified dependencies: ${summary.blockedTasks.join(', ')}`,
              ]
            : []),
        ].join('\n')
        emitOk(io, json, human, {
          run: { id: summary.runId, state: summary.state, outcome: summary.outcome },
          taskCounts: summary.taskCounts,
          managerSummary: summary.managerSummary,
          unfinishedTasks: summary.unfinishedTasks,
          blockedTasks: summary.blockedTasks,
        })
      })
    },
  )

// ---------------------------------------------------------------------------
// Planned commands — explicit, stable `not_implemented` failures.
// ---------------------------------------------------------------------------

for (const [name, planned] of [
  ['attach', 'attach to a Muse terminal (tmux in its container)'],
  ['integrate', 'integrate verified task branches through the integration checkout'],
] as const) {
  program
    .command(name)
    .description(`(planned) ${planned}`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_opts: unknown, cmd: Command) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        throw new NotImplementedError(`pluton ${name}`)
      })
    })
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.showHelpAfterError('(run `pluton --help` for usage)')

await program.parseAsync(process.argv)
