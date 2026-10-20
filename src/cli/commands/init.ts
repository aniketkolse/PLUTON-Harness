import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ConfigError } from '../../domain/errors.ts'
import { validateConfig } from '../../config/load.ts'
import { firstLine, run } from '../../util/exec.ts'

export type TeamTemplate = 'full-stack' | 'bugfix' | 'repository-analysis'

export interface InitResult {
  rootDir: string
  configPath: string
  team: TeamTemplate
  createdFiles: string[]
  skippedFiles: string[]
  gitignoreUpdated: boolean
  notes: string[]
}

const ROLE_FILES = ['manager.md', 'researcher.md', 'worker.md', 'coder.md', 'qa.md', 'reviewer.md'] as const

const GITIGNORE_ENTRIES = [
  '# Pluton-Harness private runtime state',
  '.pluton/state/',
  '.pluton/engine-homes/',
  '.pluton/workspaces/',
  '.pluton/workspaces-attic/',
  '.pluton/logs/',
  '.pluton/cache/',
] as const

function templatePath(rel: string): URL {
  return new URL(`../../../templates/${rel}`, import.meta.url)
}

export async function runInit(opts: {
  cwd: string
  team?: TeamTemplate
  name?: string
}): Promise<InitResult> {
  const team: TeamTemplate = opts.team ?? 'full-stack'

  // 1. Detect git root (never mutate the repo; read-only git commands only).
  const gitRoot = await run(['git', '-C', opts.cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  const rootDir = gitRoot.exitCode === 0 && gitRoot.stdout.trim().length > 0 ? gitRoot.stdout.trim() : opts.cwd
  const notes: string[] = []
  if (gitRoot.exitCode !== 0) notes.push('no git repository detected — initializing for this directory only')

  // 2. Never overwrite an existing config.
  const configPath = join(rootDir, 'pluton.yaml')
  if (existsSync(configPath)) {
    throw new ConfigError(
      `pluton.yaml already exists at ${configPath} — ` +
        'init never overwrites an existing config; edit it directly or move it away first',
    )
  }

  // 3. Default branch: prefer the remote HEAD, fall back to the current branch, then 'main'.
  let defaultBranch = 'main'
  const remoteHead = await run(['git', '-C', rootDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    timeoutMs: 15_000,
  })
  if (remoteHead.exitCode === 0) {
    defaultBranch = remoteHead.stdout.trim().replace(/^origin\//, '') || 'main'
  } else {
    const head = await run(['git', '-C', rootDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 15_000 })
    if (head.exitCode === 0 && head.stdout.trim() && head.stdout.trim() !== 'HEAD') {
      defaultBranch = head.stdout.trim()
    }
  }

  // 4. Render the team template and validate it BEFORE writing.
  const projectName = opts.name ?? basename(rootDir)
  const tplText = readFileSync(templatePath(`teams/${team}.yaml`), 'utf8')
    .replaceAll('__PROJECT_NAME__', projectName)
    .replaceAll('__DEFAULT_BRANCH__', defaultBranch)
  validateConfig(parseYaml(tplText), rootDir, configPath)

  const createdFiles: string[] = []
  const skippedFiles: string[] = []

  writeFileSync(configPath, tplText)
  createdFiles.push('pluton.yaml')

  // 5. Role prompts — create only when absent.
  const rolesDir = join(rootDir, '.pluton', 'roles')
  mkdirSync(rolesDir, { recursive: true })
  for (const role of ROLE_FILES) {
    const dest = join(rolesDir, role)
    if (existsSync(dest)) {
      skippedFiles.push(`.pluton/roles/${role}`)
      continue
    }
    copyFileSync(templatePath(`roles/${role}`), dest)
    createdFiles.push(`.pluton/roles/${role}`)
  }

  // 6. Private state dirs (ignored in git).
  for (const dir of ['state', 'engine-homes', 'workspaces', 'logs']) {
    mkdirSync(join(rootDir, '.pluton', dir), { recursive: true })
  }
  createdFiles.push('.pluton/state/ (private runtime state, git-ignored)')

  // 7. .gitignore — append only missing Pluton entries.
  const gitignorePath = join(rootDir, '.gitignore')
  let existing = ''
  if (existsSync(gitignorePath)) existing = readFileSync(gitignorePath, 'utf8')
  const missing = GITIGNORE_ENTRIES.filter((e) => e.startsWith('#') || !existing.includes(e))
  let gitignoreUpdated = false
  if (existing.length === 0 || missing.some((m) => !m.startsWith('#'))) {
    const block = GITIGNORE_ENTRIES.filter((e) => !existing.includes(e)).join('\n')
    const joiner = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    writeFileSync(gitignorePath, `${existing}${joiner}${block}\n`)
    gitignoreUpdated = true
  }

  notes.push('edit pluton.yaml to select each Muse engine/model (`pluton muse model list <muse>`)')
  notes.push('run `pluton doctor` to verify the environment')

  return { rootDir, configPath, team, createdFiles, skippedFiles, gitignoreUpdated, notes }
}

export async function currentGitInfo(cwd: string): Promise<{ root: string | null; branch: string | null }> {
  const root = await run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
  if (root.exitCode !== 0) return { root: null, branch: null }
  const branch = await run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 15_000 })
  return {
    root: root.stdout.trim(),
    branch: branch.exitCode === 0 ? firstLine(branch.stdout) : null,
  }
}
