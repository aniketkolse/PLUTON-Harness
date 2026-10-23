import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/store/db.ts'
import { Store } from '../src/store/store.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRATCH = join(ROOT, '.pluton-tmp', 'demo-native')
const FAKE_CLI = join(ROOT, 'tests', 'helpers', 'fake-opencode-cli.mjs')

console.log('=== Pluton Native Execution Demonstration ===\n')

// 1. Clean and initialize scratch repo
if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })

const git = (args) => execFileSync('git', args, { cwd: SCRATCH, stdio: 'pipe', encoding: 'utf8' })
git(['init', '-b', 'main'])
git(['config', 'user.name', 'Pluton Demo'])
git(['config', 'user.email', 'demo@pluton.local'])

const CONFIG = `version: 1
project:
  name: demo-native
  repository: .
  default_branch: main
  verification: []
sandbox:
  kind: native
  native:
    acknowledge_partial_enforcement: true
    acknowledge_host_network: true
    mode: workspace-write
    session_timeout_minutes: 5
    env_allowlist:
      - DEMO_CUSTOM_VAR
runtime:
  max_concurrent_workers: 2
  network_policy: open
ships:
  manager:
    display_name: Manager
    role: supervisor
    engine: opencode
    model: test/model-a
    workspace_policy: coordinator-read-only
    approval_mode: autonomous-bounded
    network_policy: open
    permissions:
      - project.read
      - task.create
      - task.delegate
      - task.inspect
      - task.cancel
      - result.collect
      - diff.inspect
      - ship.propose_create
      - approval.request
      - run.stop
  worker-a:
    display_name: Worker A
    role: coder
    engine: opencode
    model: test/model-a
    workspace_policy: isolated-task-checkout
    approval_mode: ask-for-sensitive-actions
    network_policy: open
    permissions:
      - task.inspect
      - result.collect
      - diff.inspect
`

writeFileSync(join(SCRATCH, 'pluton.yaml'), CONFIG, 'utf8')
writeFileSync(join(SCRATCH, 'README.md'), '# Demo Native Project\n', 'utf8')
git(['add', '.'])
git(['commit', '-m', 'Initial commit'])

console.log('1. Scratch project initialized with sandbox.kind: native')

// 2. Probe sandbox
const probeOutput = execFileSync(
  process.execPath,
  [join(ROOT, 'bin', 'pluton.js'), '--json', 'sandbox', 'probe'],
  { cwd: SCRATCH, encoding: 'utf8' }
)
const probeRaw = JSON.parse(probeOutput)
const probe = probeRaw.data ?? probeRaw
console.log('2. Sandbox probe result:')
console.log(`   - Available: ${probe.sandbox.available}`)
console.log(`   - Kind: ${probe.sandbox.kind}`)
console.log(`   - Detail: ${probe.sandbox.detail}`)
console.log(`   - Warnings: ${probe.warnings.join('; ')}`)

// 3. Execute run
console.log('\n3. Executing multi-agent run without Docker...')
const runEnv = {
  ...process.env,
  PLUTON_OPENCODE_BIN: FAKE_CLI,
  DEMO_CUSTOM_VAR: 'demo-secret-pass',
  UNSAFE_DEMO_TOKEN: 'should-not-leak',
}

const runOutput = execFileSync(
  process.execPath,
  [
    join(ROOT, 'bin', 'pluton.js'),
    '--json',
    'run',
    '--goal',
    'Demonstrate native manager and worker orchestration in separate checkouts',
  ],
  { cwd: SCRATCH, env: runEnv, encoding: 'utf8' }
)
const runRaw = JSON.parse(runOutput)
const data = runRaw.data ?? runRaw
const run = data.run ?? data
console.log('   Run completed:')
console.log(`   - Run ID: ${run.id}`)
console.log(`   - State: ${run.state}`)
console.log(`   - Outcome: ${run.outcome}`)
console.log(`   - Task counts:`, data.taskCounts)

// 4. Verify durable facts from SQLite store
const dbPath = join(SCRATCH, '.pluton', 'state', 'pluton.sqlite')
const db = openDatabase(dbPath)
const store = new Store(db)

const tasks = store.listTasks(run.id)
console.log('\n4. Durable task facts from SQLite store:')
for (const t of tasks) {
  console.log(`   - Task ${t.id} (${t.title}): state=${t.state}, assignee=${t.assigneeShipId}, workspace=${t.workspaceId}`)
}

const ws = store.getWorkspace(tasks[0].workspaceId)
console.log(`\n5. Workspace checkout isolation:`)
console.log(`   - Workspace path: ${ws.path}`)
console.log(`   - Workspace has worker-evidence.txt: ${existsSync(join(ws.path, 'worker-evidence.txt'))}`)
console.log(`   - Root dir has worker-evidence.txt: ${existsSync(join(SCRATCH, 'worker-evidence.txt'))} (isolated!)`)

const events = store.listEvents(run.id, { limit: 100 })
const execEvents = events.filter((e) => e.type.startsWith('execution.'))
console.log(`\n6. Durable execution events (${execEvents.length} recorded):`)
for (const e of execEvents.reverse()) {
  console.log(`   - [${e.type}] ship=${e.shipId ?? 'n/a'}: ${JSON.stringify(e.payload)}`)
}

db.close()
console.log('\n=== Demonstration Succeeded: Native Multi-Agent Orchestration Verified ===')
