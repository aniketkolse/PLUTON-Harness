import { describe, expect, it } from 'vitest'
import { parseQwenCmdShim, resolveQwenInvocation } from '../../src/engines/qwen/discover.ts'
import { buildQwenEnv, qwenStateDir, QWEN_AUTH_ENV_KEYS } from '../../src/engines/qwen/env.ts'
import { matchModelChoice, readModeOption, readModelOption } from '../../src/engines/acp/options.ts'
import { loadQwenFrames } from '../helpers/qwen-script.ts'

/**
 * Pure-function tests for the Qwen Code engine adapter: discovery (npm shims
 * reference a `.js` entry), environment isolation, and model-option matching
 * against the recorded composite model ids.
 */

const REAL_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@qwen-code\\qwen-code\\cli-entry.js" %*
`

describe('resolveQwenInvocation', () => {
  it('resolves PLUTON_QWEN_BIN pointing at cli-entry.js to a node invocation', () => {
    const res = resolveQwenInvocation({
      env: { PLUTON_QWEN_BIN: 'C:\\tools\\qwen\\cli-entry.js' },
      platform: 'win32',
      nodePath: 'C:\\node\\node.exe',
      isFile: () => true,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.invocation.command).toBe('C:\\node\\node.exe')
    expect(res.invocation.baseArgs).toEqual(['C:\\tools\\qwen\\cli-entry.js'])
    expect(res.invocation.entryKind).toBe('node-script')
    expect(res.invocation.via).toBe('env')
  })

  it('parses a real npm .cmd shim for its .js target (never spawning the shim)', () => {
    // npm installs the CLI as a sibling of the npm dir: %dp0% ends with a
    // separator, so `%dp0%\..\@qwen-code\...` points at `Roaming\@qwen-code\...`.
    const shim = 'C:\\roaming\\npm\\qwen.cmd'
    const entry = 'C:\\roaming\\@qwen-code\\qwen-code\\cli-entry.js'
    const target = parseQwenCmdShim(
      shim,
      (p) => (p === shim ? REAL_SHIM : ''),
      (p) => p === shim || p === entry,
    )
    expect(target).toBe(entry)

    const res = resolveQwenInvocation({
      env: { PATH: 'C:\\roaming\\npm' },
      platform: 'win32',
      nodePath: 'node.exe',
      isFile: (p) => p === shim || p === entry,
      readTextFile: (p) => (p === shim ? REAL_SHIM : ''),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.invocation.command).toBe('node.exe')
    expect(res.invocation.baseArgs[0]?.endsWith('cli-entry.js')).toBe(true)
    expect(res.invocation.via).toBe('cmd-shim')
  })

  it('resolves a qwen.exe on PATH as a direct executable', () => {
    const res = resolveQwenInvocation({
      env: { PATH: 'C:\\bin' },
      platform: 'win32',
      isFile: (p) => p === 'C:\\bin\\qwen.exe',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.invocation).toMatchObject({ command: 'C:\\bin\\qwen.exe', baseArgs: [], via: 'path', entryKind: 'executable' })
  })

  it('resolves the POSIX qwen launcher as a direct executable', () => {
    const res = resolveQwenInvocation({
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      isFile: (p) => p === '/usr/local/bin/qwen',
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.invocation.command).toBe('/usr/local/bin/qwen')
  })

  it('reports a fix (and what it looked at) when qwen is not installed', () => {
    const res = resolveQwenInvocation({ env: { PATH: 'C:\\empty' }, platform: 'win32', isFile: () => false })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.fix).toContain('PLUTON_QWEN_BIN')
    expect(res.looked.length).toBeGreaterThan(0)
  })

  it('distrusts a PLUTON_QWEN_BIN that does not exist', () => {
    const res = resolveQwenInvocation({
      env: { PLUTON_QWEN_BIN: 'C:\\nope\\cli-entry.js' },
      platform: 'win32',
      isFile: () => false,
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.fix).toContain('PLUTON_QWEN_BIN')
  })
})

describe('buildQwenEnv', () => {
  it('isolates state under the Muse config dir and redirects home', () => {
    const env = buildQwenEnv('C:\\muse-home', {}, 'win32', { PATH: 'p', OPENAI_API_KEY: 'sk-test' })
    expect(env['QWEN_DIR']).toBe(qwenStateDir('C:\\muse-home'))
    expect(env['QWEN_DIR']?.startsWith('C:\\muse-home')).toBe(true)
    expect(env['USERPROFILE']).toBe('C:\\muse-home')
    expect(env['HOME']).toBeUndefined()
    expect(env['OPENAI_API_KEY']).toBe('sk-test')

    const posix = buildQwenEnv('/home/muse', {}, 'linux', {})
    expect(posix['HOME']).toBe('/home/muse')
    expect(posix['USERPROFILE']).toBeUndefined()
  })

  it('passes only allowlisted credential variables and never empty values', () => {
    expect(QWEN_AUTH_ENV_KEYS).toContain('OPENAI_BASE_URL')
    expect(QWEN_AUTH_ENV_KEYS).toContain('DASHSCOPE_API_KEY')
    const env = buildQwenEnv('C:\\h', {}, 'win32', {
      PATH: 'p',
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: 'http://127.0.0.1:20128/v1',
      AWS_SECRET_ACCESS_KEY: 'should-not-leak',
    })
    expect(env['OPENAI_API_KEY']).toBeUndefined()
    expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:20128/v1')
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined()
  })

  it('lets explicit per-session env win over host passthrough', () => {
    const env = buildQwenEnv('C:\\h', { OPENAI_MODEL: 'cbai/glm-5.2' }, 'win32', { OPENAI_MODEL: 'other' })
    expect(env['OPENAI_MODEL']).toBe('cbai/glm-5.2')
  })
})

describe('qwen model/mode options (recorded frames)', () => {
  const frames = loadQwenFrames()

  it('reads the composite model value and its display name', () => {
    const option = readModelOption(frames.sessionNew.configOptions)
    expect(option).not.toBeNull()
    expect(option?.currentValue).toBe('$runtime|openai|cbai/glm-5.2(openai)')
    expect(option?.choices[0]?.name).toBe('cbai/glm-5.2')
  })

  it('matches a model by display name as well as by exact value', () => {
    const option = readModelOption(frames.sessionNew.configOptions)!
    expect(matchModelChoice(option, '$runtime|openai|cbai/glm-5.2(openai)')?.value).toBe('$runtime|openai|cbai/glm-5.2(openai)')
    expect(matchModelChoice(option, 'cbai/glm-5.2')?.value).toBe('$runtime|openai|cbai/glm-5.2(openai)')
    expect(matchModelChoice(option, 'nope')).toBeNull()
  })

  it('reads the mode option with qwen’s five modes', () => {
    const mode = readModeOption(frames.sessionNew.configOptions)
    expect(mode?.currentValue).toBe('auto')
    expect(mode?.values).toEqual(['plan', 'default', 'auto-edit', 'auto', 'yolo'])
  })
})
