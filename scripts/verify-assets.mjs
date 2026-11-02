#!/usr/bin/env node
/**
 * Embedded-asset verifier.
 *
 * The SPA is a TypeScript template literal that becomes a browser asset. Two
 * hazards make that fragile, and both have bitten this repository before:
 *
 *  1. a stray backtick inside the template terminates the literal early, so the
 *     served file is truncated JavaScript;
 *  2. a single backslash in the literal eats the next character (a template
 *     literal treats `\x` as an escape), silently corrupting the script.
 *
 * This script imports the asset module directly - so the string is exactly
 * what the server serves, with no re-implementation of TypeScript's unescaping
 * - and then:
 *
 *  - parses /app.js with the JavaScript engine (a syntax error fails here);
 *  - checks the served HTML for the element ids the client binds to, and for
 *    the ids the reference UI removed;
 *  - checks the served CSS for the design tokens the layout depends on.
 *
 * Exit code 0 = all checks pass; 1 = at least one check failed.
 */

import { STATIC_ASSETS } from '../src/server/static-assets.ts'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

/**
 * Run every embedded-asset check.
 *
 * @returns {{ checks: string[], failures: string[] }}
 */
export function verifyAssets() {
  const failures = []
  const checks = []

  function check(name, condition, detail) {
    checks.push(name)
    if (!condition) failures.push(detail ? `${name} - ${detail}` : name)
  }

  const html = STATIC_ASSETS['/index.html']?.content ?? ''
  const css = STATIC_ASSETS['/app.css']?.content ?? ''
  const js = STATIC_ASSETS['/app.js']?.content ?? ''

  // --- the assets exist at all ---------------------------------------------
  for (const [name, body] of Object.entries({ html, css, js })) {
    check(`asset present: ${name}`, body.length > 0, 'asset is empty')
  }

  // --- the embedded JavaScript parses --------------------------------------
  if (js.length > 0) {
    try {
      new vm.Script(js, { filename: 'app.js' })
      check('embedded JavaScript parses', true)
    } catch (err) {
      check('embedded JavaScript parses', false, err instanceof Error ? err.message : String(err))
    }
  }

  // --- the HTML exposes the ids the client binds to ------------------------
  const REQUIRED_IDS = [
    'promptInput',
    'btnPrimary',
    'btnAttach',
    'btnMic',
    'btnNewSession',
    'btnBuildConfirmStart',
    'btnBuildConfirmCancel',
    'buildConfirm',
    'buildConfirmWorkspace',
    'buildConfirmGoal',
    'sbContext',
    'modelLabelBtn',
    'mcpToggleBtn',
    'sidebarTabSessions',
    'sidebarTabFiles',
    'sidebarTabSettings',
    'sidebarToggleBtn',
    'activeRunCard',
    'dagContainer',
    'filesList',
    'attachModal',
    'workspacePath',
    'collapsedSidebarToggle',
    'btnRestoreSidebar',
    'accountInfoBox',
    'btnSignOutAccount',
    'customModelNameInput',
    'customApiKeyInput',
    'btnToggleApiKey',
    'btnVerifyAddCustomModel',
    'toggleAutonomous',
    'thinkingEffortSelect',
    'providerSettingsCard',
    'providerTable',
    'btnOpenAddProvider',
    'modelSelectModal',
    'modelSearchInput',
  ]
  for (const id of REQUIRED_IDS) {
    check(`html has id="${id}"`, html.includes(`id="${id}"`), 'id is missing')
  }

  // --- the elements the reference UI removed are still gone ----------------
  const REMOVED = [
    'Conversations',
    'data-tab="orchestra"',
    'data-tab="approvals"',
    'sbMode',
    'sbCostItem',
    'sbMusesCount',
  ]
  for (const token of REMOVED) {
    check(`html does not contain "${token}"`, !html.includes(token), 'token is present')
  }

  // --- the CSS keeps the tokens the layout depends on ----------------------
  const REQUIRED_CSS = ['--accent-purple:', '::-webkit-scrollbar', ':root {']
  for (const token of REQUIRED_CSS) {
    check(`css contains "${token}"`, css.includes(token), 'token is missing')
  }
  check(
    'css does not right-align user messages',
    !css.includes('align-self: flex-end'),
    'right-aligned user bubble is back',
  )

  // --- the client calls the real endpoints ---------------------------------
  const REQUIRED_CALLS = [
    "apiFetch('/api/mcp')",
    "apiFetch('/api/models')",
    "apiFetch('/api/sessions'",
    "apiFetch('/api/files')",
    '/api/muses/',
    '/model',
    '/start',
    '/cancel',
    "apiFetch('/api/settings'",
    "apiFetch('/api/account/",
    "apiFetch('/api/models/custom'",
    "apiFetch('/api/providers')",
  ]
  for (const call of REQUIRED_CALLS) {
    check(`client calls ${call}`, js.includes(call), 'call is missing')
  }

  // --- no hardcoded fixture data ------------------------------------------
  const FORBIDDEN_FIXTURES = [
    'const sessionsData',
    'const mcpServers = [',
    'let availableModels = [',
  ]
  for (const token of FORBIDDEN_FIXTURES) {
    check(`client does not declare ${token}`, !js.includes(token), 'fixture array is present')
  }

  return { checks, failures }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const { checks, failures } = verifyAssets()
  if (failures.length > 0) {
    console.error(`verify-assets: ${failures.length} of ${checks.length} checks FAILED`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`verify-assets: ${checks.length} checks passed`)
}
