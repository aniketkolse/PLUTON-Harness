import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bootstrapStore } from '../../src/bootstrap.ts'
import { loadConfig } from '../../src/config/load.ts'
import { startAppServer, type AppServerInstance } from '../../src/server/server.ts'

const tmpDirs: string[] = []

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Windows lock cleanup
    }
  }
})

const TEST_CONFIG = `version: 1
project:
  name: spa-universal-models-test
  repository: .
  default_branch: main
  verification: []
ships:
  supervisor:
    display_name: Supervisor
    role: supervisor
    engine: mock
    model: mock/test
    workspace_policy: coordinator-read-only
`

async function setupServer(): Promise<{
  server: AppServerInstance
  cleanup: () => Promise<void>
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pluton-spa-models-')))
  tmpDirs.push(root)
  writeFileSync(join(root, 'pluton.yaml'), TEST_CONFIG, 'utf8')

  const loaded = loadConfig(root)
  const bootstrapped = bootstrapStore(loaded)
  const server = await startAppServer({
    store: bootstrapped.store,
    projectId: bootstrapped.projectId,
    loaded,
  })

  const cleanup = async () => {
    await server.close()
    bootstrapped.store.close()
  }

  return { server, cleanup }
}

describe('PLUTON SPA — Universal Connection Management & Model Selection', () => {
  it('serves SPA HTML and JS with connections panel, test triggers, manual model registration, and grouped picker', async () => {
    const { server, cleanup } = await setupServer()
    try {
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const js = await (await fetch(`http://127.0.0.1:${server.port}/app.js`)).text()

      // 1. Connection management panel HTML elements
      expect(html).toContain('id="connectionSettingsCard"')
      expect(html).toContain('id="connectionTable"')
      expect(html).toContain('id="btnOpenAddConnection"')
      expect(html).toContain('id="connectionAddModal"')
      expect(html).toContain('id="connectionIdInput"')
      expect(html).toContain('id="connectionBaseUrlInput"')

      // 2. Manual model registration form HTML elements
      expect(html).toContain('id="manualModelModal"')
      expect(html).toContain('id="manualModelIdInput"')
      expect(html).toContain('id="manualModelConnectionSelect"')
      expect(html).toContain('id="btnRegisterManualModel"')

      // 3. Multi-connection JS API wiring in app.js
      expect(js).toContain("apiFetch('/api/connections')")
      expect(js).toContain('function loadConnections')
      expect(js).toContain('function renderConnections')
      expect(js).toContain('function openAddConnectionModal')
      expect(js).toContain('function submitAddConnection')
      expect(js).toContain('function validateConnection')
      expect(js).toContain('function deleteConnection')
      expect(js).toContain('function openManualModelModal')
      expect(js).toContain('function submitManualModel')

      // 4. Grouped model picker in app.js supporting multi-connection models
      expect(js).toContain('renderModelSelectList')
      expect(js).toContain('model-group-title')
    } finally {
      await cleanup()
    }
  })
})
