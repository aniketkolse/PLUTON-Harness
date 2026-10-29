import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { pickNativeFolder } from '../../src/server/folder-picker.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

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

const TEST_CONFIG = `version: 1
project:
  name: session-workspace-test
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: local-process
  local_process_acknowledged: true
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
    model: mock-1
    workspace_policy: coordinator-read-only
    permissions: [task.create, task.delegate, task.inspect, task.cancel, result.collect, verification.run, approval.request]
`

function makeProject(): { dir: string; configPath: string } {
  // Canonicalize so the server's project identity matches on macOS
  // (/var vs /private/var) and Windows runners (8.3 RUNNER~1 vs the long name).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-ws-test-')))
  tmpDirs.push(dir)
  execFileSync('git', ['init', dir], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.local'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'], { stdio: 'ignore' })

  const configPath = join(dir, 'pluton.yaml')
  writeFileSync(configPath, TEST_CONFIG, 'utf8')
  writeFileSync(join(dir, 'README.md'), '# Root Workspace\n', 'utf8')
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial commit'], { stdio: 'ignore' })
  return { dir, configPath }
}

describe('Native folder picker unit', () => {
  it('handles win32 picker success, cancellation and failure', async () => {
    // Success
    const success = await pickNativeFolder({
      platform: 'win32',
      exec: async () => ({ stdout: 'C:\\Target\\Dir\r\n', stderr: '' }),
    })
    expect(success).toEqual({ cancelled: false, path: 'C:\\Target\\Dir' })

    // Cancelled (exit code 2)
    const err: any = new Error('cancelled')
    err.code = 2
    const cancelled = await pickNativeFolder({
      platform: 'win32',
      exec: async () => { throw err },
    })
    expect(cancelled).toEqual({ cancelled: true })

    // Other error
    const err2: any = new Error('crash')
    err2.code = 1
    err2.stderr = 'out of memory'
    await expect(
      pickNativeFolder({
        platform: 'win32',
        exec: async () => { throw err2 },
      }),
    ).rejects.toThrow(/out of memory/)
  })

  it('owns the Windows dialog to the foreground window so it opens in front of Pluton', async () => {
    let script = ''
    await pickNativeFolder({
      platform: 'win32',
      exec: async (_file, args) => {
        const index = args.indexOf('-EncodedCommand')
        script = Buffer.from(args[index + 1]!, 'base64').toString('utf16le')
        return { stdout: 'C:\\Target\\Dir', stderr: '' }
      },
    })
    expect(script).toContain('GetForegroundWindow')
    expect(script).toContain('SetForegroundWindow(owner)')
    expect(script).toContain('dialog.Show(owner)')
    // The PowerShell host itself must never be shown as a console window.
    expect(script).not.toContain('Show(IntPtr.Zero)')
  })

  it('handles darwin picker success and cancellation', async () => {
    const success = await pickNativeFolder({
      platform: 'darwin',
      exec: async () => ({ stdout: '/Users/test/workspace\n', stderr: '' }),
    })
    expect(success).toEqual({ cancelled: false, path: '/Users/test/workspace' })

    const cancelErr: any = new Error('User cancelled')
    cancelErr.code = 1
    cancelErr.stderr = 'execution error: User cancelled. (-128)'
    const cancelled = await pickNativeFolder({
      platform: 'darwin',
      exec: async () => { throw cancelErr },
    })
    expect(cancelled).toEqual({ cancelled: true })
  })

  it('handles linux picker success and cancellation', async () => {
    const success = await pickNativeFolder({
      platform: 'linux',
      exec: async () => ({ stdout: '/home/test/workspace\n', stderr: '' }),
    })
    expect(success).toEqual({ cancelled: false, path: '/home/test/workspace' })

    const cancelErr: any = new Error('User cancelled')
    cancelErr.code = 1
    const cancelled = await pickNativeFolder({
      platform: 'linux',
      exec: async () => { throw cancelErr },
    })
    expect(cancelled).toEqual({ cancelled: true })
  })
})

describe('Session-scoped workspaces and picker API', () => {
  let app: AppServerInstance | null = null

  afterEach(async () => {
    if (app) {
      await app.close()
      app = null
    }
  })

  it('provides native folder pick endpoint, per-session workspace persistence and switching', async () => {
    const { dir, configPath } = makeProject()
    const loaded = loadConfig(configPath)
    const { store, projectId } = bootstrapStore(loaded)

    // Create an external workspace directory with its own files. Canonicalize
    // it so the server's returned root matches on macOS (/var vs /private/var)
    // and Windows runners (8.3 RUNNER~1 vs the long profile name).
    const extDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-ext-ws-')))
    tmpDirs.push(extDir)
    writeFileSync(join(extDir, 'external.txt'), 'external workspace content\n', 'utf8')
    mkdirSync(join(extDir, 'sub'), { recursive: true })
    writeFileSync(join(extDir, 'sub', 'nested.txt'), 'nested content\n', 'utf8')

    app = await startAppServer({
      store,
      projectId,
      loaded,
      port: 0,
      token: 'test-token',
      pickFolderFn: async () => ({ cancelled: false, path: extDir }),
    })

    const baseUrl = `http://127.0.0.1:${app.port}`
    const authHeaders = {
      'x-pluton-token': 'test-token',
      'content-type': 'application/json',
    }

    // 1. POST /api/workspace/pick endpoint
    const pickRes = await fetch(`${baseUrl}/api/workspace/pick`, {
      method: 'POST',
      headers: authHeaders,
    })
    expect(pickRes.status).toBe(200)
    const pickJson: any = await pickRes.json()
    expect(pickJson.ok).toBeDefined()

    // 2. Default workspace summary returns server rootDir
    const wsRes = await fetch(`${baseUrl}/api/workspace`, { headers: authHeaders })
    const wsJson: any = await wsRes.json()
    expect(wsJson.ok).toBe(true)
    expect(wsJson.workspace.rootDir).toBe(dir)

    // 3. Create a session with external workspaceRoot
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'External Session',
        workspaceRoot: extDir,
      }),
    })
    expect(createRes.status).toBe(201)
    const createJson: any = await createRes.json()
    const sessionId = createJson.session.id
    expect(sessionId).toBeTruthy()
    expect(createJson.session.workspaceRoot).toBe(extDir)

    // 4. Session detail returns the workspaceRoot
    const sessionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { headers: authHeaders })
    const sessionJson: any = await sessionRes.json()
    expect(sessionJson.ok).toBe(true)
    expect(sessionJson.session.workspaceRoot).toBe(extDir)

    // 5. GET /api/workspace?sessionId=... returns the session-scoped workspace
    const sessionWsRes = await fetch(`${baseUrl}/api/workspace?sessionId=${sessionId}`, { headers: authHeaders })
    const sessionWsJson: any = await sessionWsRes.json()
    expect(sessionWsJson.ok).toBe(true)
    expect(sessionWsJson.workspace.rootDir).toBe(extDir)
    expect(sessionWsJson.workspace.sessionScoped).toBe(true)

    // 6. GET /api/files?sessionId=... lists files from the external workspace
    const filesRes = await fetch(`${baseUrl}/api/files?sessionId=${sessionId}`, { headers: authHeaders })
    const filesJson: any = await filesRes.json()
    expect(filesJson.ok).toBe(true)
    expect(filesJson.files).toContain('external.txt')
    expect(filesJson.files).toContain('sub/nested.txt')
    expect(filesJson.files).not.toContain('README.md')

    // 7. GET /api/files/content?sessionId=... reads from the external workspace
    const contentRes = await fetch(
      `${baseUrl}/api/files/content?sessionId=${sessionId}&path=external.txt`,
      { headers: authHeaders },
    )
    expect(contentRes.status).toBe(200)
    const contentJson: any = await contentRes.json()
    expect(contentJson.ok).toBe(true)
    expect(contentJson.content).toBe('external.txt content\n'.replace('external.txt', 'external workspace'))

    // 8. Security: access outside external workspace fails
    const outsideRes = await fetch(
      `${baseUrl}/api/files/content?sessionId=${sessionId}&path=../secret.txt`,
      { headers: authHeaders },
    )
    expect(outsideRes.status).toBe(403)

    // 9. PATCH /api/sessions/:id switches workspace
    const secondExtDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-ext-ws2-')))
    tmpDirs.push(secondExtDir)
    writeFileSync(join(secondExtDir, 'second.txt'), 'second ws content\n', 'utf8')

    const patchRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ workspaceRoot: secondExtDir }),
    })
    expect(patchRes.status).toBe(200)
    const patchJson: any = await patchRes.json()
    expect(patchJson.ok).toBe(true)
    expect(patchJson.session.workspaceRoot).toBe(secondExtDir)

    // Files list now reflects the switched workspace
    const filesRes2 = await fetch(`${baseUrl}/api/files?sessionId=${sessionId}`, { headers: authHeaders })
    const filesJson2: any = await filesRes2.json()
    expect(filesJson2.files).toContain('second.txt')
    expect(filesJson2.files).not.toContain('external.txt')

    // 10. Rejection of invalid workspace paths
    const badRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ workspaceRoot: join(tmpdir(), 'non-existent-dir-12345') }),
    })
    expect(badRes.status).toBe(400)

    // 11. Creating a run associates the session workspace
    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        goal: 'test run in session workspace',
        sessionId,
      }),
    })
    expect(runRes.status).toBe(201)
    const runJson: any = await runRes.json()
    expect(runJson.ok).toBe(true)
    expect(runJson.run.workspaceRoot).toBe(secondExtDir)
    expect(runJson.run.originSessionId).toBe(sessionId)
  })
})
