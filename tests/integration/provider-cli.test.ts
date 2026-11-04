import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../../bin/pluton.js', import.meta.url))

let projectDir: string
let mockServer: Server
let serverUrl: string

const CONFIG = `version: 1
project:
  name: provider-cli-it
  repository: .
  default_branch: main
  verification: []
ships:
  manager:
    display_name: Manager
    role: supervisor
    engine: mock
    model: mock/test
    workspace_policy: coordinator-read-only
`

function runCli(
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [BIN, ...args], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    cp.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    cp.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    cp.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
    if (input !== undefined) {
      cp.stdin.write(input)
    }
    cp.stdin.end()
  })
}

function parseEnvelope(stdout: string): {
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string; message?: string }
} {
  return JSON.parse(stdout)
}

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'pluton-provider-cli-it-'))
  writeFileSync(join(projectDir, 'pluton.yaml'), CONFIG)

  mockServer = createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      const auth = req.headers['authorization']
      if (auth !== 'Bearer secret-token-123') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'vendor/fast-1', created: 1700000000 },
            { id: 'vendor/smart-2', created: 1700000001 },
          ],
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
  })

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address()
      if (addr && typeof addr === 'object') {
        serverUrl = `http://127.0.0.1:${addr.port}/v1`
      }
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  rmSync(projectDir, { recursive: true, force: true })
})

describe('provider CLI integration', () => {
  it('lists empty providers initially', async () => {
    const res = await runCli(['provider', 'list', '--json'])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    expect(env.data?.['count']).toBe(0)
    expect(env.data?.['providers']).toEqual([])
  })

  it('adds a provider via provider add', async () => {
    const res = await runCli([
      'provider',
      'add',
      'test-prov',
      '--engine',
      'openai-compatible',
      '--base-url',
      serverUrl,
      '--display-name',
      'Test Provider',
      '--json',
    ])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    const prov = env.data?.['provider'] as Record<string, unknown>
    expect(prov?.['id']).toBe('test-prov')
    expect(prov?.['base_url']).toBe(serverUrl)

    const providersFile = join(projectDir, '.pluton', 'providers.json')
    expect(existsSync(providersFile)).toBe(true)
  })

  it('rejects adding provider with invalid id', async () => {
    const res = await runCli([
      'provider',
      'add',
      'sk-secret-key',
      '--engine',
      'openai-compatible',
      '--base-url',
      serverUrl,
      '--json',
    ])
    expect(res.exitCode).not.toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(false)
  })

  it('stores credential strictly from stdin', async () => {
    const res = await runCli(['provider', 'key', 'test-prov', '--json'], 'secret-token-123\n')
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)

    const credFile = join(projectDir, '.pluton', 'provider-homes', 'test-prov', 'credential.json')
    expect(existsSync(credFile)).toBe(true)
    const parsed = JSON.parse(readFileSync(credFile, 'utf8'))
    expect(parsed.api_key).toBe('secret-token-123')
  })

  it('rejects empty credential piped from stdin', async () => {
    const res = await runCli(['provider', 'key', 'test-prov', '--json'], '\n')
    expect(res.exitCode).not.toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(false)
  })

  it('validates provider connectivity and model listing with live mock server', async () => {
    const res = await runCli(['provider', 'validate', 'test-prov', '--json'])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    expect(env.data?.['liveCheck']).toBe('passed')
    expect(env.data?.['modelsCount']).toBe(2)
  })

  it('lists provider models via provider models command', async () => {
    const res = await runCli(['provider', 'models', 'test-prov', '--json'])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    const models = env.data?.['models'] as Array<{ id: string }>
    expect(models).toHaveLength(2)
    expect(models.map((m) => m.id)).toEqual(['vendor/fast-1', 'vendor/smart-2'])
  })

  it('creates and edits a ship using the configured provider', async () => {
    const createRes = await runCli([
      'ship',
      'create',
      'worker-x',
      '--engine',
      'openai-compatible',
      '--provider',
      'test-prov',
      '--model',
      'vendor/fast-1',
      '--role',
      'coder',
      '--json',
    ])
    expect(createRes.exitCode).toBe(0)
    const createEnv = parseEnvelope(createRes.stdout)
    expect(createEnv.ok).toBe(true)

    const listRes = await runCli(['ship', 'list', '--json'])
    expect(listRes.exitCode).toBe(0)
    const listEnv = parseEnvelope(listRes.stdout)
    const ships = listEnv.data?.['ships'] as Array<{ id: string; provider: string | null }>
    const ship = ships.find((s) => s.id === 'worker-x')
    expect(ship?.provider).toBe('test-prov')
  })

  it('removes credential with remove-key', async () => {
    const res = await runCli(['provider', 'remove-key', 'test-prov', '--json'])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    expect(env.data?.['removed']).toBe(true)

    const credFile = join(projectDir, '.pluton', 'provider-homes', 'test-prov', 'credential.json')
    expect(existsSync(credFile)).toBe(false)
  })

  it('removes provider with remove', async () => {
    const res = await runCli(['provider', 'remove', 'test-prov', '--json'])
    expect(res.exitCode).toBe(0)
    const env = parseEnvelope(res.stdout)
    expect(env.ok).toBe(true)
    expect(env.data?.['removed']).toBe(true)

    const listRes = await runCli(['provider', 'list', '--json'])
    const listEnv = parseEnvelope(listRes.stdout)
    expect(listEnv.data?.['count']).toBe(0)
  })

  it('imports providers from an opencode config file via provider import', async () => {
    const opencodePath = join(projectDir, 'opencode.json')
    writeFileSync(
      opencodePath,
      JSON.stringify({
        provider: {
          'cli-imported': {
            npm: '@ai-sdk/openai-compatible',
            options: {
              baseURL: serverUrl,
              apiKey: 'imported-cli-key',
            },
            models: { 'vendor/imported-model': {} },
          },
        },
      }),
      'utf8',
    )

    const importRes = await runCli(['provider', 'import', '--from', opencodePath, '--json'])
    expect(importRes.exitCode).toBe(0)
    const env = parseEnvelope(importRes.stdout)
    expect(env.ok).toBe(true)
    const report = env.data as { imported: Array<{ id: string }> }
    expect(report.imported.map((e) => e.id)).toEqual(['cli-imported'])

    const listRes = await runCli(['provider', 'list', '--json'])
    const listEnv = parseEnvelope(listRes.stdout)
    const providers = listEnv.data?.['providers'] as Array<{ id: string; hasCredential: boolean }>
    expect(providers.find((p) => p.id === 'cli-imported')?.hasCredential).toBe(true)
  })
})
