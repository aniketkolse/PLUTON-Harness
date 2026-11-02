/**
 * Pluton-Harness CLI entry point.
 *
 * Conventions (prompt §1.1):
 * - `--json` (or PLUTON_JSON=1) switches a command to machine mode: stdout is
 *   exactly one JSON envelope ({ ok, data } | { ok, error }), diagnostics and
 *   human progress stay on stderr, exit code still reflects success/failure.
 */
import { join } from 'node:path'
import { Command } from 'commander'
import { ConfigError, InternalError, PlutonError, ValidationError } from '../domain/errors.ts'
import { run as execRun } from '../util/exec.ts'
import { redactProseSecrets } from '../util/redact.ts'
import { terminalSafeLine } from '../util/sanitize.ts'
import { stateDir } from '../config/load.ts'
import { TERMINAL_TASK_STATES } from '../domain/state.ts'
import { registerBuiltinEngines } from '../engines/registry.ts'
import { applyTaskVerificationVerdict, finalizeRunVerdict, runVerificationChecks } from '../verify/runner.ts'
import { diffWorktreePatch } from '../workspace/trusted-git.ts'
import { PLUTON_VERSION } from '../version.ts'
import { bootstrapStore } from '../bootstrap.ts'
import { inheritStdioSpawn } from '../terminal/attach.ts'
import { optionalProject, requireProject } from './context.ts'
import { appRun, type AppCommandOptions } from './commands/app.ts'
import { exportRun, exportSession, importRun, importSession } from './commands/session.ts'
import { formatSearchHuman, searchStore, type SearchCommandOptions } from './commands/search.ts'
import { decideApproval, listApprovals, type ApprovalListView } from './commands/approvals.ts'
import { attachShip } from './commands/attach.ts'
import { chatRun } from './commands/chat.ts'
import { collectDoctorChecks, doctorExitCode, renderDoctorInit } from './commands/doctor.ts'
import { configView, configValidate, configPath, configShips } from './commands/config.ts'
import { runInit, type TeamTemplate } from './commands/init.ts'
import { integrateRun, integrationChecksPassed } from './commands/integrate.ts'
import { collectLogType, formatLogsHuman, logsView } from './commands/logs.ts'
import { mcpServe } from './commands/mcp.ts'
import { resumeRun, runRun, type RunSummary } from './commands/run.ts'
import { createShip, editShip, engineList, listShips, modelList, showShip } from './commands/ship.ts'
import {
  formatProjectCurrentHuman,
  formatProjectListHuman,
  projectAdd,
  projectCurrent,
  projectList,
  projectRemove,
  projectSwitch,
} from './commands/project.ts'
import {
  providerAdd,
  providerList,
  providerModels,
  providerRemove,
  providerRemoveKey,
  providerSetKey,
  providerValidate,
  readKeyFromStdin,
} from './commands/provider.ts'
import { sandboxProbe } from './commands/sandbox.ts'
import { workspaceClean } from './commands/workspace.ts'
import {
  graphHuman,
  graphView,
  runByRef,
  runDetail,
  runLine,
  statusAllProjects,
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
    'Pluton-Harness: a local-first control plane coordinating a team of AI coding Ships ' +
      'with per-Ship models, workspaces and terminals.',
  )
  .version(PLUTON_VERSION)
  .option('--json', 'machine-readable output: one JSON document on stdout (also via PLUTON_JSON=1)')
  .option('--config <path>', 'path to pluton.yaml (default: walk up from CWD)')
  .option('--project <id>', 'target project ID, slug, or directory path (default: active project or CWD)')

// Honor --config and --project before commander parses argv so every subcommand sees it via PLUTON_*.
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--config' && i + 1 < process.argv.length) {
    process.env.PLUTON_CONFIG = process.argv[i + 1]
  }
  if (process.argv[i] === '--project' && i + 1 < process.argv.length) {
    process.env.PLUTON_PROJECT = process.argv[i + 1]
  }
}

const io = stdIo

function jsonMode(cmd: Command): boolean {
  const opts = cmd.optsWithGlobals() as { json?: boolean }
  return opts.json === true || process.env.PLUTON_JSON === '1' || process.env.PLUTON_JSON === 'true'
}

export function shouldOpenChat(opts: { isTty: boolean; hasProject: boolean }): boolean {
  return opts.isTty && opts.hasProject
}

program
  .argument('[targetPath]', 'workspace directory or project path to open in Pluton')
  .option('--demo', 'run interactive failed CI build demo scenario')
  .option('--tui', 'open terminal TUI chat instead of graphical application')
  .option('--desktop', 'launch in standalone desktop application window (default)')
  .option('--browser', 'launch in default web browser')
  .option('--port <number>', 'port for the local application server', (v) => Number.parseInt(v, 10))
  .option('--headless', 'start the server without opening a GUI window')
  .option('--detach', 'detach the server process to run in the background')
  .option('--stop', 'stop the active application server for this workspace')
  .option('--status', 'check the status of the application server for this workspace')
  .action(async (targetPath: string | undefined, _opts: Record<string, unknown>, cmd: Command) => {
    const cliOpts = cmd.optsWithGlobals() as {
      demo?: boolean
      tui?: boolean
      desktop?: boolean
      browser?: boolean
      port?: number
      headless?: boolean
      detach?: boolean
      stop?: boolean
      status?: boolean
    }
    if (cliOpts.demo) {
      const { runTuiDemo } = await import('../ui/demo.ts')
      const { getUITheme } = await import('../ui/theme.ts')
      const { TerminalHost } = await import('../tui/terminal.ts')
      const terminalIo = new TerminalHost({ alternateScreen: true })
      terminalIo.start()
      try {
        const theme = getUITheme({ color: terminalIo.isTty })
        await runTuiDemo(terminalIo, theme)
        process.exitCode = 0
        return
      } finally {
        terminalIo.stop()
      }
    }

    const json = jsonMode(cmd)
    const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true
    const effectiveDir = targetPath ?? process.cwd()
    const project = optionalProject(effectiveDir)
    const hasProject = project !== null

    // Explicit TUI mode request
    if (cliOpts.tui) {
      if (json || !shouldOpenChat({ isTty, hasProject }) || project === null) {
        program.outputHelp()
        if (!hasProject && isTty && !json) {
          io.out('\nhint: run `pluton init` to set up a project')
        }
        return
      }
      try {
        const { exitCode } = await chatRun(project, {})
        process.exitCode = exitCode
        return
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        io.err(msg)
        process.exitCode = 1
        return
      }
    }

    // Stop or status actions
    if (cliOpts.stop || cliOpts.status) {
      await runCommand(io, json, async () => {
        const res = await appRun(project, cliOpts, effectiveDir)
        emitOk(
          io,
          json,
          res.stopped
            ? `pluton app server stopped for ${res.rootDir}${res.warning ? `\nwarning: ${res.warning}` : ''}`
            : res.mode === 'status'
              ? `pluton app server is running on ${res.url} (PID ${res.pid})`
              : `pluton graphical workspace active on ${res.url}`,
          res,
        )
      })
      return
    }

    // Non-TTY bare invocation without path or app flags: output help (preserves bare-entry tests)
    if (!targetPath && !isTty && !json && !cliOpts.desktop && !cliOpts.browser && !cliOpts.headless) {
      program.outputHelp()
      if (!hasProject && !json) {
        io.out('\nhint: run `pluton init` to set up a project')
      }
      return
    }

    // Default primary experience: Launch Pluton Graphical Workspace (desktop window or browser)
    await runCommand(io, json, async () => {
      const res = await appRun(project, cliOpts, effectiveDir)
      emitOk(
        io,
        json,
        `pluton graphical workspace active on ${res.url} (${res.mode} mode)\nworkspace: ${res.rootDir}${res.waitForClose && !cliOpts.detach ? '\nPress Ctrl+C to close.' : ''}`,
        res,
      )
      if (res.waitForClose && !cliOpts.detach) {
        await res.waitForClose()
      }
    })
  })

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

program
  .command('app [targetPath]')
  .description('launch the Pluton graphical workspace application (desktop window or browser)')
  .option('--desktop', 'launch in standalone desktop application window (default)')
  .option('--browser', 'launch in default web browser')
  .option('--port <number>', 'port for the local application server', (v) => Number.parseInt(v, 10))
  .option('--headless', 'start the server without opening a GUI window')
  .option('--detach', 'detach the server process to run in the background')
  .option('--stop', 'stop the active application server for this workspace')
  .option('--status', 'check the status of the application server for this workspace')
  .action(async (targetPath: string | undefined, _opts: Record<string, unknown>, cmd: Command) => {
    const json = jsonMode(cmd)
    const appOpts = cmd.optsWithGlobals() as AppCommandOptions
    await runCommand(io, json, async () => {
      const res = await appRun(null, appOpts, targetPath ?? process.cwd())
      emitOk(
        io,
        json,
        res.stopped
          ? `pluton app server stopped for ${res.rootDir}${res.warning ? `\nwarning: ${res.warning}` : ''}`
          : res.mode === 'status'
            ? `pluton app server is running on ${res.url} (PID ${res.pid})`
            : `pluton graphical workspace active on ${res.url} (${res.mode} mode)\nworkspace: ${res.rootDir}${res.waitForClose && !appOpts.detach ? '\nPress Ctrl+C to close.' : ''}`,
        res,
      )
      if (res.waitForClose && !appOpts.detach && !appOpts.status && !appOpts.stop) {
        await res.waitForClose()
      }
    })
  })

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
  .description('check the environment: Node, Git, project config, engine installs, and the selected execution provider')
  .option('--init', 'guided first-run setup: remediation hints for every failing check')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    const init = (cmd.opts() as { init?: boolean }).init === true
    await runCommand(io, json, async () => {
      const checks = await collectDoctorChecks({ cwd: process.cwd(), init })
      const summary = summarizeChecks(checks)
      if (init && json) {
        emitOk(
          io,
          json,
          renderDoctorInit(checks),
          { checks, summary, init: true },
        )
      } else if (init) {
        io.out(renderDoctorInit(checks))
        return doctorExitCode(checks)
      } else {
        emitOk(
          io,
          json,
          `${renderChecks(checks)}\n\n${summary.pass} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`,
          { checks, summary },
        )
        return doctorExitCode(checks)
      }
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
// project — manage registered projects and active project pointer
// ---------------------------------------------------------------------------

const projectCmd = program
  .command('project')
  .description('manage registered projects and active project pointer')

projectCmd
  .command('list')
  .description('list registered Pluton projects with active and CWD markers')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const res = projectList(process.cwd(), { json })
      emitOk(io, json, formatProjectListHuman(res), res)
    })
  })

projectCmd
  .command('switch <project>')
  .description('switch the global active Pluton project')
  .action(async (projectIdOrSlug: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const entry = projectSwitch(projectIdOrSlug)
      emitOk(io, json, `Switched active project to '${entry.name}' (${entry.id})`, entry)
    })
  })

projectCmd
  .command('current')
  .description('show the currently resolved project and resolution source')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const resolved = projectCurrent(process.cwd(), process.env.PLUTON_PROJECT)
      emitOk(io, json, formatProjectCurrentHuman(resolved), resolved)
    })
  })

projectCmd
  .command('add <path>')
  .description('register a directory containing pluton.yaml as a Pluton project')
  .action(async (dirPath: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const entry = projectAdd(dirPath)
      emitOk(io, json, `Registered project '${entry.name}' (${entry.id}) at ${entry.rootDir}`, entry)
    })
  })

projectCmd
  .command('remove <project>')
  .description('remove a project from the registry (does not delete project files on disk)')
  .action(async (projectIdOrSlug: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const res = projectRemove(projectIdOrSlug)
      emitOk(io, json, `Removed project '${projectIdOrSlug}' from registry.`, res)
    })
  })

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

program
  .command('config [subcommand]')
  .description('inspect and validate pluton.yaml configuration (read-only, never exposes secrets)')
  .option('--json', 'machine-readable output')
  .action(async (subcommand: string | undefined, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const sub = (subcommand ?? 'view').toLowerCase()
      if (!['view', 'validate', 'path', 'ships'].includes(sub)) {
        throw new ValidationError(
          `unknown config subcommand '${sub}'; available: view, validate, path, ships`,
        )
      }

      if (sub === 'view') {
        const report = await configView(process.cwd())
        const safe = redactProseSecrets(JSON.stringify(report))
        emitOk(
          io,
          json,
          json ? '' : `Configuration: ${report.configPath}\n${safe}`,
          report,
        )
      } else if (sub === 'validate') {
        await configValidate(process.cwd())
        emitOk(
          io,
          json,
          `Configuration is valid: ${process.cwd()}/pluton.yaml`,
          { valid: true },
        )
      } else if (sub === 'path') {
        const info = await configPath(process.cwd())
        emitOk(
          io,
          json,
          info.configPath,
          { configPath: info.configPath, rootDir: info.rootDir },
        )
      } else if (sub === 'ships') {
        const ships = await configShips(process.cwd())
        const rows = [['ID', 'ROLE', 'ENGINE']]
        for (const s of ships) rows.push([s.id, s.role, s.engine])
        emitOk(
          io,
          json,
          json ? '' : table(rows),
          { ships },
        )
      }
    })
  })

// ---------------------------------------------------------------------------
// ship
// ---------------------------------------------------------------------------

const shipCmd = program.command('ship').description('inspect and configure Ships (team members)')

// Backward-compatible: `pluton muse` is a deprecated alias for `pluton ship`
shipCmd.alias('muse')

shipCmd
  .command('list')
  .description('list configured Ships')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const ships = listShips(ctx.loaded.config)
      const manager = ships.find((m) => m.role === 'supervisor') ?? null
      const rows: string[][] = [['ID', 'NAME', 'ROLE', 'ENGINE', 'PROVIDER', 'MODEL', 'WORKSPACE']]
      for (const m of ships) {
        rows.push([m.id, m.displayName, m.role, m.engine, m.provider ?? '(default)', m.model, m.workspacePolicy])
      }
      const human =
        ships.length === 0
          ? 'no ships configured — edit pluton.yaml or run `pluton ship create`'
          : `${table(rows)}\n\nmanager: ${manager ? manager.id : '(none — a run cannot start)'}`
      emitOk(io, json, human, { ships, manager: manager?.id ?? null, count: ships.length })
    })
  })

shipCmd
  .command('show <ship>')
  .description('show one Ship: config, engine install, auth, instructions file')
  .action(async (shipId: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const detail = await showShip(ctx, shipId)
      const lines = [
        `ship:        ${detail.id} (${detail.displayName})`,
        `role:        ${detail.role}`,
        `engine:      ${detail.engine}${detail.discovery ? ` — ${detail.discovery.installed ? 'installed' : 'NOT installed'}` : ' — unknown engine kind'}`,
        `provider:    ${detail.provider ?? '(default)'}`,
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

shipCmd
  .command('create <id>')
  .description('add a Ship to pluton.yaml (validated before the file is touched)')
  .requiredOption('--engine <kind>', 'engine kind (see `pluton engine list`)')
  .requiredOption('--model <model>', 'exact provider-qualified model id for that engine')
  .option('--provider <id>', 'provider id defined in .pluton/providers.json')
  .option('--display-name <name>', 'human display name (default: id)')
  .option('--role <role>', 'supervisor | researcher | coder | tester | reviewer | custom', 'custom')
  .option('--instructions-file <path>', 'role prompt file, relative to the project root')
  .option('--workspace-policy <policy>', 'coordinator-read-only | read-only | isolated-task-checkout')
  .option('--approval-mode <mode>', 'autonomous-bounded | ask-for-sensitive-actions | ask-always')
  .option('--permission <permission...>', 'grant a permission (repeatable)')
  .action(
    async (
      shipId: string,
      opts: {
        engine: string
        model: string
        provider?: string
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
        const result = createShip(ctx, {
          id: shipId,
          engine: opts.engine,
          model: opts.model,
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
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
          `created ship '${shipId}' in ${result.configPath}\nrun \`pluton doctor\` to verify engine install and auth`,
          { shipId, ship: result.ship, configPath: result.configPath },
        )
      })
    },
  )

shipCmd
  .command('edit <ship>')
  .description('change fields of an existing Ship in pluton.yaml (validated before writing)')
  .option('--display-name <name>', 'human display name')
  .option('--role <role>', 'supervisor | researcher | coder | tester | reviewer | custom')
  .option('--engine <kind>', 'engine kind (see `pluton engine list`)')
  .option('--provider <id>', 'provider id defined in .pluton/providers.json')
  .option('--model <model>', 'exact provider-qualified model id')
  .option('--instructions-file <path>', 'role prompt file, relative to the project root')
  .option('--workspace-policy <policy>', 'coordinator-read-only | read-only | isolated-task-checkout')
  .option('--approval-mode <mode>', 'autonomous-bounded | ask-for-sensitive-actions | ask-always')
  .option('--permission <permission...>', 'replace the permission list with these values (repeatable)')
  .action(
    async (
      shipId: string,
      opts: {
        displayName?: string
        role?: string
        engine?: string
        provider?: string
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
        const result = editShip(ctx, shipId, {
          ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
          ...(opts.role !== undefined ? { role: opts.role } : {}),
          ...(opts.engine !== undefined ? { engine: opts.engine } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.instructionsFile !== undefined ? { instructionsFile: opts.instructionsFile } : {}),
          ...(opts.workspacePolicy !== undefined ? { workspacePolicy: opts.workspacePolicy } : {}),
          ...(opts.approvalMode !== undefined ? { approvalMode: opts.approvalMode } : {}),
          ...(opts.permission !== undefined ? { permissions: opts.permission } : {}),
        })
        emitOk(
          io,
          json,
          `updated ship '${shipId}' (${result.changed.join(', ')}) in ${result.configPath}`,
          { shipId, changed: result.changed, ship: result.ship, configPath: result.configPath },
        )
      })
    },
  )

shipCmd
  .command('chat <ship>')
  .description('open an interactive chat TUI with a specific Ship')
  .option('--resume <id>', 'resume an existing chat session by id')
  .option('--continue', 'continue the latest chat session with this Ship')
  .action(async (shipArg: string, opts: { resume?: string; continue?: boolean }, cmd: Command) => {
    const json = jsonMode(cmd)
    if (json) {
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const { plan } = await chatRun(ctx, { shipRef: shipArg, resume: opts.resume, continue: opts.continue, json: true })
        emitOk(io, json, `chat plan resolved for ship ${plan.shipSlug} (${plan.sessionId})`, plan)
        return 0
      })
      return
    }

    try {
      const ctx = requireProject(process.cwd())
      const { exitCode } = await chatRun(ctx, { shipRef: shipArg, resume: opts.resume, continue: opts.continue })
      process.exitCode = exitCode
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.err(msg)
      process.exitCode = 1
    }
  })

const shipModelCmd = shipCmd.command('model').description('model catalogue of a Ship\'s engine')

shipModelCmd
  .command('list <ship>')
  .description('list model ids the Ship\'s engine reports (fails when the engine cannot list models)')
  .action(async (shipId: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const models = await modelList(ctx, shipId)
      const ship = ctx.loaded.config.ships[shipId]
      const engine = ship ? ship.engine : 'unknown'
      const rows: string[][] = [['MODEL ID', 'LABEL', 'SOURCE']]
      for (const m of models) rows.push([m.id, m.label ?? '', m.source])
      const human =
        models.length === 0
          ? `engine '${engine}' reported no models`
          : `${table(rows)}\n\nset one with: pluton ship edit ${shipId} --model <MODEL ID>`
      emitOk(io, json, human, { ship: shipId, engine, models })
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
// provider — external model providers and credentials (Phase 1, ADR-0003)
// ---------------------------------------------------------------------------

const providerCmd = program.command('provider').description('inspect and configure model providers and credentials')

providerCmd
  .command('list')
  .description('list configured providers')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const providers = providerList(ctx.rootDir)
      const rows: string[][] = [['ID', 'ENGINE', 'DISPLAY NAME', 'BASE URL', 'AUTH', 'CREDENTIAL']]
      for (const p of providers) {
        rows.push([p.id, p.engine, p.displayName, p.baseUrl, p.authStyle, p.hasCredential ? 'configured' : 'missing'])
      }
      const human =
        providers.length === 0
          ? 'no providers configured — run `pluton provider add <id> --engine <kind> --base-url <url>`'
          : table(rows)
      emitOk(io, json, human, { providers, count: providers.length })
    })
  })

providerCmd
  .command('add <id>')
  .description('add a provider configuration (saved to .pluton/providers.json)')
  .requiredOption('--engine <kind>', 'engine kind (e.g. openai-compatible)')
  .requiredOption('--base-url <url>', 'provider base URL (http(s)://...)')
  .option('--display-name <name>', 'human display name')
  .option('--auth-style <style>', 'bearer | header', 'bearer')
  .option('--auth-header <name>', 'HTTP header name when auth-style is header (default: x-api-key)')
  .option('--auth-prefix <prefix>', 'prefix prepended to credential')
  .option('--models-path <path>', 'custom models endpoint path (default: /models)')
  .option('--chat-path <path>', 'custom chat completions endpoint path (default: /chat/completions)')
  .option('--timeout <ms>', 'request timeout in ms', (v) => Number.parseInt(v, 10))
  .action(
    async (
      id: string,
      opts: {
        engine: string
        baseUrl: string
        displayName?: string
        authStyle?: string
        authHeader?: string
        authPrefix?: string
        modelsPath?: string
        chatPath?: string
        timeout?: number
      },
      cmd: Command,
    ) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const res = providerAdd(ctx.rootDir, {
          id,
          engine: opts.engine,
          baseUrl: opts.baseUrl,
          ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
          ...(opts.authStyle === 'header' || opts.authStyle === 'bearer' ? { authStyle: opts.authStyle } : {}),
          ...(opts.authHeader !== undefined ? { authHeader: opts.authHeader } : {}),
          ...(opts.authPrefix !== undefined ? { authPrefix: opts.authPrefix } : {}),
          ...(opts.modelsPath !== undefined ? { modelsPath: opts.modelsPath } : {}),
          ...(opts.chatPath !== undefined ? { chatPath: opts.chatPath } : {}),
          ...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
        })
        emitOk(
          io,
          json,
          `added provider '${id}' (${res.provider.engine}) -> ${res.provider.base_url}\nstore credential with: pluton provider key ${id}`,
          { provider: res.provider },
        )
      })
    },
  )

providerCmd
  .command('remove <id>')
  .description('remove a provider configuration and its credential file')
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const res = providerRemove(ctx.rootDir, id)
      emitOk(io, json, `removed provider '${id}' and its credential home`, res)
    })
  })

providerCmd
  .command('key <id>')
  .description('store or replace a provider credential (reads key from stdin)')
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const key = await readKeyFromStdin()
      const res = providerSetKey(ctx.rootDir, id, key)
      emitOk(
        io,
        json,
        `credential stored for provider '${id}' in .pluton/provider-homes/${id}/credential.json (mode 0600)`,
        res,
      )
    })
  })

providerCmd
  .command('remove-key <id>')
  .description('delete the stored credential for a provider')
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const res = providerRemoveKey(ctx.rootDir, id)
      emitOk(
        io,
        json,
        res.removed ? `removed credential for provider '${id}'` : `no credential stored for provider '${id}'`,
        res,
      )
    })
  })

providerCmd
  .command('validate <id>')
  .description('validate provider install, credentials, and live model listing')
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await providerValidate(ctx.rootDir, id)
      const lines = [
        `provider:   ${report.id} (${report.engine})`,
        `credential: ${report.hasCredential ? 'present' : 'MISSING'}`,
        `status:     ${report.liveCheck}`,
        `detail:     ${report.detail}`,
        ...(report.modelsCount !== undefined ? [`models:     ${report.modelsCount} model(s) discovered`] : []),
      ]
      emitOk(io, json, lines.join('\n'), report)
      return report.liveCheck === 'failed' ? 1 : 0
    })
  })

providerCmd
  .command('models <id>')
  .description('list models reported by this provider')
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const models = await providerModels(ctx.rootDir, id)
      const rows: string[][] = [['MODEL ID', 'LABEL', 'SOURCE']]
      for (const m of models) rows.push([m.id, m.label ?? '', m.source])
      const human =
        models.length === 0
          ? `provider '${id}' reported no models`
          : table(rows)
      emitOk(io, json, human, { provider: id, models, count: models.length })
    })
  })

// ---------------------------------------------------------------------------
// sandbox — execution substrate probe (Phase 5, ADR-0013)
// ---------------------------------------------------------------------------

const sandboxCmd = program
  .command('sandbox')
  .description('probe the native execution substrate and its confinement capabilities')

sandboxCmd
  .command('probe')
  .description('report native execution state and host engine provider capabilities')
  .action(async (_opts: unknown, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await sandboxProbe(ctx)
      const lines = [
        `sandbox: ${report.sandbox.kind} — ${report.sandbox.available ? 'available' : 'UNAVAILABLE'}`,
        `detail:  ${report.sandbox.detail}`,
        ...report.warnings.map((w) => `warning: ${w}`),
        report.dispatchReady ? 'dispatch: ready' : 'dispatch: NOT ready',
      ].filter((s) => s.length > 0)
      emitOk(io, json, lines.join('\n'), report)
      return report.dispatchReady ? 0 : 1
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
  .option('--all-projects', 'show recent runs across all registered projects')
  .action(async (opts: { run?: string; limit: string; allProjects?: boolean }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const limit = Number.parseInt(opts.limit, 10)
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ValidationError('--limit must be an integer between 1 and 500')
      }

      if (opts.allProjects) {
        const runs = statusAllProjects(undefined, limit)
        const human =
          runs.length === 0
            ? 'no runs recorded across registered projects'
            : runs
                .map((s) => {
                  const counts = Object.entries(s.taskCounts)
                    .map(([state, n]) => `${state}:${n}`)
                    .join(' ')
                  return `[${s.projectName}] ${runLine(s.run)}${counts ? `  [${counts}]` : ''}`
                })
                .join('\n')
        emitOk(io, json, human, { runs })
        return
      }

      const ctx = requireProject(process.cwd())
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
            `manager  ${detail.summary.run.managerShipId}`,
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

program
  .command('logs [run]')
  .alias('log')
  .description('query the durable event log with a resumable seq cursor')
  .option('--run <id>', 'restrict to one run (full id or unique suffix)')
  .option('--after <seq>', 'start after this global event seq (cursor)', '0')
  .option('--limit <n>', 'page size (1-1000, default 50)', '50')
  .option('--type <type>', 'only events of this type (repeatable)', collectLogType, [])
  .option('--task <id>', 'only events of this task')
  .option('--ship <id>', 'only events of this ship')
  .option('--since <iso>', 'inclusive created_at lower bound (ISO-8601)')
  .option('--until <iso>', 'inclusive created_at upper bound (ISO-8601)')
  .action(async (runRef: string | undefined, opts: {
    run?: string
    after: string
    limit: string
    type: string[]
    task?: string
    ship?: string
    since?: string
    until?: string
  }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const { store, projectId } = bootstrapStore(ctx.loaded)
      try {
        const view = logsView(store, projectId, {
          ...(runRef !== undefined ? { run: runRef } : {}),
          ...(opts.run !== undefined ? { runOption: opts.run } : {}),
          after: opts.after,
          limit: opts.limit,
          type: opts.type,
          ...(opts.task !== undefined ? { task: opts.task } : {}),
          ...(opts.ship !== undefined ? { ship: opts.ship } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(opts.until !== undefined ? { until: opts.until } : {}),
        })
        emitOk(io, json, formatLogsHuman(view), view)
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
          `assignee  ${task.assigneeShipId ?? '(unassigned)'}`,
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
  .description('serve Pluton tools over stdio for one engine session (--run/--ship, optional --task)')
  .requiredOption('--run <id>', 'run id (full or unique suffix)')
  .option('--ship <id>', 'calling Ship id or slug')
  .option('--muse <id>', 'deprecated alias for --ship')
  .option('--task <id>', 'task id for a task-scoped session (omit for manager scope)')
  .action(async (opts: { run: string; ship?: string; task?: string; muse?: string }) => {
    try {
      const shipRef = opts.ship ?? opts.muse
      if (!shipRef) {
        throw new ValidationError("either --ship <id> or legacy --muse <id> is required")
      }
      const ctx = requireProject(process.cwd())
      await mcpServe(ctx, {
        runRef: opts.run,
        shipRef,
        isLegacyMuse: opts.muse !== undefined && opts.ship === undefined,
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
  .option('--dispatch', 're-dispatch unblocked tasks immediately after verification')
  .action(async (opts: { run: string; task?: string; dispatch?: boolean }, cmd: Command) => {
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
        for (const target of targets) {
          if (target.runId !== run.id) {
            throw new ValidationError(
              `task ${target.id} belongs to run ${target.runId}, not ${run.id}; refusing to verify it under this run`,
            )
          }
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
          let diffText = ''
          let changedFiles: string[] = []
          if (ws !== null) {
            try {
              const diff = await diffWorktreePatch(ws.path, ws.baseCommit)
              diffText = diff.diff
              changedFiles = diff.files
            } catch (error) {
              throw new ValidationError(
                `could not capture the verified diff for task ${task.id} through trusted Git plumbing: ${
                  error instanceof Error ? error.message : String(error)
                }; refusing to apply a verdict`,
              )
            }
          }
          const verdict = applyTaskVerificationVerdict(store, task.id, { diffText, changedFiles })
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
        if (runVerdict?.outcome === 'redispatched') {
          human.push(
            `run ${finalRun.id}  → ${finalRun.state} (redispatched ${runVerdict.redispatchedTasks?.length ?? 0} unblocked task(s): ${runVerdict.redispatchedTasks?.join(', ') ?? ''})`,
          )
        } else if (runVerdict !== null) {
          human.push(`run ${finalRun.id}  → ${finalRun.state}`)
        } else {
          human.push(
            `run ${finalRun.id}  → ${finalRun.state} (not closed: ${
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
        }

        let redispatchSummary = null
        if (opts.dispatch && runVerdict?.outcome === 'redispatched') {
          store.close()
          redispatchSummary = await resumeRun(ctx, run.id, { skipManager: true })
          human.push(
            `redispatched execution completed → run ${redispatchSummary.runId} is ${redispatchSummary.state} (${redispatchSummary.outcome ?? 'in progress'})`,
          )
        }

        emitOk(io, json, human.join('\n'), {
          run: { id: finalRun.id, state: finalRun.state },
          tasks: taskReports,
          runVerdict,
          ...(redispatchSummary !== null ? { redispatchSummary } : {}),
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
  .description('start an orchestration run: the Manager Ship plans and delegates through the restricted tool bridge')
  .option('--goal <text>', 'what the run must achieve (required for new runs)')
  .option(
    '--acceptance <criterion>',
    'acceptance criterion (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option('--manager <ship>', 'Ship that coordinates the run (default: the supervisor-role Ship)')
  .option('--request-id <id>', 'idempotency key: retrying with the same id never creates a second run')
  .option('--resume <id>', 'resume an existing run (full run id or unique suffix)')
  .action(
    async (
      opts: { goal?: string; acceptance: string[]; manager?: string; requestId?: string; resume?: string },
      cmd: Command,
    ) => {
      const json = jsonMode(cmd)
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        let summary: RunSummary
        if (opts.resume !== undefined) {
          const { store } = bootstrapStore(ctx.loaded)
          let targetRunId: string
          try {
            const r = runByRef(store, opts.resume)
            targetRunId = r.id
          } finally {
            store.close()
          }
          summary = await resumeRun(ctx, targetRunId, { skipManager: true })
        } else {
          summary = await runRun(ctx, {
            goal: opts.goal ?? '',
            acceptance: opts.acceptance,
            ...(opts.manager !== undefined ? { managerRef: opts.manager } : {}),
            ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
          })
        }
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
// chat — interactive operator chat TUI (ADR-0012)
// ---------------------------------------------------------------------------

program
  .command('chat [ship]')
  .description('open an interactive chat TUI with an operator Ship (default: supervisor)')
  .option('--resume <id>', 'resume an existing chat session by id')
  .option('--continue', 'continue the latest chat session with this Ship')
  .option('--demo', 'run interactive failed CI build demo scenario')
  .action(async (shipArg: string | undefined, _opts: { resume?: string; continue?: boolean; demo?: boolean }, cmd: Command) => {
    // `--demo` is also a root/global option. Commander stores a value parsed
    // before the subcommand on the parent, not in the local action options;
    // optsWithGlobals() is the only view that sees both spellings.
    const opts = cmd.optsWithGlobals() as { resume?: string; continue?: boolean; demo?: boolean }
    if (opts.demo) {
      const { runTuiDemo } = await import('../ui/demo.ts')
      const { getUITheme } = await import('../ui/theme.ts')
      const { TerminalHost } = await import('../tui/terminal.ts')
      const terminalIo = new TerminalHost({ alternateScreen: true })
      terminalIo.start()
      try {
        const theme = getUITheme({ color: terminalIo.isTty })
        await runTuiDemo(terminalIo, theme)
        process.exitCode = 0
        return
      } finally {
        terminalIo.stop()
      }
    }

    const json = jsonMode(cmd)
    if (json) {
      await runCommand(io, json, async () => {
        const ctx = requireProject(process.cwd())
        const { plan } = await chatRun(ctx, { shipRef: shipArg, resume: opts.resume, continue: opts.continue, json: true })
                emitOk(io, json, `chat plan resolved for ship ${plan.shipSlug} (${plan.sessionId})`, plan)
        return 0
      })
      return
    }

    try {
      const ctx = requireProject(process.cwd())
      const { exitCode } = await chatRun(ctx, { shipRef: shipArg, resume: opts.resume, continue: opts.continue })
      process.exitCode = exitCode
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      io.err(msg)
      process.exitCode = 1
    }
  })

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

program
  .command('attach')
  .description(
    "attach this terminal to a Ship's host tmux session (interactive; --json resolves the target without attaching)",
  )
  .argument('<ship>', 'ship id, slug or unique id suffix')
  .option('--window <name>', 'attach to (or create) a named tmux window')
  .action(async (shipArg: string, opts: { window?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = await attachShip(
        ctx,
        { shipRef: shipArg, ...(opts.window !== undefined ? { windowName: opts.window } : {}) },
        json ? {} : { spawnAttach: inheritStdioSpawn },
      )
      const containerSession = `${result.containerName}:${result.sessionName}`
      const windowSuffix = result.windowName !== null ? ` (window ${result.windowName})` : ''
      const human = result.attached
        ? [
            `attached to ${result.shipId} → ${containerSession}${windowSuffix}`,
            ...(result.exitCode !== 0 ? [`exit ${String(result.exitCode)}`] : []),
          ].join('\n')
        : `target ${containerSession}${windowSuffix}\nargv: ${result.argv.join(' ')}`
      emitOk(io, json, human, result)
      // Mirror the attach child's exit code (plan mode: 0); runCommand would
      // clobber a process.exitCode set here, so the body returns the code.
      return result.exitCode ?? 0
    })
  })

// ---------------------------------------------------------------------------
// integrate
// ---------------------------------------------------------------------------

program
  .command('integrate')
  .description(
    'merge verified task branches into pluton/integration/<run> and run the project checks there (never main)',
  )
  .requiredOption('--run <id>', 'run id (full id or unique suffix)')
  .option('--task <id...>', 'integrate only these tasks (must be completed)')
  .action(async (opts: { run: string; task?: string[] }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await integrateRun(ctx, {
        runRef: opts.run,
        ...(opts.task !== undefined && opts.task.length > 0 ? { taskRefs: opts.task } : {}),
      })
      const lines: string[] = [`checkout ${report.checkout.path}  (branch ${report.checkout.branch})`]
      for (const c of report.committed) {
        lines.push(`task ${c.taskId}  → committed dirty changes ${c.commit.slice(0, 12)} (task checkout)`)
      }
      for (const t of report.integrated) {
        lines.push(
          t.status === 'merged'
            ? `task ${t.taskId}  ${t.title}  → merged ${t.commit?.slice(0, 12) ?? ''}`
            : `task ${t.taskId}  ${t.title}  → already integrated`,
        )
      }
      for (const c of report.conflicts) {
        lines.push(
          `task ${c.taskId}  → conflict, conflicts: ${c.files.map((f) => terminalSafeLine(f)).join(', ')}`,
        )
      }
      for (const b of report.blockedProtected) {
        lines.push(
          `task ${b.taskId}  → blocked: approval ${b.approvalId} created (${b.files.map((f) => terminalSafeLine(f)).join(', ')})`,
        )
      }
      for (const o of report.blockedOverlap) {
        // File names come from git: sanitize each one at the render boundary,
        // like the approval rows further down.
        lines.push(
          `task ${o.taskId}  → blocked: overlaps another task on ${o.files.map((f) => terminalSafeLine(f)).join(', ')}`,
        )
      }
      for (const f of report.failed) {
        lines.push(`task ${f.taskId}  → failed: ${f.detail}`)
      }
      for (const n of report.notAttempted) {
        lines.push(`task ${n.taskId}  not attempted after conflict`)
      }
      if (report.checks.length > 0) {
        lines.push('checks (in the integration checkout):')
        for (const c of report.checks) {
          lines.push(
            `  [${c.status}] ${c.name}${c.exitCode !== null ? ` (exit ${String(c.exitCode)})` : ''}`,
          )
        }
      }
      if (report.artifactPath !== null) lines.push(`artifact ${report.artifactPath}`)
      lines.push(
        `review the branch at ${report.checkout.path}; main is never touched (git log ${report.checkout.branch})`,
      )
      emitOk(io, json, lines.join('\n'), report)
      // Post-integration checks are acceptance evidence, not decoration: a
      // failed check must make the command fail so automation cannot treat a
      // red integration as a green one.
      return integrationChecksPassed(report.checks) ? 0 : 1
    })
  })

// ---------------------------------------------------------------------------
// workspace — operator-invoked cleanup of Pluton-owned checkouts (CS-7)
// ---------------------------------------------------------------------------

const workspaceCmd = program
  .command('workspace')
  .description('inspect and clean Pluton workspace checkouts under .pluton/workspaces')

workspaceCmd
  .command('clean')
  .description(
    'remove the Pluton-managed checkouts of finished runs (marker-guarded; artifacts and archived checkouts are never touched)',
  )
  .option('--run <id>', 'clean the workspaces of one run (full id or unique suffix; the run must be terminal)')
  .option('--all-runs', 'clean the workspaces of every terminal run and report the runs still in flight')
  .action(async (opts: { run?: string; allRuns?: boolean }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await workspaceClean(ctx, {
        ...(opts.run !== undefined ? { runRef: opts.run } : {}),
        ...(opts.allRuns === true ? { allRuns: true } : {}),
      })
      const lines: string[] = []
      for (const r of report.removed) {
        const owner = r.taskId !== null ? `task ${r.taskId}` : 'integration'
        lines.push(`workspace ${r.workspaceId}  ${r.path}  (${r.kind}, ${owner})  → removed`)
      }
      for (const s of report.skipped) {
        lines.push(`workspace ${s.workspaceId}  ${s.path}  → skipped: ${s.reason}`)
      }
      for (const f of report.refusedRuns) {
        lines.push(`run ${f.runId}  → refused: ${f.reason}`)
      }
      lines.push(
        'removing a checkout discards its branch objects — the only copy of unmerged/unpushed work in it; run pluton integrate first if that work is needed',
      )
      lines.push(
        'artifacts under .pluton/state/artifacts and archived checkouts under .pluton/workspaces-attic are never touched',
      )
      emitOk(io, json, lines.join('\n'), report)
    })
  })

// ---------------------------------------------------------------------------
// approvals — the operator inbox: list, approve, deny (fail-closed expiry)
// ---------------------------------------------------------------------------

const approvalsCmd = program
  .command('approvals')
  .description('operator approval inbox: list, approve, deny (expiring approvals are fail-closed)')

function approvalLine(a: ApprovalListView['approvals'][number]): string {
  const by = a.requestedByShipId ?? 'operator'
  const expiry =
    a.expiresInMinutes === null
      ? 'never'
      : a.expiresInMinutes < 0
        ? `expired ${String(-a.expiresInMinutes)}m ago`
        : `expires in ${String(a.expiresInMinutes)}m`
  // Render boundary: rows are sanitized at persistence, but a row persisted by
  // an older build may still carry escape bytes — never print them raw.
  const action = terminalSafeLine(a.action)
  const reason = terminalSafeLine(a.reason)
  return `${a.id}  ${a.status}  ${action}  by ${by}  age ${String(a.ageMinutes)}m  [${expiry}]  — ${reason}`
}

function approvalsHuman(view: ApprovalListView): string {
  const counts = Object.entries(view.counts)
    .map(([status, n]) => `${status}:${String(n)}`)
    .join('  ')
  if (view.approvals.length === 0) {
    return `no approvals match (pending only; use --all to include decided)\ncounts: ${counts}`
  }
  return `${view.approvals.map(approvalLine).join('\n')}\n\ncounts: ${counts}`
}

approvalsCmd
  .command('list')
  .description('list approvals (pending by default; overdue pendings are swept to expired first)')
  .option('--all', 'include decided approvals (approved/denied/expired)')
  .option('--run <id>', 'only approvals of one run (full id or unique suffix)')
  .action(async (opts: { all?: boolean; run?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const view = await listApprovals(ctx, {
        ...(opts.all === true ? { all: true } : {}),
        ...(opts.run !== undefined ? { runRef: opts.run } : {}),
      })
      emitOk(io, json, approvalsHuman(view), view)
    })
  })

function decideHuman(report: Awaited<ReturnType<typeof decideApproval>>): string {
  const lines: string[] = [
    `approval ${report.approval.id}  ${terminalSafeLine(report.approval.action)}  → ${report.approval.status} by ${report.approval.decidedBy}`,
  ]
  if (report.applied !== null) {
    lines.push(`applied ship '${report.applied.shipId}' → ${report.applied.configPath}`)
    if (report.applied.container !== null) {
      lines.push(
        `container ${report.applied.container.containerName} (${report.applied.container.created ? 'created' : 'reused'})`,
      )
    }
    if (report.applied.containerWarning !== null) {
      lines.push(`container warning: ${report.applied.containerWarning}`)
    }
  }
  if (report.run !== null) {
    const note = report.run.resumed
      ? 'resumed after approval'
      : report.run.parked
        ? `stays parked — supervisor already exited${report.run.recordedOutcome !== null ? ` (outcome: ${report.run.recordedOutcome})` : ''}`
        : 'still awaiting other approvals'
    lines.push(`run ${report.run.id}  ${report.run.stateBefore} → ${report.run.stateAfter}  (${note})`)
    if (report.run.resumeSummary !== undefined && report.run.resumeSummary !== null) {
      lines.push(
        `auto-continued run ${report.run.resumeSummary.runId}: ${report.run.resumeSummary.state} (${report.run.resumeSummary.outcome})`,
      )
    }
  }
  if (report.integrationReport !== null) {
    const passed = integrationChecksPassed(report.integrationReport.checks)
    const status =
      report.integrationReport.conflicts.length > 0
        ? 'conflicts'
        : report.integrationReport.failed.length > 0
          ? 'failed'
          : passed
            ? 'success'
            : 'checks_failed'
    lines.push(
      `auto-continued integration: ${status} (${String(report.integrationReport.integrated.length)} task(s) integrated)`,
    )
  }
  if (report.expiredSwept.length > 0) {
    lines.push(`swept ${String(report.expiredSwept.length)} overdue approval(s) to expired`)
  }
  return lines.join('\n')
}

approvalsCmd
  .command('approve <approval>')
  .description('approve a pending approval (applies approved ship.create proposals)')
  .option('--request-id <id>', 'idempotency key: retrying with the same id never decides twice')
  .option('--continue', 'automatically continue execution (e.g. apply integration or resume unparked run)')
  .action(async (approvalRef: string, opts: { requestId?: string; continue?: boolean }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await decideApproval(ctx, {
        approvalRef,
        decision: 'approve',
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
        ...(opts.continue !== undefined ? { autoContinue: opts.continue } : {}),
      })
      emitOk(io, json, decideHuman(report), report)
      // An approval-triggered integration is only successful when its checks
      // actually passed. Exiting 0 on a red check would let a wrapper treat
      // the continuation as accepted.
      if (report.integrationReport !== null && !integrationChecksPassed(report.integrationReport.checks)) {
        return 1
      }
    })
  })

approvalsCmd
  .command('deny <approval>')
  .description('deny a pending approval (nothing is ever instantiated)')
  .option('--request-id <id>', 'idempotency key: retrying with the same id never decides twice')
  .action(async (approvalRef: string, opts: { requestId?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const report = await decideApproval(ctx, {
        approvalRef,
        decision: 'deny',
        ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      })
      emitOk(io, json, decideHuman(report), report)
    })
  })

// ---------------------------------------------------------------------------
// session — export and import chat sessions and runs (JSONL)
// ---------------------------------------------------------------------------

const sessionCmd = program.command('session').description('export and import chat sessions and runs (JSONL)')

sessionCmd
  .command('export <sessionId>')
  .description('export a chat session to JSONL')
  .option('-o, --out <path>', 'write output to a file instead of stdout')
  .action(async (sessionId: string, opts: { out?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = exportSession(ctx, sessionId, opts)
      if (opts.out) {
        emitOk(io, json, `exported session ${result.sessionId} → ${result.path}`, result)
      } else {
        if (json) {
          emitOk(io, json, '', result)
        } else {
          io.out(result.jsonl)
        }
      }
    })
  })

sessionCmd
  .command('import <file>')
  .description('import a chat session from a JSONL file')
  .option(
    '--workspace-root <path>',
    'local workspace directory for a cross-host restore (the exported path is host-specific)',
  )
  .action(async (filePath: string, opts: { workspaceRoot?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = importSession(ctx, filePath, opts)
      emitOk(io, json, `imported session ${result.sessionId} (${result.messageCount} message(s))`, result)
    })
  })

sessionCmd
  .command('export-run <runId>')
  .description('export an orchestration run to JSONL')
  .option('-o, --out <path>', 'write output to a file instead of stdout')
  .action(async (runId: string, opts: { out?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = exportRun(ctx, runId, opts)
      if (opts.out) {
        emitOk(io, json, `exported run ${result.runId} → ${result.path}`, result)
      } else {
        if (json) {
          emitOk(io, json, '', result)
        } else {
          io.out(result.jsonl)
        }
      }
    })
  })

sessionCmd
  .command('import-run <file>')
  .description('import an orchestration run from a JSONL file')
  .option(
    '--workspace-root <path>',
    'local workspace directory for a cross-host restore (the exported path is host-specific)',
  )
  .action(async (filePath: string, opts: { workspaceRoot?: string }, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = importRun(ctx, filePath, opts)
      emitOk(
        io,
        json,
        `imported run ${result.runId} (${result.taskCount} task(s), ${result.eventCount} event(s))`,
        result,
      )
    })
  })

// ---------------------------------------------------------------------------
// search — full-text search across chat messages and events (FTS5)
// ---------------------------------------------------------------------------

program
  .command('search <query>')
  .description('search chat messages and events with full-text search (SQLite FTS5)')
  .option('-s, --session <id>', 'filter to a specific chat session')
  .option('-r, --run <id>', 'filter to a specific orchestration run')
  .option('-l, --limit <n>', 'maximum number of matches to return (default: 20)', (v) => parseInt(v, 10))
  .action(async (query: string, opts: SearchCommandOptions, cmd: Command) => {
    const json = jsonMode(cmd)
    await runCommand(io, json, async () => {
      const ctx = requireProject(process.cwd())
      const result = searchStore(ctx, query, opts)
      emitOk(io, json, formatSearchHuman(result), result)
    })
  })

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.showHelpAfterError('(run `pluton --help` for usage)')

await program.parseAsync(process.argv)
