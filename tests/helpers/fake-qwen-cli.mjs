import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

/**
 * Host ACP CLI mock simulating Qwen Code v0.25.2 over stdio.
 * Handles `--version`, `--acp`, ACP lifecycle handshakes, and either:
 * - (Manager) tool bridge HTTP RPCs (task.create, task.wait)
 * - (Worker) isolated workspace actions (file creation and commit)
 */

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('qwen 0.25.2\n')
  process.exit(0)
}

if (!args.includes('--acp')) {
  process.stderr.write('fake-qwen-cli: missing --acp flag\n')
  process.exit(1)
}

const framesUrl = new URL('../fixtures/qwen-acp/recorded-frames.json', import.meta.url)
const frames = JSON.parse(readFileSync(framesUrl, 'utf8'))

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

let mcpServers = null
let currentMode = 'auto'
let currentModel = 'test/model-a'
let sessionId = 'ses-fake-qwen'

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function buildConfigOptions() {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: currentMode,
      options: [
        { value: 'plan', name: 'Plan' },
        { value: 'default', name: 'Default' },
        { value: 'auto', name: 'Auto' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: currentModel,
      options: [
        { value: 'test/model-a', name: 'test/model-a' },
        { value: '$runtime|openai|cbai/glm-5.2(openai)', name: 'cbai/glm-5.2' },
      ],
    },
  ]
}

for await (const rawLine of rl) {
  const line = rawLine.trim()
  if (!line) continue
  let req
  try {
    req = JSON.parse(line)
  } catch {
    continue
  }

  const { id, method, params } = req

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: frames.initializeResult,
    })
  } else if (method === 'session/new') {
    if (params?.mcpServers) {
      mcpServers = params.mcpServers
    }
    sessionId = `ses-${Math.random().toString(36).slice(2, 9)}`
    send({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        models: frames.sessionNew.models,
        modes: frames.sessionNew.modes,
        configOptions: buildConfigOptions(),
      },
    })
  } else if (method === 'session/set_config_option') {
    const configId = params?.configId ?? params?.id
    const value = params?.value
    if (configId === 'mode') currentMode = value
    if (configId === 'model') currentModel = value
    send({
      jsonrpc: '2.0',
      id,
      result: {
        configOptions: buildConfigOptions(),
      },
    })
  } else if (method === 'session/prompt') {
    const isWorker = /[/\\]workspaces[/\\]/.test(process.cwd())

    if (!isWorker) {
      // MANAGER PATH: drive the HTTP tool bridge
      const bridgeServer = Array.isArray(mcpServers)
        ? mcpServers.find((s) => s.type === 'http' || (s.url && typeof s.url === 'string'))
        : null
      try {
        const url = bridgeServer.url
        const headers = { 'content-type': 'application/json' }
        if (Array.isArray(bridgeServer.headers)) {
          for (const h of bridgeServer.headers) headers[h.name] = h.value
        }

        let rpcId = 1
        async function rpc(m, p) {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId++,
              method: m,
              ...(p !== undefined ? { params: p } : {}),
            }),
          })
          return await res.json()
        }

        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'manager', version: '1.0' },
        })

        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        })

        await rpc('tools/list')

        const createRes = await rpc('tools/call', {
          name: 'task.create',
          arguments: {
            title: 'Native worker task',
            brief: 'execute in isolated task checkout',
            acceptanceCriteria: ['evidence recorded'],
            assigneeMuseId: 'worker-a',
          },
        })

        const content = createRes?.result?.content?.[0]?.text
        const taskObj = JSON.parse(content ?? '{}')
        const taskId = taskObj?.task?.id

        if (taskId) {
          await rpc('tools/call', {
            name: 'task.wait',
            arguments: { taskIds: [taskId], timeoutSeconds: 30 },
          })
        }

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Manager orchestrated native worker task successfully.' },
            },
          },
        })

        send({
          jsonrpc: '2.0',
          id,
          result: { stopReason: 'end_turn' },
        })
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    } else {
      // WORKER PATH: record evidence in current working directory
      try {
        const cwd = process.cwd()
        const evidenceFile = join(cwd, 'worker-evidence.txt')
        writeFileSync(evidenceFile, `evidence produced by native worker in ${cwd}\n`, 'utf8')
        try {
          execFileSync('git', ['add', 'worker-evidence.txt'], { cwd, timeout: 10_000, stdio: 'ignore' })
          execFileSync(
            'git',
            ['-c', 'user.name=PlutonWorker', '-c', 'user.email=worker@pluton', 'commit', '-m', 'worker commit'],
            { cwd, timeout: 10_000, stdio: 'ignore' },
          )
        } catch {
          // git commit is best-effort
        }

        // Write an environment evidence file to inspect filtered environment
        const envEvidenceFile = join(cwd, 'worker-env.json')
        writeFileSync(envEvidenceFile, JSON.stringify(process.env, null, 2), 'utf8')

        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Worker recorded evidence in isolated checkout.' },
            },
          },
        })

        send({
          jsonrpc: '2.0',
          id,
          result: { stopReason: 'end_turn' },
        })
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }
}
