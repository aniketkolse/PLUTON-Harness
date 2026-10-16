/**
 * `pluton chat` command implementation (ADR-0012).
 * Boots the operator session: resolves Muse, session persistence,
 * tool bridge with operator catalog, container / sandbox setup, and TUI loop.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findManager } from '../../config/load.ts'
import { ConfigError, NotFoundError, ValidationError, InternalError } from '../../domain/errors.ts'
import type { ChatSessionRecord, MuseRecord } from '../../domain/models.ts'
import type { AcpSpawnFn } from '../../engines/acp/client.ts'
import { engineAdapterForMuse } from '../../engines/approval.ts'
import type { EngineAdapter, McpServerSpec } from '../../engines/contract/types.ts'
import { createSandboxManager } from '../../sandbox/factory.ts'
import type { WorkerImageProbe } from '../../sandbox/image.ts'
import type { SandboxManager } from '../../sandbox/types.ts'
import { sandboxContainerName } from '../../sandbox/types.ts'
import { bootstrapStore } from '../../bootstrap.ts'
import type { Store } from '../../store/store.ts'
import { PlutonToolBridge, toolBridgeLimitsFromRuntime } from '../../tools/bridge.ts'
import { ToolHttpServer } from '../../tools/http-transport.ts'
import type { OperatorToolEnv } from '../../tools/operator-catalog.ts'
import { TerminalHost, type ChatIo } from '../../tui/terminal.ts'
import { ChatSession, type ChatSessionDeps } from '../../chat/session.ts'
import { operatorPreamble } from '../../chat/prompt.ts'
import type { ProjectContext } from '../context.ts'
import { resolveMuseByRef } from './mcp.ts'
import { containerAdapterFor, prepareContainerMode } from './run.ts'

export interface ChatCommandOptions {
  museRef?: string
  resume?: string
  continue?: boolean
  json?: boolean
}

export interface ChatDeps {
  adapterFor?: (muse: MuseRecord) => EngineAdapter
  sandboxManager?: SandboxManager
  workerImageProbe?: (rootDir: string) => Promise<WorkerImageProbe>
  dockerSpawn?: AcpSpawnFn
  io?: ChatIo
  startRun?: OperatorToolEnv['startRun']
  poll?: ChatSessionDeps['poll']
}

export interface ChatPlan {
  museId: string
  museSlug: string
  engineKind: string
  model: string
  mode: 'docker' | 'local-process'
  containerName: string | null
  sessionId: string
  resumed: boolean
  messageCount: number
  bridge: { kind: 'http'; label: 'operator'; url: string } | null
}

function resolveChatMuse(ctx: ProjectContext, store: Store, museRef: string | undefined, projectId: string): MuseRecord {
  let muse: MuseRecord
  if (museRef !== undefined) {
    muse = resolveMuseByRef(store, museRef)
  } else {
    const found = findManager(ctx.loaded.config)
    if (!found) {
      throw new ConfigError("no Muse with role 'supervisor' in pluton.yaml — add one or pass a muse ref")
    }
    const m = store.getMuse(found[0])
    if (!m) throw new NotFoundError('muse', found[0])
    muse = m
  }

  if (!muse.enabled) {
    throw new ValidationError(`muse '${muse.slug}' is disabled in configuration`)
  }
  if (muse.projectId !== projectId) {
    throw new ValidationError(`muse '${muse.id}' belongs to another project`)
  }
  return muse
}

function resolveChatSession(
  store: Store,
  projectId: string,
  museId: string,
  opts: ChatCommandOptions,
): { session: ChatSessionRecord; resumed: boolean } {
  if (opts.resume !== undefined) {
    const session = store.getChatSession(opts.resume)
    if (session.projectId !== projectId) {
      throw new ValidationError(`chat session '${session.id}' belongs to another project`)
    }
    return { session, resumed: true }
  }

  if (opts.continue === true) {
    const latest = store.getLatestChatSession(projectId, museId)
    if (latest !== null) {
      return { session: latest, resumed: true }
    }
  }

  const session = store.createChatSession({ projectId, museId })
  return { session, resumed: false }
}

export async function chatRun(
  ctx: ProjectContext,
  opts: ChatCommandOptions,
  deps: ChatDeps = {},
): Promise<{ exitCode: number; plan: ChatPlan }> {
  const { store, projectId } = bootstrapStore(ctx.loaded)

  try {
    const muse = resolveChatMuse(ctx, store, opts.museRef, projectId)
    const { session, resumed } = resolveChatSession(store, projectId, muse.id, opts)
    const storedMessages = store.listChatMessages(session.id)
    const messageCount = storedMessages.length

    const isDocker = ctx.loaded.config.sandbox.kind === 'docker'
    const mode: 'docker' | 'local-process' = isDocker ? 'docker' : 'local-process'
    const containerName = isDocker ? sandboxContainerName(projectId, muse.id) : null

    const basePlan: ChatPlan = {
      museId: muse.id,
      museSlug: muse.slug,
      engineKind: muse.engineKind,
      model: muse.model,
      mode,
      containerName,
      sessionId: session.id,
      resumed,
      messageCount,
      bridge: null,
    }

    if (opts.json) {
      return { exitCode: 0, plan: basePlan }
    }

    const io = deps.io ?? new TerminalHost()
    if (!io.isTty) {
      throw new ValidationError(
        'pluton chat needs an interactive terminal (stdin/stdout are not a TTY); use --json to resolve the chat plan',
      )
    }

    let adapter: EngineAdapter
    if (isDocker) {
      const sandboxManager = deps.sandboxManager ?? createSandboxManager(ctx.loaded.config)
      const contexts = await prepareContainerMode(
        ctx,
        store,
        projectId,
        sandboxManager,
        deps.workerImageProbe,
        { museIds: [muse.id] },
      )
      adapter = deps.adapterFor?.(muse) ?? containerAdapterFor(muse, contexts, deps.dockerSpawn)
    } else {
      createSandboxManager(ctx.loaded.config)
      adapter = deps.adapterFor?.(muse) ?? engineAdapterForMuse(muse)
    }

    const limits = toolBridgeLimitsFromRuntime(ctx.loaded.config.runtime)
    const bridge = new PlutonToolBridge({
      store,
      projectId,
      rootDir: ctx.rootDir,
      callerMuseId: muse.id,
      limits,
      startRun: deps.startRun ?? (async () => {
        throw new InternalError('no background run supervisor configured')
      }),
    })

    const httpServer = new ToolHttpServer({
      host: isDocker ? '0.0.0.0' : '127.0.0.1',
      port: 0,
    })
    const { url } = await httpServer.start()
    const { token } = httpServer.register(bridge, {
      museId: muse.id,
      taskId: null,
      runId: null,
      label: 'operator',
    })

    const clientUrl = isDocker ? url.replace('0.0.0.0', 'host.docker.internal') : url
    const mcpServers: McpServerSpec[] = [
      {
        kind: 'http',
        name: 'pluton',
        url: clientUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    ]

    let instructions = operatorPreamble(muse)
    if (muse.instructionsFile) {
      try {
        const custom = readFileSync(join(ctx.rootDir, muse.instructionsFile), 'utf8')
        instructions = `${instructions}\n\n${custom}`
      } catch {
        // file missing or unreadable; proceed with preamble
      }
    }

    const chatSession = new ChatSession({
      store,
      projectId,
      rootDir: ctx.rootDir,
      muse,
      adapter,
      io,
      session,
      mcpServers,
      instructions,
      resumeToken: session.resumeToken,
      startRun: deps.startRun,
      poll: deps.poll,
    })

    let exitCode = 0
    try {
      await chatSession.start()
      exitCode = await chatSession.run()
    } finally {
      await httpServer.stop()
    }

    const plan: ChatPlan = {
      ...basePlan,
      bridge: {
        kind: 'http',
        label: 'operator',
        url: clientUrl,
      },
    }

    return { exitCode, plan }
  } finally {
    store.close()
  }
}
