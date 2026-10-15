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
import { Command } from 'commander'
import { NotImplementedError, ValidationError } from '../domain/errors.ts'
import { registerBuiltinEngines } from '../engines/registry.ts'
import { PLUTON_VERSION } from '../version.ts'
import { requireProject } from './context.ts'
import { collectDoctorChecks, doctorExitCode } from './commands/doctor.ts'
import { runInit, type TeamTemplate } from './commands/init.ts'
import { createMuse, editMuse, engineList, listMuses, modelList, showMuse } from './commands/muse.ts'
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
// Planned commands — explicit, stable `not_implemented` failures.
// ---------------------------------------------------------------------------

for (const [name, planned] of [
  ['run', 'start an orchestration run (Manager-driven team execution)'],
  ['status', 'show run/task status from durable state'],
  ['task', 'inspect and control tasks inside a run'],
  ['attach', 'attach to a Muse terminal (tmux in its container)'],
  ['graph', 'show the task dependency graph of a run'],
  ['verify', 'run verification checks for a run'],
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
