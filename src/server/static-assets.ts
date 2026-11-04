/**
 * Embedded graphical frontend static assets (ADR-0014).
 * Single authoritative Single-Page Application (SPA) serving desktop and browser.
 * Zero-dependency, offline-ready, conforming to the PLUTON design system.
 */

import { PLUTON_MARK_BODY as plutonMarkBody, plutonMarkFaviconDataUri } from '../ui/brand-mark.ts'

export interface StaticAsset {
  contentType: string
  content: string
}

export interface QaQuestionCardOptions {
  id: string
  title: string
  description?: string
  dependentTasks?: string[]
  options?: string[]
  selectedOption?: string
  resolved?: boolean
}

export function renderQaQuestionCardHtml(opts: QaQuestionCardOptions): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const titleHtml = `<div class="qa-title">${escape(opts.title)}</div>`
  const descHtml = opts.description ? `<div class="qa-desc">${escape(opts.description)}</div>` : ''

  const badgesHtml =
    opts.dependentTasks && opts.dependentTasks.length > 0
      ? `<div class="qa-badges">${opts.dependentTasks
          .map((t) => `<span class="qa-badge">${escape(t)}</span>`)
          .join('')}</div>`
      : ''

  const optionsHtml =
    opts.options && opts.options.length > 0
      ? `<div class="qa-options">${opts.options
          .map((opt) => {
            const isSelected = opts.selectedOption === opt
            return `<button type="button" class="qa-option-btn${isSelected ? ' is-selected' : ''}" data-option="${escape(opt)}">${escape(opt)}</button>`
          })
          .join('')}</div>`
      : ''

  const statusHtml = opts.resolved
    ? `<div class="qa-resolved-status qa-resolved">Unblocked and confirmed${
        opts.selectedOption ? `: <strong>${escape(opts.selectedOption)}</strong>` : ''
      }</div>`
    : ''

  const actionsHtml = `<div class="qa-actions"><button type="button" class="btn-primary qa-confirm-btn${
    opts.resolved ? ' is-resolved' : ''
  }" data-confirm-qa="${escape(opts.id)}"${opts.resolved ? ' disabled' : ''}>Confirm & Unblock</button></div>`

  const resolvedClass = opts.resolved ? ' qa-resolved' : ''

  return (
    `<div class="qa-card${resolvedClass}" id="qa-card-${escape(opts.id)}" data-qa-id="${escape(opts.id)}">` +
    `<div class="qa-card-head">${titleHtml}${badgesHtml}</div>` +
    descHtml +
    optionsHtml +
    statusHtml +
    actionsHtml +
    `</div>`
  )
}

export const STATIC_ASSETS: Record<string, StaticAsset> = {
  '/index.html': {
    contentType: 'text/html; charset=utf-8',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PLUTON — AI Coding Agent</title>
  <link rel="icon" href="${plutonMarkFaviconDataUri()}">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="app" class="app-shell">


    <div id="sidebarScrim" class="sidebar-scrim" aria-hidden="true"></div>

    <!-- COLLAPSED SIDEBAR RESTORE BUTTON -->
    <div id="collapsedSidebarToggle" class="collapsed-toggle is-hidden" aria-label="Restore sidebar">
      <button id="btnRestoreSidebar" class="icon-btn" type="button" title="Restore Sidebar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2"/><path d="M9 3v18" stroke-width="2"/></svg>
      </button>
    </div>

    <!-- ============ LEFT NAVIGATION SIDEBAR ============ -->
    <aside id="leftSidebar" class="app-sidebar" style="width: 280px;">
      <div class="sidebar-head">
        <div class="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
          <button id="sidebarTabSessions" class="tab-btn is-active" type="button" role="tab" aria-selected="true" title="Sessions">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
            <span class="tab-text">Sessions</span>
          </button>
          <button id="sidebarTabFiles" class="tab-btn" type="button" role="tab" aria-selected="false" title="Project Files">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
            <span class="tab-text">Files</span>
          </button>
        </div>
        <button id="sidebarTabSettings" class="icon-btn" type="button" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        </button>
        <button id="sidebarToggleBtn" class="icon-btn" type="button" title="Collapse sidebar" aria-label="Collapse sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2"/><path d="M9 3v18" stroke-width="2"/></svg>
        </button>
      </div>

      <!-- SESSIONS PANE -->
      <section id="paneSessions" class="sidebar-pane" role="tabpanel" aria-label="Sessions">
        <div class="pane-scroll">
          <button id="btnNewSession" class="btn-new" type="button" title="Start a new persisted session">
            <span aria-hidden="true">+</span> New Session
          </button>
          <div id="sessionsList" class="session-list"></div>
        </div>
      </section>

      <!-- FILES PANE -->
      <section id="paneFiles" class="sidebar-pane is-hidden" role="tabpanel" aria-label="Project files">
        <div class="pane-scroll">
          <div class="pane-meta">
            <span id="filesWorkspaceLabel" class="mono truncate" title="Click to change workspace folder" style="cursor: pointer;">—</span>
            <span class="pane-tag">workspace</span>
          </div>
          <div class="sub-tabs" role="tablist">
            <button id="tabFiles" class="sub-tab is-active" type="button">Files</button>
            <button id="tabDiffs" class="sub-tab" type="button">Worktree Diffs</button>
          </div>
          <div class="file-search-bar">
            <svg class="file-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input id="fileSearchInput" class="file-search-input" type="text" placeholder="Search files (by name/path)…" autocomplete="off" spellcheck="false" />
            <button id="fileSearchClear" class="file-search-clear is-hidden" type="button" title="Clear search" aria-label="Clear search">&times;</button>
          </div>
          <div id="fileBreadcrumbs" class="file-breadcrumbs" aria-label="Breadcrumb navigation"></div>
          <div id="fileSearchResults" class="file-search-results is-hidden"></div>
          <div id="filesList" class="file-list"></div>
        </div>
      </section>

      <!-- SETTINGS PANE -->
      <section id="paneSettings" class="sidebar-pane is-hidden" role="tabpanel" aria-label="Settings">
        <div class="pane-scroll">
          <!-- Orchestra live run section removed from Settings UI; hidden hooks retained for asset contracts -->
          <div class="is-hidden" style="display:none;" aria-hidden="true">
            <span class="is-hidden">Agent Orchestra</span>
            <div id="activeRunCard"></div>
            <div id="dagContainer"></div>
            <button id="btnVerifyRedispatch" type="button"></button>
            <button id="btnResumeRun" type="button"></button>
            <button id="btnViewRunDiff" type="button"></button>
          </div>

          <!-- Pluton Account / Profile -->
          <div class="card">
            <div class="card-head">
              <span class="card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                Pluton Account
              </span>
              <span id="accountStatusBadge" class="badge badge-ok">Connected</span>
            </div>
            <div id="accountInfoBox" class="account-box">
              <div class="account-profile">
                <div class="account-avatar">P</div>
                <div class="account-details truncate">
                  <div id="accountUsername" class="account-name truncate">pluton-developer</div>
                  <div id="accountEmail" class="account-sub truncate">developer@pluton.account</div>
                </div>
                <button id="btnSignOutAccount" class="btn-xs btn-secondary" type="button">Sign Out</button>
              </div>
            </div>
            <div id="accountLoginForm" class="account-form is-hidden">
              <input id="loginUserInput" type="text" placeholder="Username or Email" class="input-text">
              <button id="btnSignInAccount" class="btn-primary w-full" type="button">Link Pluton Account</button>
            </div>
            <div id="runtimeInfo" class="kv-list"></div>
          </div>

          <!-- AI Providers -->
          <div class="card" id="providerSettingsCard">
            <div class="card-head">
              <span class="card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
                AI Providers
              </span>
              <div class="card-head-actions">
                <button id="btnImportProviders" class="btn-xs btn-secondary" type="button">Import OpenCode</button>
                <button id="btnOpenAddProvider" class="btn-xs btn-primary" type="button">+ Add Provider</button>
              </div>
            </div>
            <div class="card-sub">Credentials stored securely in <code>.pluton/provider-homes/</code> (0600)</div>
            <div id="providerTable" class="provider-table"></div>
          </div>

          <!-- Add Custom AI Model & Personal API Key -->
          <div class="card">
            <div class="card-head">
              <span class="card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
                Add Custom AI Model
              </span>
            </div>
            <div class="notice notice-danger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
              <span><strong>Warning:</strong> Do not share this API key with AI or anyone. Keys are kept securely in local memory only.</span>
            </div>
            <label class="field">
              <span class="field-label">Model ID / Name</span>
              <input id="customModelNameInput" type="text" placeholder="e.g., custom/my-model" class="input-text">
            </label>
            <label class="field">
              <span class="field-label">Personal API Key</span>
              <div class="input-password-wrap">
                <input id="customApiKeyInput" type="password" placeholder="sk-..." class="input-text mono">
                <button id="btnToggleApiKey" class="icon-btn-ghost" type="button" title="Toggle key visibility">
                  <svg id="eyeIconOpen" class="is-hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  <svg id="eyeIconClosed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>
                </button>
              </div>
            </label>
            <button id="btnVerifyAddCustomModel" class="btn-primary w-full" type="button">Verify &amp; Add Model</button>
            <div id="modelVerifyStatus" class="card-status-text"></div>
            <div id="modelRegistry" class="registry is-hidden"></div>
            <button id="btnReloadModels" class="btn-secondary is-hidden" type="button">Reload model registry</button>
          </div>

          <!-- Permissions & Approvals -->
          <div class="card">
            <div class="card-head">
              <span class="card-title">Permissions &amp; Approvals</span>
              <span class="tag-mono">security</span>
            </div>
            <div class="policy-toggles">
              <label class="toggle-row">
                <span>Autonomous Tool Execution</span>
                <input id="toggleAutonomous" type="checkbox" checked class="checkbox-custom">
              </label>
              <label class="toggle-row">
                <span>Parallel Sub-agent Spawning</span>
                <input id="toggleParallel" type="checkbox" checked class="checkbox-custom">
              </label>
              <label class="toggle-row">
                <span>Auto-Approve Read Tools</span>
                <input id="toggleAutoApproveRead" type="checkbox" checked class="checkbox-custom">
              </label>
              <label class="toggle-row">
                <span>Use terminal and bash</span>
                <input id="toggleTerminalBash" type="checkbox" checked class="checkbox-custom">
              </label>
            </div>
            <div id="permissionsList" class="permissions is-hidden"></div>
            <div class="card-sub">Pending approvals</div>
            <div id="approvalsList" class="approvals"></div>
          </div>

          <!-- Reasoning & Thinking Effort -->
          <div class="card">
            <div class="card-head"><span class="card-title">Reasoning &amp; Thinking Effort</span></div>
            <div class="field">
              <select id="thinkingEffortSelect" class="select-box">
                <option value="auto" selected>Auto</option>
                <option value="max">Max</option>
                <option value="high">High</option>
                <option value="balanced">Balanced</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <!-- Agent Model Configuration -->
          <div class="card">
            <div class="card-head">
              <span class="card-title">
                <span class="card-title-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg></span>
                Agent Model Configuration
              </span>
            </div>
            <div class="card-sub">Configure model per team role</div>
            <div id="museModelList" class="muse-models"></div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">MCP Servers</span><span id="mcpCardCount" class="tag-mono">—</span></div>
            <div id="mcpCardList" class="mcp-list"></div>
          </div>

          <div class="card" id="projectIdentityCard">
            <div class="card-head">
              <span class="card-title">Project Identity</span>
              <button id="btnSaveProjectName" class="btn-xs btn-secondary" type="button">Rename</button>
            </div>
            <input id="projectNameInput" class="input-text" type="text" placeholder="Project display name" autocomplete="off">
            <div id="projectIdentityMeta" class="card-sub">No Build session yet.</div>
          </div>

          <div class="card">
            <div class="card-head">
              <span class="card-title">Workspace Root Directory</span>
              <button id="btnChangeSettingsWorkspace" class="btn-xs btn-secondary" type="button">Change Folder</button>
            </div>
            <div id="settingsWorkspaceRoot" class="mono path-box truncate" title="Click to change workspace folder" style="cursor: pointer;">—</div>
          </div>
        </div>
      </section>

      <div id="sidebarResizer" class="sidebar-resizer" title="Drag to resize sidebar"></div>
    </aside>

    <!-- ============ MAIN AREA ============ -->
    <main class="app-main">
      <header class="app-header">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg>
          </span>
          <span class="brand-name">PLUTON</span>
          <span class="brand-badge">Agentic Harness</span>
        </div>
        <div id="projectSelectDropdown" class="project-selector">
          <button id="projectSelectBtn" class="project-btn" type="button" title="Switch active project" aria-haspopup="true" aria-expanded="false">
            <span class="project-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
            </span>
            <span id="projectSelectName" class="project-name">—</span>
            <span class="caret" aria-hidden="true">▾</span>
          </button>
          <div id="projectSelectMenu" class="project-menu is-hidden" role="menu"></div>
        </div>
        <div class="header-tools">
          <button id="btnToggleSplitView" class="tool-btn" type="button" title="Toggle Sub-Agents Split View">
            <span class="boat" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg></span>
            <span id="splitViewBtnLabel">Sub-Agents Split View</span>
          </button>
          <div id="connectionStatus" class="conn" title="Local runtime status">
            <span class="conn-label">Connected</span>
          </div>
        </div>
      </header>

      <div id="pinnedApprovalBanner" class="approval-banner is-hidden">
        <span class="approval-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg></span>
        <div class="approval-text">
          <div id="approvalAction" class="approval-title">Approval required</div>
          <div id="approvalReason" class="approval-reason"></div>
        </div>
        <div class="approval-actions">
          <button id="btnBannerApproveContinue" class="btn-sm btn-ok" type="button">Approve &amp; Continue</button>
          <button id="btnBannerApprove" class="btn-sm btn-primary" type="button">Approve</button>
          <button id="btnBannerDeny" class="btn-sm btn-danger" type="button">Deny</button>
        </div>
      </div>

      <div id="chatScrollContainer" class="chat-scroll">
        <div class="chat-fade" aria-hidden="true"></div>
        <div id="messagesList" class="messages"></div>
      </div>

      <!-- MAIN-AREA FILE VIEWER / EDITOR (covers the conversation while open) -->
      <section id="fileViewer" class="file-viewer is-hidden" aria-label="Workspace file viewer">
        <div id="fileTabsBar" class="file-tabs-bar" role="tablist" aria-label="Open editor tabs"></div>
        <div class="file-viewer-head">
          <div class="file-viewer-title">
            <span id="fileViewerIcon" class="file-viewer-icon" aria-hidden="true"></span>
            <span id="fileViewerPath" class="file-viewer-path mono">—</span>
            <span id="fileViewerLang" class="file-viewer-lang">text</span>
            <span id="fileViewerDirty" class="file-viewer-dirty is-hidden">unsaved</span>
          </div>
          <div class="file-viewer-actions">
            <button id="fileViewerEdit" class="btn-secondary btn-xs" type="button" title="Edit this file">Edit</button>
            <button id="fileViewerSave" class="btn-primary btn-xs is-hidden" type="button" title="Save changes (Ctrl+S)">Save</button>
            <button id="fileViewerClose" class="icon-btn" type="button" title="Close editor" aria-label="Close editor">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div id="fileViewerMeta" class="file-viewer-meta">Read-only view</div>
        <div class="code-editor">
          <div id="codeGutter" class="code-gutter" aria-hidden="true"></div>
          <div class="code-surface">
            <pre id="codeHighlight" class="code-highlight" tabindex="-1"><code id="fileCodeBody"></code></pre>
            <textarea id="fileEditorInput" class="code-input" spellcheck="false" wrap="off" autocomplete="off" autocapitalize="off" aria-label="File contents"></textarea>
          </div>
        </div>
      </section>

      <div id="buildConfirm" class="build-confirm is-hidden" role="alertdialog" aria-modal="false" aria-labelledby="buildConfirmTitle" aria-describedby="buildConfirmBody">
        <div class="build-confirm-head">
          <span id="buildConfirmTitle">Confirm supervised build</span>
          <span class="tag-mono">build</span>
        </div>
        <div id="buildConfirmBody" class="build-confirm-body">
          <div class="build-confirm-row"><span class="build-confirm-key">Operation</span><span class="build-confirm-val">Supervised build - the manager agent plans and delegates to the team</span></div>
          <div class="build-confirm-row"><span class="build-confirm-key">Workspace</span><span class="build-confirm-val mono" id="buildConfirmWorkspace">-</span></div>
          <div class="build-confirm-row"><span class="build-confirm-key">Project name</span><input id="buildConfirmProjectName" class="input-text" type="text" placeholder="Project display name" autocomplete="off"></div>
          <div class="build-confirm-row"><span class="build-confirm-key">Goal</span><span class="build-confirm-val" id="buildConfirmGoal">-</span></div>
          <div class="build-confirm-note">The first build establishes this project workspace and name. Later builds continue it without asking again. A build provisions worker containers and spends engine tokens; nothing is dispatched until you confirm.</div>
        </div>
        <div class="build-confirm-actions">
          <button id="btnBuildConfirmStart" class="btn-primary" type="button">Start build</button>
          <button id="btnBuildConfirmCancel" class="btn-secondary" type="button">Cancel</button>
        </div>
      </div>

      <div class="dock">
        <button id="btnJumpToLatest" class="jump-to-latest is-hidden" type="button" title="Jump to latest message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>
          <span>Jump to latest</span>
        </button>

        <div class="composer">
          <textarea id="promptInput" class="composer-textarea" rows="1" placeholder="Ask Pluton to plan, implement, investigate… (Enter to submit, Shift+Enter for newline)" spellcheck="false"></textarea>

          <div id="attachmentPreviewContainer" class="attachment-tray is-hidden"></div>

          <div class="composer-bar">
            <div class="composer-left">
              <div class="mode-switch" role="group" aria-label="Interaction mode">
                <button id="modeChatBtn" class="mode-btn is-active" type="button" title="Chat mode: direct conversation with active agent">Chat</button>
                <button id="modeToggleBtn" class="mode-btn" type="button" title="Toggle Plan / Build mode"><span id="modeToggleLabel">Plan</span></button>
              </div>

              <button id="btnAttach" class="tool-btn" type="button" title="Attach a workspace file to the prompt">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/></svg>
                <span class="tool-btn-text">Attach</span>
              </button>

              <button id="btnMic" class="tool-btn" type="button" title="Detect voice input">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"/></svg>
              </button>

              <div id="shipActivityBadgeContainer" class="activity-badge sea-waves is-hidden">
                <div class="activity-inner">
                  <span class="boat boat-anim" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg></span>
                  <span id="shipCountText" class="activity-text">—</span>
                </div>
                <div id="shipActivityTooltip" class="activity-tip"></div>
              </div>
            </div>

            <div class="composer-right">
              <button id="btnPrimary" class="btn-primary" type="button">
                <span id="actionBtnIcon" class="stop-square" aria-hidden="true"></span>
                <span id="actionBtnLabel">Send</span>
              </button>
            </div>
          </div>
        </div>

        <div class="status-strip">
          <div class="status-left">
            <span class="status-item status-thinking" id="thinkingStatus">
              <span id="thinkingIcon" class="status-anchor" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21M6 11h12M4 15a8 8 0 0016 0"/></svg></span>
              <span id="thinkingText">Ready</span>
              <span id="queueBadge" class="queue-badge is-hidden">0 queued</span>
            </span>
            <span class="status-divider">|</span>
            <span class="chip" id="workspaceChip" title="Workspace — click to change folder" style="cursor: pointer;">
              <span class="chip-folder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></span>
              <span id="workspaceName">—</span>
              <span class="chip-sep">·</span>
              <span id="workspacePath" class="mono">—</span>
            </span>
            <span class="status-divider">·</span>
            <span class="status-item">
              Model:
              <button id="modelLabelBtn" class="link-btn" type="button" title="Switch active model">
                <span id="activeModelName">—</span><span class="caret" aria-hidden="true">▾</span>
              </button>
            </span>
            <span class="status-divider">·</span>
            <span class="status-item" id="sbContextItem" title="Cumulative tokens the engine reported for this session. This runtime does not expose context-window usage, so no remaining-context figure is shown.">Tokens: <span id="sbContext" class="muted">not reported</span></span>
          </div>
          <div class="status-right">
            <button id="mcpToggleBtn" class="mcp-btn" type="button" title="Connected MCP servers">
              <span class="mcp-dot" aria-hidden="true"></span>
              <span class="mcp-label">MCP</span>
              <span id="mcpCountBadge" class="mcp-count">0 connected</span>
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- ============ RIGHT SHIP WORKERS INSPECTOR ============ -->
    <aside id="rightInspector" class="right-inspector is-hidden" aria-label="Ship Workers Activity Inspector" style="width: 440px;">
      <div class="right-inspector-head">
        <div class="right-inspector-title">
          <span class="inspector-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg>
          </span>
          <span>Ship Activity Inspector</span>
          <span id="rightInspectorCount" class="tag-mono">0 active</span>
        </div>
        <button id="rightInspectorClose" class="icon-btn" type="button" title="Close inspector" aria-label="Close inspector">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div id="rightInspectorGrid" class="right-inspector-grid"></div>
    </aside>
  </div>

  <!-- Searchable Select Model Dialog -->
  <div id="modelSelectModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="modelSelectTitle">
    <div class="modal-card modal-wide">
      <div class="modal-head">
        <div>
          <h3 class="modal-title" id="modelSelectTitle">Select AI Model</h3>
          <div id="modelSelectTargetShip" class="card-sub" style="margin-top: 2px;">Assign model to Ship</div>
        </div>
        <button id="modelSelectClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="model-select-search-wrap">
        <input id="modelSearchInput" type="text" placeholder="Search models by name, engine, or provider..." autocomplete="off" class="input-text">
      </div>
      <div id="modelSelectFeedback" class="card-status-text"></div>
      <div id="modelListContainer" class="model-select-list"></div>
      <div class="modal-foot">
        <span class="modal-hint">Models are validated and assigned to the selected Ship.</span>
        <button id="modelSelectCancel" class="btn-secondary" type="button">Cancel</button>
      </div>
    </div>
  </div>
  <div id="modelPopover" class="is-hidden" style="display:none;" aria-hidden="true"></div>

  <!-- MCP popover -->
  <div id="mcpPopover" class="popover popover-mcp is-hidden" role="dialog" aria-label="Connected MCP servers">
    <div class="popover-head">
      <span>Connected MCP Servers</span>
      <span id="mcpPopoverSummary" class="tag-mono">—</span>
    </div>
    <div id="mcpServersList" class="popover-body"></div>
  </div>

  <!-- Attach dialog -->
  <div id="attachModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-label="Attach a workspace file">
    <div class="modal-card modal-wide">
      <div class="modal-head">
        <h3 class="modal-title">Attach workspace file</h3>
        <button id="attachClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div id="attachFileList" class="attach-list"></div>
      <div class="modal-foot">
        <span class="modal-hint">Attached file content is sent with the prompt.</span>
        <button id="attachCancel" class="btn-secondary" type="button">Cancel</button>
      </div>
    </div>
  </div>

  <!-- New session dialog -->
  <div id="newSessionModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-label="New session">
    <div class="modal-card">
      <div class="modal-head">
        <h3 class="modal-title"><span class="modal-dot"></span>New Session</h3>
        <button id="newSessionClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <label class="field">
        <span class="field-label">Session Name</span>
        <input id="newSessionNameInput" type="text" placeholder="e.g. Code Refactor &amp; Bugfix" autocomplete="off">
      </label>
      <label class="field">
        <span class="field-label">Workspace Folder (optional)</span>
        <div style="display: flex; gap: 6px;">
          <input id="newSessionWorkspaceInput" type="text" placeholder="Default project workspace" autocomplete="off" class="mono" style="flex: 1;">
          <button id="btnNewSessionBrowseWorkspace" class="btn-secondary" type="button" title="Browse folder">Browse</button>
        </div>
      </label>
      <div class="modal-foot">
        <span class="modal-hint">The session is persisted for this project.</span>
        <button id="newSessionCancel" class="btn-secondary" type="button">Cancel</button>
        <button id="newSessionConfirm" class="btn-primary" type="button">Create Session</button>
      </div>
    </div>
  </div>

  <!-- Worker detail (authoritative task view; closing never cancels) -->
  <div id="workerDetailModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="workerDetailTitle">
    <div class="modal-card worker-detail-card">
      <div class="modal-head">
        <h3 class="modal-title" id="workerDetailTitle">Worker detail</h3>
        <div class="worker-detail-head-meta">
          <span id="workerDetailStatus" class="worker-badge-status">unknown</span>
          <button id="workerDetailClose" class="icon-btn" type="button" aria-label="Close worker detail">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div id="workerDetailBody" class="worker-detail-body"></div>
      <div class="worker-detail-foot">
        <span id="workerDetailHint" class="modal-hint">Read-only while the worker is not running.</span>
        <div class="worker-detail-compose">
          <input id="workerDetailMessageInput" type="text" autocomplete="off" placeholder="Message this worker" disabled>
          <button id="workerDetailSend" class="btn-secondary" type="button" disabled>Send</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Add Provider Dialog -->
  <div id="providerAddModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="providerAddTitle">
    <div class="modal-card">
      <div class="modal-head">
        <h3 class="modal-title" id="providerAddTitle">Add AI Provider</h3>
        <button id="providerAddClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <label class="field">
        <span class="field-label">Provider ID (slug)</span>
        <input id="providerIdInput" type="text" placeholder="e.g. openrouter, deepseek, ollama" autocomplete="off" class="input-text">
      </label>
      <label class="field">
        <span class="field-label">Engine</span>
        <select id="providerEngineSelect" class="select-box">
          <option value="openai-compatible" selected>openai-compatible (Standard HTTP)</option>
          <option value="opencode">opencode (Local CLI)</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Display Name</span>
        <input id="providerDisplayNameInput" type="text" placeholder="e.g. OpenRouter, DeepSeek" autocomplete="off" class="input-text">
      </label>
      <label class="field">
        <span class="field-label">Base URL</span>
        <input id="providerBaseUrlInput" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" class="input-text mono">
      </label>
      <label class="field">
        <span class="field-label">API Key</span>
        <input id="providerApiKeyInput" type="password" placeholder="Stored securely in private credential file" autocomplete="off" class="input-text mono">
      </label>
      <div id="providerAddStatus" class="card-status-text"></div>
      <div class="modal-foot">
        <span class="modal-hint">Key is written to 0600 file on disk; never logged or exposed.</span>
        <button id="providerAddCancel" class="btn-secondary" type="button">Cancel</button>
        <button id="btnAddProviderSubmit" class="btn-primary" type="button">Add Provider</button>
      </div>
    </div>
  </div>

  <!-- Set Provider Key Dialog -->
  <div id="providerKeyModal" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="providerKeyTitle">
    <div class="modal-card">
      <div class="modal-head">
        <h3 class="modal-title" id="providerKeyTitle">Set Provider API Key</h3>
        <button id="providerKeyClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <p id="providerKeySubtitle" class="modal-message"></p>
      <label class="field">
        <span class="field-label">New API Key</span>
        <input id="providerKeyInput" type="password" placeholder="sk-..." autocomplete="off" class="input-text mono">
      </label>
      <div id="providerKeyStatus" class="card-status-text"></div>
      <div class="modal-foot">
        <button id="providerKeyCancel" class="btn-secondary" type="button">Cancel</button>
        <button id="btnSaveProviderKey" class="btn-primary" type="button">Save Key</button>
      </div>
    </div>
  </div>

  <!-- Pluton-owned confirm / prompt dialog (no browser-native dialogs) -->
  <div id="plutonDialog" class="modal is-hidden" role="dialog" aria-modal="true" aria-labelledby="plutonDialogTitle" aria-describedby="plutonDialogMessage">
    <div class="modal-card">
      <div class="modal-head">
        <h3 class="modal-title" id="plutonDialogTitle">Confirm</h3>
        <button id="plutonDialogClose" class="icon-btn" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <p id="plutonDialogMessage" class="modal-message"></p>
      <label id="plutonDialogField" class="field is-hidden">
        <span id="plutonDialogLabel" class="field-label">Value</span>
        <input id="plutonDialogInput" type="text" autocomplete="off" class="mono">
      </label>
      <div class="modal-foot">
        <span class="modal-hint" id="plutonDialogHint"></span>
        <button id="plutonDialogCancel" class="btn-secondary" type="button">Cancel</button>
        <button id="plutonDialogConfirm" class="btn-primary" type="button">Confirm</button>
      </div>
    </div>
  </div>

  <div id="toastHost" class="toast-host"></div>

  <script src="/app.js"></script>
</body>
</html>
`,
  },

  '/app.css': {
    contentType: 'text/css; charset=utf-8',
    content: `:root {
  /* Surfaces — ChatGPT-inspired charcoal/grey */
  --bg-main: #111114;
  --bg-sidebar: #17171a;
  --bg-surface: #1e1e24;
  --bg-message-ai: #17171a;
  --bg-message-user: #212126;
  --bg-inset: #17171a;
  --bg-hover: #222228;
  --bg-active: #2a2a33;

  /* Lines */
  --border: #2a2a30;
  --border-soft: #222228;
  --border-strong: #32323a;
  --border-user: #3f3f46;

  /* Accents */
  --accent-purple: #71717a;
  --accent-purple-deep: #52525b;
  --accent-purple-soft: #a1a1aa;
  --accent-plan: #f59e0b;
  --accent-build: #60a5fa;
  --accent-cyan: #38bdf8;
  --accent-lavender: #a78bfa;
  --accent-lavender-soft: #c4b5fd;
  --accent-ok: #34d399;
  --accent-warn: #fbbf24;
  --accent-danger: #f87171;

  /* Text */
  --text: #f4f4f5;
  --text-soft: #e4e4e7;
  --text-muted: #a1a1aa;
  --text-dim: #71717a;

  --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", Consolas, "SF Mono", monospace;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  --sidebar-width: 280px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  overflow: hidden;
}

body {
  background-color: var(--bg-main);
  color: var(--text-soft);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

.mono { font-family: var(--font-mono); }
.muted { color: var(--text-muted); }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.is-hidden { display: none !important; }

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: var(--bg-main); border-radius: 999px; }
::-webkit-scrollbar-thumb { background: #27272a; border-radius: 999px; border: 1px solid rgba(255,255,255,0.02); }
::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
::selection { background: rgba(161,161,170,0.3); color: #fff; }
::-webkit-scrollbar-corner { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: #27272a var(--bg-main); }

:focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 2px; }

/* ===================== App shell ===================== */
.app-shell { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

.app-sidebar {
  position: relative;
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  max-width: 100vw;
  overflow: hidden;
  transition: width 90ms ease;
}
.app-sidebar.is-collapsed { width: 0 !important; border-right: none; }

.collapsed-toggle {
  width: 48px;
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  z-index: 15;
}
.collapsed-toggle.is-hidden { display: none; }

.sidebar-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.sidebar-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px;
  flex: 1;
  min-width: 0;
}
.tab-btn {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.tab-btn svg { width: 14px; height: 14px; flex-shrink: 0; }
.tab-btn:hover { color: var(--text); }
.tab-btn.is-active {
  background: var(--bg-active);
  color: var(--text);
  border-color: var(--border-strong);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.icon-btn svg { width: 16px; height: 16px; }
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn.is-active { background: var(--bg-active); color: var(--text); border-color: var(--border-strong); }

.sidebar-pane { flex: 1; min-height: 0; display: flex; }
.pane-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }

.sidebar-resizer {
  position: absolute;
  top: 0;
  right: 0;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}
.sidebar-resizer:hover { background: rgba(255,255,255,0.15); }

/* ===================== Sessions ===================== */
.btn-new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.btn-new:hover { border-color: var(--border-strong); background: var(--bg-hover); }

.session-list { display: flex; flex-direction: column; gap: 4px; }
.session-item {
  position: relative;
  padding: 8px 34px 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background 120ms ease;
}
.session-delete {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.session-delete svg { width: 13px; height: 13px; }
.session-item:hover .session-delete,
.session-item.is-active .session-delete,
.session-delete:focus-visible { opacity: 1; }
.session-delete:hover { color: var(--text-soft); background: var(--bg-hover); }
.session-item:hover { background: var(--bg-hover); }
.session-item.is-active { background: var(--bg-active); border-color: var(--border-strong); }
.session-title { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-item.is-active .session-title { color: #fff; }
.session-meta { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.empty-hint { padding: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5; }

/* ===================== Files ===================== */
.pane-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-muted); padding: 0 2px; }
.pane-tag { color: var(--text-muted); font-size: 11px; }
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-soft); }
.sub-tab {
  flex: 1;
  padding: 5px 4px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.sub-tab.is-active { color: var(--text); border-bottom-color: var(--text); }
.file-list { display: flex; flex-direction: column; max-height: 46vh; overflow-y: auto; }
.file-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.file-item { padding-right: 28px; }
.file-row-delete {
  position: absolute;
  top: 50%;
  right: 3px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  opacity: 0;
  cursor: pointer;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.file-row-delete svg { width: 12px; height: 12px; }
.file-row:hover .file-row-delete,
.file-row.is-active .file-row-delete,
.file-row-delete:focus-visible { opacity: 1; }
.file-row-delete:hover { color: var(--accent-danger); background: rgba(248, 113, 113, 0.12); }
.file-row:hover { background: #222228; color: var(--text); }
.file-row.is-active { background: rgba(255,255,255,0.08); color: #fff; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chevron { width: 12px; height: 12px; flex-shrink: 0; color: var(--text-dim); transition: transform 120ms ease; }
.file-dir.is-open .file-chevron { transform: rotate(90deg); }
.file-icon { width: 14px; height: 14px; flex-shrink: 0; }
.file-icon-dir { color: #f59e0b; }
.icon-ts { color: #3b82f6; }
.icon-tsx { color: #38bdf8; }
.icon-js { color: #facc15; }
.icon-jsx { color: #22d3ee; }
.icon-py { color: #60a5fa; }
.icon-json { color: #fbbf24; }
.icon-yaml { color: #a1a1aa; }
.icon-md { color: #94a3b8; }
.icon-html { color: #f97316; }
.icon-css { color: #38bdf8; }
.icon-img { color: #94a3b8; }
.icon-sh { color: #4ade80; }
.icon-manifest { color: #f43f5e; }
.icon-config { color: #a1a1aa; }
.icon-file { color: #71717a; }
.file-count { margin-left: auto; font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.file-children { display: flex; flex-direction: column; padding-left: 10px; border-left: 1px solid rgba(255, 255, 255, 0.05); margin-left: 8px; }
.file-children.is-collapsed { display: none; }

.file-search-bar {
  position: relative;
  display: flex;
  align-items: center;
  margin: 6px 0;
  padding: 0 4px;
}
.file-search-icon {
  position: absolute;
  left: 12px;
  width: 14px;
  height: 14px;
  color: var(--text-dim);
  pointer-events: none;
}
.file-search-input {
  width: 100%;
  padding: 5px 24px 5px 28px;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-family: inherit;
  font-size: 11px;
  box-sizing: border-box;
}
.file-search-input:focus {
  outline: none;
  border-color: var(--accent-cyan);
  background: rgba(255, 255, 255, 0.07);
}
.file-search-clear {
  position: absolute;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}
.file-search-clear:hover {
  color: var(--text);
}
.file-search-results {
  display: flex;
  flex-direction: column;
  max-height: 46vh;
  overflow-y: auto;
  gap: 2px;
}
.file-search-result-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.file-search-result-item:hover {
  background: #222228;
  color: var(--text);
}
.file-search-match {
  color: var(--accent-cyan);
  font-weight: 600;
}
.file-breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 4px;
}
.file-breadcrumb-segment {
  cursor: pointer;
  color: var(--text-muted);
  border-radius: 2px;
  padding: 1px 3px;
}
.file-breadcrumb-segment:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}
.file-breadcrumb-sep {
  color: var(--text-dim);
  user-select: none;
}
.file-load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  margin: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed var(--border-soft);
  border-radius: 4px;
  cursor: pointer;
}
.file-load-more:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
}
.file-tabs-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px 0;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.file-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-soft);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  max-width: 180px;
  position: relative;
}
.file-tab:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
}
.file-tab.is-active {
  background: var(--bg-main);
  color: var(--text);
  border-color: var(--border-soft);
  border-bottom: 1px solid var(--bg-main);
  margin-bottom: -1px;
  font-weight: 600;
}
.file-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-tab-dirty {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-cyan);
  flex-shrink: 0;
}
.file-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 2px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.file-tab-close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
}

/* ===================== Main-area file viewer / editor ===================== */
.file-viewer {
  position: absolute;
  top: 52px;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-main);
}
.file-viewer.is-hidden { display: none !important; }
.file-viewer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.file-viewer-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-viewer-icon { display: inline-flex; align-items: center; color: var(--text-muted); }
.file-viewer-icon svg { width: 16px; height: 16px; }
.file-viewer-path { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-viewer-lang { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); border: 1px solid var(--border-soft); border-radius: 999px; padding: 1px 7px; flex-shrink: 0; }
.file-viewer-dirty { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); flex-shrink: 0; }
.file-viewer-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.file-viewer-meta { padding: 5px 16px; border-bottom: 1px solid var(--border-soft); font-size: 11px; color: var(--text-dim); background: var(--bg-main); flex-shrink: 0; }
.code-editor { flex: 1; min-height: 0; display: flex; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.62; background: #141418; }
.code-gutter {
  flex: 0 0 auto;
  min-width: 52px;
  padding: 14px 10px 48px 12px;
  text-align: right;
  color: #4b4b55;
  background: #141418;
  border-right: 1px solid var(--border-soft);
  overflow: hidden;
  white-space: pre;
  user-select: none;
}
.code-surface { position: relative; flex: 1 1 auto; min-width: 0; }
.code-highlight,
.code-input {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 14px 20px 48px 14px;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  tab-size: 4;
  white-space: pre;
  border: none;
  border-radius: 0;
}
.code-highlight { overflow: auto; background: transparent; color: var(--text-soft); pointer-events: auto; }
.code-highlight code { font-family: inherit; font-size: inherit; line-height: inherit; }
.code-input {
  overflow: auto;
  resize: none;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: #f4f4f5;
  -webkit-text-fill-color: transparent;
}
.code-input::selection { background: rgba(161,161,170,0.30); color: transparent; }
.file-viewer.is-editing .code-highlight { overflow: hidden; pointer-events: none; }
.file-viewer:not(.is-editing) .code-input { display: none; }
.file-viewer.is-editing .code-highlight { color: var(--text-soft); }
.code-line-add { color: #6a9955; }
.code-line-del { color: #fca5a5; }
.code-line-hunk { color: #569cd6; }

/* ===================== Settings cards ===================== */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-head-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.card-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #fff; }
.card-title svg { width: 15px; height: 15px; color: var(--text-muted); }
.card-sub { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
.tag-mono { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; }
.badge-ok { background: rgba(16,185,129,0.12); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.4); }
.badge-off { background: rgba(239,68,68,0.12); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); }
.badge-warn { background: rgba(251,191,36,0.12); color: #fcd34d; border: 1px solid rgba(251,191,36,0.4); }

.kv-list { display: flex; flex-direction: column; gap: 4px; }
.kv-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; }
.kv-key { color: var(--text-muted); }
.kv-val { color: var(--text); font-family: var(--font-mono); font-size: 11px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.notice { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.45; border-radius: 6px; padding: 8px 9px; }
.notice svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px; }
.notice-warn { background: rgba(239,68,68,0.14); border: 1px solid rgba(239,68,68,0.45); color: #fca5a5; }
.notice-muted { background: var(--bg-inset); border: 1px solid var(--border); color: var(--text-muted); }

.registry { display: flex; flex-direction: column; gap: 6px; }
.registry-group { border: 1px solid var(--border-soft); border-radius: 6px; overflow: hidden; }
.registry-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: var(--bg-inset); font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
.registry-list { max-height: 160px; overflow-y: auto; }
.registry-item { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 8px; font-size: 11px; font-family: var(--font-mono); color: var(--text-soft); }
.registry-item + .registry-item { border-top: 1px solid var(--border-soft); }
.registry-item.is-current { color: var(--text); background: rgba(255,255,255,0.06); }

.muse-models { display: flex; flex-direction: column; gap: 8px; }
.muse-row { display: flex; flex-direction: column; gap: 4px; }
.muse-row-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; }
.muse-name { color: var(--text); font-weight: 600; }
.muse-role { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
select.mini-select {
  width: 100%;
  background: var(--bg-inset);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 5px 6px;
}

.permissions { display: flex; flex-direction: column; gap: 8px; }
.perm-row { display: flex; flex-direction: column; gap: 3px; }
.perm-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; }
.perm-mode { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip-perm { font-family: var(--font-mono); font-size: 11px; padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,0.05); color: var(--text-muted); }

.approvals { display: flex; flex-direction: column; gap: 6px; }
.approval-row { border: 1px solid var(--border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 5px; background: var(--bg-inset); }
.approval-row-action { font-size: 12px; font-weight: 600; color: var(--accent-warn); }
.approval-row-reason { font-size: 11px; color: var(--text-muted); }
.approval-row-actions { display: flex; gap: 5px; }

.mcp-list { display: flex; flex-direction: column; gap: 5px; }
.mcp-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg-inset); font-size: 11px; }
.mcp-item-name { font-family: var(--font-mono); color: var(--text); }
.mcp-item-detail { font-size: 11px; color: var(--text-dim); line-height: 1.4; }

.orchestra { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.orchestra-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dag-container { display: flex; flex-direction: column; gap: 10px; }
.dag-task-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px; }
.dag-task-card.state-completed { border-color: rgba(52,211,153,0.45); }
.dag-task-card.state-running, .dag-task-card.state-active { border-color: rgba(56,189,248,0.45); }
.dag-task-card.state-verifying, .dag-task-card.state-needs_approval { border-color: rgba(251,191,36,0.45); }
.dag-task-card.state-failed, .dag-task-card.state-cancelled { border-color: rgba(248,113,113,0.45); }
.dag-card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dag-task-title { font-size: 12px; font-weight: 600; color: var(--text); }
.dag-task-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.dag-task-actions { display: flex; gap: 5px; margin-top: 6px; }
.dag-flow-container { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 6px; align-items: flex-start; }
.dag-stage-col { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 6px; }
.dag-stage-header { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); border-bottom: 1px solid var(--border-soft); padding-bottom: 4px; }
.dag-flow-arrow { align-self: center; color: var(--text-muted); font-size: 12px; }
.path-box { background: var(--bg-inset); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; font-size: 11px; color: var(--text-soft); }

/* Settings: Account & Profile */
.account-box { display: flex; flex-direction: column; gap: 8px; }
.account-profile {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg-inset); border: 1px solid var(--border-soft);
  border-radius: 6px; padding: 8px 10px;
}
.account-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: #3f3f46;
  color: #fff; font-weight: 700; font-size: 13px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.account-details { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.account-name { font-size: 12px; font-weight: 600; color: var(--text); }
.account-sub { font-size: 11px; color: var(--text-dim); }
.account-form { display: flex; flex-direction: column; gap: 8px; }
.btn-xs { padding: 3px 8px; font-size: 11px; border-radius: 4px; }

/* Settings: Custom AI Model & Key */
.notice-danger {
  background: rgba(248, 113, 113, 0.08);
  border-left: 3px solid var(--accent-danger);
  color: #fca5a5; font-size: 11px; padding: 7px 10px;
  border-radius: 4px; display: flex; align-items: flex-start; gap: 8px;
}
.input-password-wrap { position: relative; display: flex; align-items: center; width: 100%; }
.input-password-wrap .input-text { padding-right: 36px; width: 100%; }
.icon-btn-ghost {
  position: absolute; right: 4px; background: transparent;
  border: none; color: var(--text-muted); cursor: pointer;
  padding: 4px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px;
}
.icon-btn-ghost:hover { color: var(--text); }
.icon-btn-ghost svg { width: 16px; height: 16px; }
.card-status-text { font-size: 11px; margin-top: 4px; }
.card-status-text.is-success { color: var(--accent-ok); }
.card-status-text.is-error { color: var(--accent-danger); }

/* Settings: Policies & Checkboxes */
.policy-toggles { display: flex; flex-direction: column; gap: 6px; }
.toggle-row {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; color: var(--text-soft); padding: 6px 9px;
  background: var(--bg-inset); border: 1px solid var(--border-soft);
  border-radius: 6px; cursor: pointer; user-select: none;
}
.toggle-row:hover { border-color: var(--border-strong); }
.checkbox-custom { accent-color: var(--text-muted); width: 16px; height: 16px; cursor: pointer; }

/* Settings: Select Box */
.select-box {
  width: 100%; background: var(--bg-inset); border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 10px; font-size: 12px;
  color: var(--text); font-family: inherit; outline: none; cursor: pointer;
}
.select-box:focus { border-color: var(--border-strong); }

/* ===================== Main column ===================== */
.app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; background: var(--bg-main); position: relative; }

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 52px;
  padding: 0 18px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px;
  background: #222228; border: 1px solid var(--border); color: var(--text);
}
.brand-mark svg { width: 20px; height: 20px; }
.brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.08em; color: #fff; }
.brand-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: #222228; border: 1px solid var(--border); color: var(--text-muted); }
.project-selector { position: relative; display: inline-flex; align-items: center; }
.project-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: #18181c; border: 1px solid var(--border-soft); border-radius: 6px;
  color: var(--text); font-size: 12px; font-weight: 500; padding: 4px 10px;
  cursor: pointer; transition: background 0.15s, border-color 0.15s; max-width: 240px;
}
.project-btn:hover { background: #222228; border-color: var(--border); }
.project-icon { display: inline-flex; align-items: center; color: var(--accent-purple-soft); }
.project-icon svg { width: 14px; height: 14px; }
.project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 100;
  min-width: 260px; max-height: 320px; overflow-y: auto;
  background: #141418; border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0,0,0,0.5); padding: 4px; display: flex; flex-direction: column; gap: 2px;
}
.project-menu-item {
  display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 5px;
  cursor: pointer; text-align: left; background: transparent; border: none; color: var(--text);
  transition: background 0.12s;
}
.project-menu-item:hover { background: var(--bg-hover); }
.project-menu-item.is-active { background: var(--bg-active); border: 1px solid var(--border-strong); }
.project-menu-item-name { font-weight: 600; font-size: 12px; display: flex; align-items: center; justify-content: space-between; }
.project-menu-item-path { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.header-tools { display: flex; align-items: center; gap: 10px; }
.conn { display: none; align-items: center; font-size: 12px; color: var(--accent-ok); }
.conn.is-offline, .conn.is-reconnected { display: inline-flex; }
.conn.is-offline { color: var(--accent-danger); }
.conn.is-reconnected { color: var(--accent-ok); }
.conn-dot { display: none; }

/* Approval banner */
.approval-banner {
  display: flex; align-items: center; gap: 10px;
  background: rgba(251,191,36,0.1);
  border-bottom: 1px solid rgba(251,191,36,0.32);
  padding: 8px 18px;
  flex-shrink: 0;
}
.approval-icon { color: var(--accent-warn); display: inline-flex; }
.approval-icon svg { width: 16px; height: 16px; }
.approval-text { flex: 1; min-width: 0; }
.approval-title { font-size: 12px; font-weight: 700; color: var(--accent-warn); }
.approval-reason { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.approval-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* ===================== Conversation ===================== */
.chat-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px 20px 8px; width: 100%; box-sizing: border-box; }
.messages { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 100%; box-sizing: border-box; }
#leftSidebar.is-collapsed ~ .app-main .messages,
.app-sidebar.is-collapsed ~ .app-main .messages { width: 100%; max-width: 100%; }

.jump-to-latest {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 24px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  background: #27272a;
  border: 1px solid #3f3f46;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.45);
  transition: opacity 150ms ease, transform 150ms ease;
}
.jump-to-latest:hover { background: #323238; color: #fff; }
.jump-to-latest svg { width: 14px; height: 14px; }
.jump-to-latest.is-hidden { display: none; }

.msg { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 100%; box-sizing: border-box; }
.msg-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
.msg-avatar { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.msg-avatar svg { width: 14px; height: 14px; }
.msg-you { color: var(--accent-cyan); }
.msg-pluton { color: var(--accent-lavender); }

.msg-thinking {
  margin: 6px 0 10px 0;
  border-radius: var(--radius-md);
  border: 1px solid rgba(167, 139, 250, 0.28);
  background: rgba(167, 139, 250, 0.05);
  overflow: hidden;
  font-size: 12.5px;
}
.msg-thinking summary {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--accent-lavender);
  background: rgba(167, 139, 250, 0.09);
  list-style: none;
}
.msg-thinking summary::-webkit-details-marker { display: none; }
.msg-thinking summary::before {
  content: '\u25b8';
  display: inline-block;
  font-size: 10px;
  transition: transform 150ms ease;
}
.msg-thinking[open] summary::before {
  transform: rotate(90deg);
}
.msg-thinking-body {
  padding: 8px 12px;
  color: var(--text-muted);
  font-family: var(--font-sans);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid rgba(167, 139, 250, 0.15);
}

.msg-user {
  align-self: stretch;
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 6px 0;
}
.msg-user .msg-head { margin-bottom: 2px; }
.msg-ai {
  align-self: stretch;
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 8px 0;
}
.msg-ai .msg-head { margin-bottom: 6px; }
.msg-body { font-size: 13px; color: var(--text-soft); line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
.msg-user .msg-body { color: var(--text); }

.msg-system { color: var(--text-muted); font-size: 12px; padding: 2px 4px; }
.msg-system .msg-body { font-size: 12px; color: var(--text-muted); }
.msg-error .msg-body { color: #fca5a5; }
/* Durable Supervisor/worker activity: quiet progress, not a chat turn. */
.msg-activity { padding: 1px 4px; gap: 2px; }
.msg-activity-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.msg-activity-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.msg-activity-actor { font-weight: 600; color: var(--text-soft); }
.msg-activity-text { overflow-wrap: anywhere; min-width: 0; }
.msg-activity-detail {
  margin-left: 44px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.msg-activity.tone-error .msg-activity-text { color: #fca5a5; }
.msg-activity.tone-warning .msg-activity-text { color: var(--accent-warn); }
.msg-activity.tone-success .msg-activity-text { color: var(--accent-ok); }
.msg-activity.tone-message .msg-activity-actor { color: var(--accent-cyan); }

.msg-body p, .msg-body ul, .msg-body ol, .msg-body blockquote { width: 100%; max-width: 100%; }
.msg-body p { margin: 0 0 8px; }
.msg-body p:last-child { margin-bottom: 0; }
.msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4 { color: #fff; margin: 12px 0 6px; line-height: 1.3; }
.msg-body h1 { font-size: 17px; } .msg-body h2 { font-size: 15px; } .msg-body h3 { font-size: 14px; } .msg-body h4 { font-size: 13px; }
.msg-body ul, .msg-body ol { margin: 0 0 8px; padding-left: 20px; }
.msg-body li { margin-bottom: 3px; }
.msg-body blockquote { margin: 0 0 8px; padding: 6px 0 6px 12px; border-left: 1px solid var(--border-strong); background: rgba(255,255,255,0.03); color: var(--text-muted); }
.msg-body hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.md-table-wrap { overflow-x: auto; margin: 0 0 10px; }
.md-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.md-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text);
  padding: 6px 10px;
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.md-table td { padding: 6px 10px; border-bottom: 1px solid var(--border-soft); color: var(--text-soft); vertical-align: top; }
.md-table tr:last-child td { border-bottom: none; }
.msg-body a { color: var(--accent-cyan); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(56,189,248,0.45); }
.msg-body a:hover { text-decoration-color: var(--accent-cyan); }
.msg-body code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: #1c1c21;
  border: 1px solid var(--border);
  color: var(--text-soft);
  padding: 1px 5px;
  border-radius: 4px;
}
.msg-body pre.code-block {
  width: 100%;
  box-sizing: border-box;
  background: #141418;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0 0 10px;
}
.msg-body pre.code-block code { background: none; border: none; padding: 0; font-size: 12px; line-height: 1.55; white-space: pre; }
.tok-cm { color: #6a9955; font-style: italic; }
.tok-st { color: #ce9178; }
.tok-kw { color: #569cd6; }
.tok-num { color: #b5cea8; }
.caret-blink { display: inline-block; width: 7px; height: 14px; background: var(--accent-cyan); vertical-align: text-bottom; animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }

/* Tool cards & Activity Timeline */
.tool-card {
  align-self: stretch;
  width: 100%;
  box-sizing: border-box;
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 2px 0;
  margin: 8px 0;
  max-width: 100%;
}
.tool-card.is-failed .tool-name,
.tool-card.is-failed .tool-status {
  color: var(--accent-danger);
}
.session-ws-chip {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-inset);
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 1px 4px;
  margin-left: 4px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}
.tool-card summary {
  list-style: none;
  cursor: pointer;
  user-select: none;
}
.tool-card summary::-webkit-details-marker {
  display: none;
}
.tool-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  background: transparent;
  cursor: pointer;
  transition: background 120ms ease;
}
.tool-card-head:hover {
  background: transparent;
}
.tool-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-chevron {
  display: inline-block;
  font-size: 9px;
  color: var(--text-dim);
  transition: transform 120ms ease;
  user-select: none;
}
details[open] > .tool-card-head .tool-chevron {
  transform: rotate(0deg);
}
details:not([open]) > .tool-card-head .tool-chevron {
  transform: rotate(-90deg);
}
.tool-summary-chip {
  font-size: 11px;
  color: var(--text-dim);
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-status {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-dim);
  flex-shrink: 0;
}
.tool-status.running,
.tool-status.succeeded { background: transparent; color: var(--text-dim); }
.tool-status.failed { background: transparent; color: var(--accent-danger); }

.tool-card-input {
  width: 100%;
  box-sizing: border-box;
  margin: 2px 0 3px 0;
  padding: 2px 0;
  background: transparent;
  border: none;
  border-radius: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}
.tool-input-prefix {
  color: var(--text-dim);
  font-weight: bold;
}
.tool-input-label {
  color: var(--text-dim);
  font-weight: 600;
  margin-right: 4px;
}

.tool-card-body {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 0 6px;
  margin: 2px 0;
  background: transparent;
  border: none;
  border-radius: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: none;
  overflow: visible;
}
.tool-card-body.is-running {
  color: var(--text-muted);
}
.tool-card-body.is-error {
  color: var(--accent-danger);
  border-color: transparent;
}
.tool-code {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  font: inherit;
  line-height: inherit;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-spinner {
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 2px solid var(--text-muted);
  border-top-color: transparent;
  border-radius: 50%;
  animation: tool-spin 0.8s linear infinite;
  vertical-align: middle;
  margin-right: 5px;
}
@keyframes tool-spin {
  to { transform: rotate(360deg); }
}

/* QA Question Card */
.qa-card {
  background: #17171a;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent-plan);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 100%;
}
.qa-card.qa-resolved {
  border-color: rgba(16, 185, 129, 0.4);
  border-left-color: var(--accent-ok);
  background: #0f171c;
}
.qa-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.qa-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}
.qa-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}
.qa-badges {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.qa-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-soft);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
}
.qa-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.qa-option-btn {
  background: var(--bg-surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.qa-option-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: #fff;
}
.qa-option-btn.is-selected {
  background: rgba(255, 255, 255, 0.12);
  border-color: #71717a;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 0 0 1px #71717a;
}
.qa-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.qa-confirm-btn {
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
}
.qa-confirm-btn.is-resolved {
  opacity: 0.6;
  cursor: not-allowed;
}
.qa-resolved-status {
  font-size: 12px;
  color: var(--accent-ok);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}

/* ===================== Composer ===================== */
.dock { position: relative; width: 100%; box-sizing: border-box; flex-shrink: 0; padding: 0 16px 10px; background: var(--bg-main); border-top: 1px solid var(--border-soft); }
.build-confirm {
  flex-shrink: 0;
  margin: 10px 16px 0;
  background: var(--bg-inset);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent-build);
  border-radius: 10px;
  overflow: hidden;
}
.build-confirm-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 12px; font-size: 12px; font-weight: 600; color: #fff;
  border-bottom: 1px solid var(--border);
}
.build-confirm-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.build-confirm-row { display: flex; gap: 10px; align-items: baseline; font-size: 12px; }
.build-confirm-key { flex: 0 0 82px; color: var(--text-muted); }
.build-confirm-val { flex: 1 1 auto; color: #fff; word-break: break-word; }
.build-confirm-row .input-text { flex: 1 1 auto; min-width: 0; padding: 4px 8px; font-size: 12px; }
.build-confirm-val.mono { font-family: var(--font-mono); font-size: 11px; }
.build-confirm-note { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-top: 2px; }
.build-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 12px 11px; }
.composer {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.composer:focus-within {
  border-color: #52525b;
  box-shadow: 0 0 0 1px rgba(161, 161, 170, 0.25);
}
.composer.mode-plan:focus-within {
  border-color: rgba(245, 158, 11, 0.6);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.3);
}
.composer.mode-build:focus-within {
  border-color: rgba(96, 165, 250, 0.6);
  box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.3);
}
.composer.mode-chat:focus-within {
  border-color: #52525b;
  box-shadow: 0 0 0 1px rgba(161, 161, 170, 0.25);
}
.composer-textarea {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  box-shadow: none;
  resize: none;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  min-height: 24px;
  max-height: 180px;
  display: block;
}
.composer-textarea:focus,
.composer-textarea:focus-visible {
  outline: none;
  box-shadow: none;
}
.composer-textarea::placeholder { color: var(--text-dim); }
.composer-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-soft); flex-wrap: wrap; }
.composer-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.composer-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.mode-switch { display: inline-flex; align-items: center; gap: 2px; padding: 2px; background: #17171a; border: 1px solid #2a2a30; border-radius: 6px; }
.mode-btn {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.mode-btn:hover { color: #fff; background: rgba(255,255,255,0.04); }
.mode-btn.is-active {
  background: #27272a;
  color: #fff;
  border-color: #3f3f46;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.mode-btn#modeToggleBtn.is-active.is-plan {
  color: var(--accent-plan);
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.12);
}
.mode-btn#modeToggleBtn.is-active.is-build {
  color: var(--accent-build);
  border-color: rgba(96, 165, 250, 0.4);
  background: rgba(96, 165, 250, 0.12);
}
.mode-btn#modeChatBtn.is-active {
  color: #fff;
  border-color: #3f3f46;
  background: #27272a;
}

.tool-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 9px;
  border-radius: 6px;
  background: transparent;
  border: 1px solid var(--border-soft);
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.tool-btn svg { width: 14px; height: 14px; }
.tool-btn:hover:not(.is-disabled) { background: var(--bg-hover); border-color: var(--border); color: var(--text); }
.tool-btn.is-disabled { opacity: 0.45; cursor: not-allowed; }
/* The mic is an icon, not a boxed control. */
#btnMic,
#btnMic:hover:not(.is-disabled) {
  padding: 4px 6px;
  background: transparent;
  border-color: transparent;
}
#btnMic.is-listening {
  color: var(--accent-danger) !important;
  border-color: transparent !important;
  background: transparent !important;
  animation: mic-pulse 1.5s infinite;
}
@keyframes mic-pulse {
  0% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.6); }
  70% { box-shadow: 0 0 0 8px rgba(248, 113, 113, 0); }
  100% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0); }
}

.activity-badge { position: relative; cursor: pointer; }
.activity-inner { display: inline-flex; align-items: center; gap: 6px; padding: 4px 2px; border-radius: 0; border: none; background: transparent; color: var(--text-muted); font-size: 12px; }
.activity-text { font-weight: 700; color: var(--text-muted); }
.boat { display: inline-flex; animation: boat 2s ease-in-out infinite; }
.boat svg { width: 16px; height: 16px; }
.card-title-mark { display: inline-flex; }
.card-title-mark svg { width: 16px; height: 16px; color: var(--text-muted); }
@keyframes boat {
  0% { transform: translateY(0) rotate(-3deg) translateX(0); }
  50% { transform: translateY(-4px) rotate(3deg) translateX(3px); }
  100% { transform: translateY(0) rotate(-3deg) translateX(0); }
}
@keyframes boat-anim {
  0% { transform: translateY(1px) rotate(-4deg); }
  50% { transform: translateY(-3px) rotate(4deg); }
  100% { transform: translateY(1px) rotate(-4deg); }
}
@keyframes sea-waves {
  0% { background-position: 0% 50%; box-shadow: 0 0 10px rgba(255,255,255,0.08); }
  50% { background-position: 100% 50%; box-shadow: 0 0 16px rgba(56,189,248,0.25); }
  100% { background-position: 0% 50%; box-shadow: 0 0 10px rgba(255,255,255,0.08); }
}
.activity-badge.sea-waves .activity-inner {
  background: transparent;
  border-color: transparent;
  animation: none;
}
.boat-anim { animation: boat-anim 1.8s ease-in-out infinite !important; }
.activity-tip {
  position: absolute; bottom: calc(100% + 6px); left: 0;
  width: 260px; padding: 8px 10px; border-radius: 6px;
  background: var(--bg-surface); border: 1px solid var(--border); box-shadow: 0 12px 30px rgba(0,0,0,0.5);
  font-size: 11px; color: var(--text-soft); display: none; z-index: 60;
}
.activity-badge:hover .activity-tip { display: block; }
.activity-tip div { padding: 2px 0; }

.btn-primary {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 14px;
  border-radius: 6px;
  background: #27272a;
  border: 1px solid #3f3f46;
  color: #f4f4f5;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease;
}
.btn-primary:hover { background: #3f3f46; color: #fff; }
.btn-primary:active { transform: scale(0.97); }
.btn-primary.is-busy { border-color: #7f1d1d; color: #fca5a5; }
.stop-square { width: 8px; height: 8px; border-radius: 2px; background: #f4f4f5; display: inline-block; }
.btn-primary.is-busy .stop-square { background: var(--accent-danger); }

.btn-secondary {
  padding: 5px 10px; border-radius: 6px;
  background: var(--bg-surface); border: 1px solid var(--border-strong);
  color: var(--text-soft); font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-secondary:hover { background: var(--bg-hover); color: #fff; }
.btn-sm { padding: 4px 9px; border-radius: 6px; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.btn-ok { background: #065f46; color: #d1fae5; border-color: #047857; }
.btn-ok:hover { background: #047857; }
.btn-danger { background: #7f1d1d; color: #fee2e2; border-color: #991b1b; }
.btn-danger:hover { background: #991b1b; }
.btn-primary.btn-sm { background: #27272a; border-color: #3f3f46; color: #fff; }
.btn-primary.btn-sm:hover { background: #3f3f46; }

/* Attachments */
.attachment-tray { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-soft); }
.attach-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border); font-size: 11px; font-family: var(--font-mono); color: var(--text-soft); }
.attach-chip button { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.attach-chip button:hover { color: var(--accent-danger); }
.attach-size { color: var(--text-dim); }

/* ===================== Status strip ===================== */
.status-strip { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 2px 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-wrap: wrap; }
.status-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.status-right { display: flex; align-items: center; gap: 8px; }
.status-item { display: inline-flex; align-items: center; gap: 5px; }
.status-anchor { color: var(--text-muted); display: inline-flex; transition: color 150ms ease; }
.status-anchor svg { width: 14px; height: 14px; }
.status-thinking { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); transition: color 150ms ease; }
.status-thinking.is-busy .status-anchor { animation: boat 1.6s ease-in-out infinite; }
.status-thinking.mode-plan.is-busy .status-anchor,
.status-thinking.mode-plan.is-busy #thinkingText { color: var(--accent-plan) !important; }
.status-thinking.mode-build.is-busy .status-anchor,
.status-thinking.mode-build.is-busy #thinkingText { color: var(--accent-build) !important; }
.status-thinking.mode-chat.is-busy .status-anchor,
.status-thinking.mode-chat.is-busy #thinkingText { color: var(--text-muted) !important; }
.status-thinking.is-error .status-anchor,
.status-thinking.is-error #thinkingText { color: var(--accent-danger) !important; }
.status-divider { color: #2a2a33; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; background: #17171a; border: 1px solid #2a2a30; color: var(--text-soft); max-width: 320px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
.chip:hover { background: #222228; border-color: #3f3f46; }
.chip-folder { display: inline-flex; color: #a1a1aa; }
.chip-folder svg { width: 14px; height: 14px; }
.chip-sep { color: #52525b; }
.chip #workspacePath { color: #d4d4d8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-btn { background: none; border: none; padding: 0; font: inherit; color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; max-width: 260px; overflow: hidden; }
.link-btn:hover { text-decoration: underline; }
.link-btn #activeModelName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caret { color: var(--text-muted); font-size: 11px; }
.mcp-btn { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-soft); font-family: inherit; font-size: 12px; cursor: pointer; }
.mcp-btn:hover { background: var(--bg-hover); }
.mcp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-cyan); }
.mcp-btn.is-zero .mcp-dot { background: #4b5563; }
.mcp-label { font-weight: 600; letter-spacing: 0.04em; }
.mcp-count { padding: 1px 6px; border-radius: 4px; background: var(--bg-inset); border: 1px solid var(--border); color: var(--text); font-size: 11px; font-weight: 600; }
.queue-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 10px; font-size: 11px; font-weight: 600; background: rgba(251, 191, 36, 0.15); color: #fcd34d; border: 1px solid rgba(251, 191, 36, 0.35); margin-left: 4px; }
.msg-user.is-queued { opacity: 0.7; }
.msg-user.is-queued .msg-meta::after { content: ' \u2022  Queued'; color: var(--accent-warn); font-weight: 600; }

/* ===================== Popovers ===================== */
.popover {
  position: fixed;
  z-index: 80;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 18px 44px rgba(0,0,0,0.55);
  font-family: var(--font-sans);
  overflow: hidden;
}
.popover-models { width: 320px; }
.popover-mcp { width: 290px; }
.popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #fff; border-bottom: 1px solid var(--border-soft); }
.popover-body { padding: 6px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.popover-item { padding: 7px 9px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
.popover-item:hover { background: var(--bg-hover); }
.popover-item.is-current { background: var(--bg-active); border-color: var(--border-strong); }
.popover-item-name { font-family: var(--font-mono); font-size: 12px; color: #fff; overflow: hidden; text-overflow: ellipsis; }
.popover-item-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.popover-item-engine { font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
.popover-empty { padding: 12px; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.mcp-popover-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: var(--bg-inset); border: 1px solid var(--border-soft); }
.mcp-popover-detail { font-size: 11px; color: var(--text-dim); line-height: 1.4; margin-top: 2px; }

/* ===================== Modals ===================== */
.modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,0.62); backdrop-filter: blur(3px); }
.modal-card { width: 100%; max-width: 420px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 24px 60px rgba(0,0,0,0.6); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.modal-wide { max-width: 560px; }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.modal-title { font-size: 14px; font-weight: 600; color: #fff; display: inline-flex; align-items: center; gap: 8px; }
.modal-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-cyan); }
.modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.modal-hint { margin-right: auto; font-size: 12px; color: var(--text-dim); }
.modal-message { margin: 0; font-size: 13px; line-height: 1.55; color: var(--text-soft); }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-soft); }
.field input {
  width: 100%;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
}
.field input:focus { border-color: var(--border-strong); }
.attach-list { max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border-soft); border-radius: 10px; padding: 6px; }
.attach-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); cursor: pointer; }
.attach-row:hover { background: var(--bg-hover); color: #fff; }
.attach-row.is-attached { background: rgba(255,255,255,0.08); color: #fff; }
.attach-row-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===================== Provider Management ===================== */
.provider-table { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.provider-card { background: var(--bg-inset); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.provider-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.provider-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.provider-name { font-size: 13px; font-weight: 600; color: #fff; }
.provider-url { font-size: 11px; color: var(--text-dim); }
.provider-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.provider-status-msg { font-size: 12px; padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.04); margin-top: 4px; }
.provider-status-msg.is-error { color: #fca5a5; background: rgba(239,68,68,0.1); }
.provider-status-msg.is-ok { color: #86efac; background: rgba(34,197,94,0.1); }

/* ===================== Searchable Model Select Dialog ===================== */
.model-select-search-wrap { margin-bottom: 8px; }
.model-select-search-wrap input { width: 100%; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; }
.model-select-list { max-height: 52vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.model-group { display: flex; flex-direction: column; gap: 4px; }
.model-group-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); padding: 4px 6px; }
.model-card-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 8px; background: var(--bg-inset); border: 1px solid var(--border-soft); cursor: pointer; transition: all 120ms ease; }
.model-card-item:hover { background: var(--bg-hover); border-color: var(--border-strong); }
.model-card-item.is-current { border-color: var(--accent-cyan); background: rgba(6,182,212,0.08); }
.model-card-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.model-card-name { font-size: 13px; font-weight: 500; color: #fff; }
.model-card-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); }
.model-avail-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.model-avail-dot.is-avail { background: #22c55e; }
.model-avail-dot.is-unavail { background: #ef4444; }

/* ===================== Toasts ===================== */
.toast-host { position: fixed; right: 18px; bottom: 18px; z-index: 120; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.toast { background: var(--bg-surface); border: 1px solid var(--border-strong); color: var(--text); padding: 9px 14px; border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,0.5); font-size: 12px; max-width: 380px; opacity: 1; transition: opacity 250ms ease; }
.toast.is-error { border-color: var(--accent-danger); color: #fca5a5; }
.toast.is-fading { opacity: 0; }
.toast { display: flex; align-items: center; gap: 12px; }
.toast-action {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid var(--border-strong);
  color: var(--text);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.toast-action:hover { background: var(--bg-hover); }
.toast-action:focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 2px; }

.sidebar-scrim {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: rgba(5,4,9,0.62);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.sidebar-scrim.is-visible { opacity: 1; pointer-events: auto; }
.chat-fade {
  position: sticky;
  top: -16px;
  height: 16px;
  margin: -16px 0 0 0;
  z-index: 5;
  pointer-events: none;
  background: linear-gradient(180deg, var(--bg-main) 40%, rgba(9,8,14,0) 100%);
}

/* ===================== Right-Side Inspector Sidebar ===================== */
.right-inspector {
  width: 440px;
  max-width: 100vw;
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
  z-index: 20;
}
.right-inspector.is-hidden {
  display: none !important;
}
.right-inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-sidebar);
  flex-shrink: 0;
}
.right-inspector-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.right-inspector-title .inspector-icon {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  color: var(--text-muted);
}
.right-inspector-grid {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  gap: 1px;
  background: var(--bg-sidebar);
}
.worker-partition {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
  overflow: hidden;
  cursor: pointer;
}
.worker-partition:last-child {
  border-bottom: none;
}
.worker-partition:focus-within {
  outline: 2px solid var(--accent-cyan);
  outline-offset: -2px;
}
.worker-partition-head:focus-visible {
  outline: 2px solid var(--accent-cyan);
  outline-offset: -2px;
}
.worker-partition:hover .worker-partition-head { background: var(--bg-hover); }
.worker-partition-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
  font-size: 11px;
  flex-shrink: 0;
  min-width: 0;
}
.worker-partition-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
  min-width: 0;
}
.worker-partition-name {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex-shrink: 0;
}
.worker-partition-task {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.worker-partition-model {
  font-size: 10px;
  color: var(--text-dim);
  background: rgba(255, 255, 255, 0.04);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
.worker-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 24px;
  text-align: center;
  color: var(--text-dim);
}
.worker-empty-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}
.worker-empty-hint {
  font-size: 11px;
  line-height: 1.5;
  max-width: 240px;
}

/* ===================== Worker Detail Modal ===================== */
.worker-detail-card {
  width: calc(100vw - 40px);
  max-width: 880px;
  max-height: 88vh;
  gap: 10px;
}
.worker-detail-head-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.worker-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-right: 4px;
}
.worker-detail-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border-soft);
  padding-top: 12px;
}
.worker-detail-compose {
  display: flex;
  gap: 6px;
  flex: 1 1 320px;
}
.worker-detail-compose input {
  flex: 1;
  min-width: 0;
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 12px;
}
.worker-detail-compose input::placeholder { color: var(--text-dim); }
.worker-detail-compose input:focus { outline: none; border-color: var(--border-strong); }
.worker-detail-compose input:disabled { color: var(--text-dim); }
.wd-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 16px;
}
.wd-kv {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
  font-size: 12px;
}
.wd-kv-label {
  flex: 0 0 104px;
  color: var(--text-dim);
}
.wd-kv-value {
  min-width: 0;
  color: var(--text-soft);
  overflow-wrap: anywhere;
}
.wd-muted {
  color: var(--text-dim);
  font-style: italic;
}
.wd-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border-soft);
  padding-top: 12px;
}
.wd-section-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.wd-empty {
  font-size: 12px;
  color: var(--text-dim);
  padding: 2px 0;
}
.wd-empty.wd-error { color: var(--accent-danger); }
.wd-prose {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wd-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-soft);
  line-height: 1.6;
}
.wd-list li { overflow-wrap: anywhere; }
.wd-activity {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wd-activity-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.wd-activity-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.wd-activity-actor { font-weight: 600; color: var(--text-soft); }
.wd-activity-text { min-width: 0; overflow-wrap: anywhere; }
.wd-activity-detail {
  flex-basis: 100%;
  margin-left: 42px;
  font-size: 11px;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.wd-activity-row.tone-error .wd-activity-text { color: #fca5a5; }
.wd-activity-row.tone-warning .wd-activity-text { color: var(--accent-warn); }
.wd-activity-row.tone-success .wd-activity-text { color: var(--accent-ok); }
.wd-tool-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wd-tool {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-soft);
}
.wd-tool-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.wd-tool-step { overflow-wrap: anywhere; }
.wd-tool.is-error .wd-tool-step { color: #fca5a5; }
.wd-file-group-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}
.wd-file-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  font-size: 12px;
  color: var(--text-soft);
}
.wd-file-list li { overflow-wrap: anywhere; padding: 1px 0; }
.wd-messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wd-message {
  border-left: 2px solid var(--border-strong);
  padding-left: 8px;
}
.wd-message.is-in { border-left-color: var(--accent-cyan); }
.wd-message-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-dim);
}
.wd-message-dir {
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
}
.wd-message-from, .wd-message-to { color: var(--text-soft); }
.wd-message-kind {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--accent-cyan);
}
.wd-message-time {
  margin-left: auto;
  font-family: var(--font-mono);
}
.wd-message-body {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 2px;
}
.wd-check-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wd-check {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-soft);
}
.wd-check-status {
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
}
.wd-check.is-passed .wd-check-status { color: var(--accent-ok); }
.wd-check.is-failed .wd-check-status { color: var(--accent-danger); }
.wd-check-meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.wd-verdict {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
}
.wd-verdict.is-passed, .wd-verdict.is-approved { color: var(--accent-ok); }
.wd-verdict.is-failed, .wd-verdict.is-rejected { color: var(--accent-danger); }
.wd-pre {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 10px;
  background: var(--bg-main);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-soft);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wd-pre.is-error { color: #fca5a5; }
@media (max-width: 760px) {
  .wd-meta-grid { grid-template-columns: minmax(0, 1fr); }
  .worker-detail-card { width: calc(100vw - 24px); max-height: 92vh; }
}
.worker-partition-workspace-line {
  padding: 3px 12px;
  font-size: 10px;
  color: var(--text-dim);
  background: rgba(0, 0, 0, 0.15);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.worker-partition-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
}
.worker-badge-status {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-muted);
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.worker-badge-status.is-running,
.worker-badge-status.is-active {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.worker-badge-status.is-waiting {
  background: rgba(251, 191, 36, 0.15);
  color: var(--accent-warn);
}
.worker-badge-status.is-failed {
  background: rgba(248, 113, 113, 0.15);
  color: var(--accent-danger);
}
.worker-badge-status.is-completed {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.worker-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-muted);
  background: var(--bg-sidebar);
  word-break: break-all;
  white-space: pre-wrap;
}
.worker-stream-entry {
  margin-bottom: 3px;
}
.worker-stream-entry.is-token {
  color: var(--text-soft);
}
.worker-stream-entry.is-tool {
  color: var(--text-muted);
}
.worker-stream-entry.is-message {
  color: var(--accent-cyan);
  opacity: 0.85;
}
.worker-stream-entry.is-err {
  color: var(--accent-danger);
}
.right-inspector-grid.has-many-workers .worker-partition,
.right-inspector-grid:has(> :nth-child(5)) .worker-partition {
  flex: 0 0 auto;
  min-height: 160px;
}

/* ===================== Responsive ===================== */
@media (max-width: 1000px) {
  .app-sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 50; box-shadow: 0 18px 44px rgba(0,0,0,0.55); width: min(440px, 100vw); max-width: 100vw; }
  .app-sidebar.is-collapsed { box-shadow: none; }
  .right-inspector { position: absolute; right: 0; top: 0; bottom: 0; z-index: 50; box-shadow: -18px 0 44px rgba(0,0,0,0.55); width: min(440px, 100vw); max-width: 100vw; }
  .worker-partition { flex: 0 0 auto; min-height: 160px; }
  .status-strip { font-size: 11px; }
  .chip { max-width: 220px; }
}

@media (prefers-reduced-motion: reduce) {
  .boat, .status-thinking.is-busy .status-anchor, .caret-blink { animation: none !important; }
  * { transition-duration: 0.01ms !important; }
}
@media (max-width: 720px) {
  .dock { padding: 0 10px 8px; }
  .chat-scroll { padding: 12px 12px 6px; }
  .messages { max-width: 100%; }
  .brand-badge { display: none; }
  .status-left { gap: 6px; }
  .link-btn { max-width: 140px; }
  .tool-btn-text { display: none; }
  .approval-actions { flex-wrap: wrap; }
}
@media (max-width: 480px) {
  .app-header { padding: 8px 10px; }
  #splitViewBtnLabel { display: none; }
  .header-tools { gap: 6px; }
  .chip { max-width: 140px; }
  .mode-switch { width: 100%; }
  .mode-btn { flex: 1 1 auto; text-align: center; padding: 4px 6px; }
  .status-strip { gap: 6px; font-size: 10px; }
}
`,
  },

  '/app.js': {
    contentType: 'application/javascript; charset=utf-8',
    content: `/**
 * PLUTON Client Application (ADR-0014).
 * Single authoritative Single-Page Application (SPA) for desktop and browser.
 *
 * Every control in this file is bound to a real runtime operation:
 *  - sessions  -> POST/GET /api/sessions
 *  - files     -> GET /api/files, GET /api/files/content
 *  - prompts   -> POST /api/sessions/:id/prompt
 *  - cancel    -> POST /api/sessions/:id/cancel, POST /api/runs/:id/cancel
 *  - build     -> POST /api/runs, POST /api/runs/:id/start
 *  - model     -> GET /api/models, POST /api/muses/:id/model
 *  - MCP       -> GET /api/mcp
 *  - approvals -> GET /api/approvals, POST /api/approvals/:id/decide
 */

(function () {
  'use strict';

  var urlParams = new URLSearchParams(window.location.search);
  var queryToken = urlParams.get('token');
  if (queryToken) {
    sessionStorage.setItem('pluton_token', queryToken);
  }
  var token = sessionStorage.getItem('pluton_token') || '';

  var MAX_ATTACH_CHARS = 48000;
  var MAX_TOTAL_ATTACH_CHARS = 120000;
  var MCP_POLL_MS = 5000;
  // Terminal run states (mirrors isTerminalRunState in src/domain/state.ts).
  // A supervised build reports through run_state frames, so the client needs
  // its own copy to know when the run is over.
  var TERMINAL_RUN_STATES = { completed: 1, failed: 1, cancelled: 1, uncertain: 1 };
  // What a live supervised run is waiting for. The generic "Thinking..." is
  // honest for a chat turn, but a build that is waiting for the operator to
  // run the verification gate is waiting for something else entirely.
  var RUN_STATUS_TEXT = {
    created: 'Starting the run...',
    active: 'The team is working...',
    verifying: 'Waiting for verification',
    awaiting_approval: 'Waiting for approval',
    awaiting_input: 'Waiting for input'
  };

  var state = {
    activeSessionId: null,
    sessions: [],
    messages: [],
    muse: null,
    workspace: null,
    models: {},
    providers: [],
    modelSelectTargetShipId: null,
    modelChoice: null,
    mcp: { connected: 0, total: 0, transportUp: false, servers: [] },
    mode: 'chat',
    buildOrPlanMode: 'plan',
    busy: false,
    queueLength: 0,
    streaming: false,
    streamingText: '',
    liveBody: null,
    // Follow-the-tail intent. The scroll listener flips it off only when the
    // operator moves the view up; appends never re-evaluate it, so a burst of
    // content taller than the threshold cannot silently stop following.
    followTail: true,
    lastScrollTop: 0,
    viewerPath: null,
    viewerOriginal: '',
    viewerEditing: false,
    viewerDiff: false,
    viewerDirty: false,
    attachments: [],
    tasks: {},
    workers: {},
    // Worker detail modal (Phase 5): the authoritative task view and its
    // debounced live-refresh handle. null while the modal is closed.
    workerDetail: null,
    // Durable activity feed (PLUTON 3.0): one item per meaningful event,
    // deduped by durable seq. activityRunId scopes the feed to one run.
    activitySeq: 0,
    activityRunId: null,
    // Set whenever the conversation DOM is replaced: the rows are gone, so the
    // cursor must be treated as unusable and the tail re-fetched once.
    activityNeedsRebuild: false,
    activityTimer: null,
    activityFetching: false,
    activityPending: false,
    rightInspectorOpen: false,
    activeRunId: null,
    selectedRunId: null,
    dagViewMode: 'flow',
    filesTabMode: 'files',
    fileList: [],
    expandedDirs: new Set(),
    dirCache: {},
    currentNavPath: '',
    searchQuery: '',
    searchResults: [],
    editorTabs: [],
    activeTabPath: null,
    sidebarTab: 'sessions',
    sidebarOpen: true,
    sidebarUserSet: false,
    sidebarWidth: '280px',
    usage: null,
    pendingApprovalId: null,
    settledRunId: null,
    buildConfirmOpen: false,
    buildDispatching: false,
    pendingBuildGoal: null,
    settings: {
      account: { username: 'pluton-developer', email: 'developer@pluton.account', connected: true },
      permissions: { autonomousToolExecution: true, parallelSubAgents: true, autoApproveReadTools: true, terminalAndBash: true },
      thinkingEffort: 'auto',
      customModels: []
    },
    speechRecognition: null,
    isRecordingVoice: false,
    projects: [],
    activeProjectId: null
  };

  // ---------------------------------------------------------------- utils
  function el(id) { return document.getElementById(id); }

  function apiHeaders() {
    var headers = { 'Content-Type': 'application/json', 'X-Pluton-Token': token };
    if (state.activeProjectId) {
      headers['X-Pluton-Project'] = state.activeProjectId;
    }
    return headers;
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    var url = new URL(path, window.location.origin);
    if (token) url.searchParams.set('token', token);
    if (state.activeProjectId && !url.searchParams.has('projectId') && !url.searchParams.has('project') && !path.startsWith('/api/projects')) {
      url.searchParams.set('projectId', state.activeProjectId);
    }
    var res = await fetch(url.toString(), {
      method: opts.method || 'GET',
      headers: Object.assign(apiHeaders(), opts.headers || {}),
      body: opts.body
    });
    var payload = null;
    try { payload = await res.json(); } catch (e) { payload = null; }
    if (!res.ok) {
      var message = payload && payload.error ? payload.error : ('Request failed (' + res.status + ')');
      var err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Show a transient message, optionally with one action.
   *
   * An action is attached ONLY to an operation that has a genuine, safe
   * inverse - today that is a model switch, which is undone by switching back
   * to the model that was active before. Operations with no inverse (sending a
   * prompt, starting or cancelling a run, deciding an approval) get no
   * action: a button that pretends to undo them would be a lie.
   */
  function toast(message, isError, action) {
    var host = el('toastHost');
    if (!host) return;
    var node = document.createElement('div');
    node.className = 'toast' + (isError ? ' is-error' : '');
    var text = document.createElement('span');
    text.textContent = message;
    node.appendChild(text);
    if (action && action.label && typeof action.run === 'function') {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function () {
        node.remove();
        action.run();
      });
      node.appendChild(btn);
    }
    host.appendChild(node);
    setTimeout(function () {
      node.classList.add('is-fading');
      setTimeout(function () { node.remove(); }, 300);
    }, action ? 8000 : 3800);
  }

  // ------------------------------------------------------ Pluton dialogs
  /**
   * A Pluton-owned confirm/prompt surface. Browser-native window.confirm
   * and window.prompt are never used: they render outside the app, ignore
   * the theme, and cannot show a safe destructive-action treatment.
   *
   * openPlutonDialog resolves with true/false for a confirm, or the string
   * value / null for a prompt. Only one dialog exists at a time.
   */
  var plutonDialogState = null;

  function closePlutonDialog(value) {
    var modal = el('plutonDialog');
    var pending = plutonDialogState;
    plutonDialogState = null;
    if (modal) modal.classList.add('is-hidden');
    var input = el('plutonDialogInput');
    if (input) input.value = '';
    if (pending) pending.resolve(value);
  }

  function openPlutonDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = el('plutonDialog');
      if (!modal) {
        resolve(opts.input ? null : false);
        return;
      }
      // Replacing an open dialog settles the previous promise as cancelled so
      // no caller is left awaiting a surface that no longer exists.
      if (plutonDialogState) {
        var stale = plutonDialogState;
        plutonDialogState = null;
        stale.resolve(stale.input ? null : false);
      }
      plutonDialogState = { resolve: resolve, input: !!opts.input };
      var title = el('plutonDialogTitle');
      var message = el('plutonDialogMessage');
      var field = el('plutonDialogField');
      var label = el('plutonDialogLabel');
      var input = el('plutonDialogInput');
      var hint = el('plutonDialogHint');
      var confirmBtn = el('plutonDialogConfirm');
      var cancelBtn = el('plutonDialogCancel');
      if (title) title.textContent = opts.title || 'Confirm';
      if (message) message.textContent = opts.message || '';
      if (field) field.classList.toggle('is-hidden', !opts.input);
      if (label) label.textContent = opts.label || 'Value';
      if (input) {
        input.value = opts.value || '';
        input.placeholder = opts.placeholder || '';
      }
      if (hint) hint.textContent = opts.hint || '';
      if (confirmBtn) {
        confirmBtn.textContent = opts.confirmLabel || 'Confirm';
        confirmBtn.classList.toggle('btn-danger', opts.danger === true);
        confirmBtn.classList.toggle('btn-primary', opts.danger !== true);
      }
      if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      modal.classList.remove('is-hidden');
      setTimeout(function () {
        if (opts.input && input) {
          input.focus();
          input.select();
        } else if (confirmBtn) {
          confirmBtn.focus();
        }
      }, 0);
    });
  }

  function plutonConfirm(opts) {
    return openPlutonDialog(Object.assign({}, opts, { input: false })).then(function (value) {
      return value === true;
    });
  }

  function plutonPrompt(opts) {
    return openPlutonDialog(Object.assign({}, opts, { input: true })).then(function (value) {
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    });
  }

  // ---------------------------------------------------------- code markup
  var KEYWORDS = 'def|elif|else|except|finally|for|if|lambda|pass|raise|return|try|while|yield|true|false|null|and|or|not|in|is|None|True|False|async|await|break|class|const|continue|def|delete|do|echo|elif|else|export|extends|fn|function|import|instanceof|interface|let|new|of|private|protected|public|readonly|static|struct|super|switch|this|throw|try|type|typeof|var|void|with|yield|self|mut|pub|use|mod|match';

  // The regex source is assembled from character codes: the SPA payload is a
  // template literal, so embedding quote/backslash characters literally here
  // would be re-escaped by the outer layer.
  var BS = String.fromCharCode(92);
  var SQ = String.fromCharCode(39);
  var DQ = String.fromCharCode(34);
  var BT = String.fromCharCode(96);
  var ESC_SLASH = BS + '/';

  function highlightCode(code, lang) {
    var l = String(lang || '').toLowerCase();
    var hashLang = /^(bash|sh|shell|zsh|python|py|yaml|yml|ini|toml|conf)$/.test(l);
    var comment = '(' + ESC_SLASH + ESC_SLASH + '[^' + BS + 'n]*|' +
      ESC_SLASH + BS + '*[' + BS + 's' + BS + 'S]*?' + BS + '*' + ESC_SLASH + ')';
    if (hashLang) comment += '|#[^' + BS + 'n]*';
    var strings = '(' + SQ + '(?:' + BS + BS + '.|[^' + SQ + BS + BS + '])*' + SQ +
      '|' + DQ + '(?:' + BS + BS + '.|[^' + DQ + BS + BS + '])*' + DQ +
      '|' + BT + '(?:' + BS + BS + '.|[^' + BT + BS + BS + '])*' + BT + ')';
    var re = new RegExp(
      comment + '|' + strings +
      '|' + BS + 'b(' + KEYWORDS + ')' + BS + 'b' +
      '|' + BS + 'b(' + BS + 'd+(?:' + BS + '.' + BS + 'd+)?)' + BS + 'b',
      'g'
    );
    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(code)) !== null) {
      out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += '<span class="tok-cm">' + escapeHtml(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tok-st">' + escapeHtml(m[2]) + '</span>';
      else if (m[3]) out += '<span class="tok-kw">' + escapeHtml(m[3]) + '</span>';
      else if (m[4]) out += '<span class="tok-num">' + escapeHtml(m[4]) + '</span>';
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    out += escapeHtml(code.slice(last));
    return out;
  }

  // ------------------------------------------------------------- markdown
  function inlineMarkdown(src) {
    var out = escapeHtml(src);
    var codes = [];
    out = out.replace(/\`([^\`]+)\`/g, function (m, c) {
      codes.push(c);
      return '\\u0000CODE' + (codes.length - 1) + '\\u0000';
    });
    out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (m, label, href) {
      var clean = href.replace(/&amp;/g, '&');
      if (!/^(https?:|mailto:|\\/|#)/i.test(clean)) return label;
      return '<a href="' + escapeHtml(clean) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    out = out.replace(/\\u0000CODE(\\d+)\\u0000/g, function (m, i) {
      return '<code>' + codes[Number(i)] + '</code>';
    });
    return out;
  }

  function renderMarkdown(source) {
    var text = source === null || source === undefined ? '' : String(source);
    var thinkPrefix = '';
    text = text.replace(/<think>([\\s\\S]*?)(?:<\\/think>|$)/gi, function (_, thought) {
      if (thought.trim()) {
        thinkPrefix += '<details class="msg-thinking">' +
          '<summary><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>Thinking</summary>' +
          '<div class="msg-thinking-body">' + escapeHtml(thought.trim()) + '</div>' +
          '</details>';
      }
      return '';
    });
    var lines = text.split('\\n');
    var html = '';
    var inCode = false;
    var codeLang = '';
    var codeBuf = [];
    var listStack = [];
    var para = [];

    function flushPara() {
      if (para.length > 0) {
        html += '<p>' + inlineMarkdown(para.join('\\n')) + '</p>';
        para = [];
      }
    }
    function closeLists() {
      while (listStack.length > 0) {
        html += listStack.pop() === 'ul' ? '</ul>' : '</ol>';
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\\s*\`\`\`(\\S*)\\s*$/.exec(line);
      if (fence) {
        if (!inCode) {
          flushPara(); closeLists();
          inCode = true; codeLang = fence[1] || ''; codeBuf = [];
        } else {
          html += '<pre class="code-block"><code>' + highlightCode(codeBuf.join('\\n'), codeLang) + '</code></pre>';
          inCode = false; codeBuf = [];
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      if (/^\\s*$/.test(line)) { flushPara(); closeLists(); continue; }

      var heading = /^(#{1,6})\\s+(.*)$/.exec(line);
      if (heading) {
        flushPara(); closeLists();
        var lvl = Math.min(heading[1].length, 6);
        html += '<h' + lvl + '>' + inlineMarkdown(heading[2]) + '</h' + lvl + '>';
        continue;
      }
      if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) {
        flushPara(); closeLists();
        html += '<hr>';
        continue;
      }
      var quote = /^\\s*>\\s?(.*)$/.exec(line);
      if (quote) {
        flushPara(); closeLists();
        html += '<blockquote>' + inlineMarkdown(quote[1]) + '</blockquote>';
        continue;
      }
      // GFM pipe table: a header row followed by a delimiter row.
      var DELIM = /^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$/;
      var looksRow = function (l) { return l.indexOf('|') >= 0 && l.trim().length > 1; };
      if (looksRow(line) && i + 1 < lines.length && lines[i + 1].indexOf('|') >= 0 && DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        flushPara(); closeLists();
        var cellsOf = function (l) {
          var s = l.trim();
          if (s.charAt(0) === '|') s = s.slice(1);
          if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
          return s.split('|').map(function (c) { return c.trim(); });
        };
        html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
        cellsOf(line).forEach(function (h) { html += '<th>' + inlineMarkdown(h) + '</th>'; });
        html += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && looksRow(lines[i])) {
          html += '<tr>';
          cellsOf(lines[i]).forEach(function (c) { html += '<td>' + inlineMarkdown(c) + '</td>'; });
          html += '</tr>';
          i++;
        }
        i--;
        html += '</tbody></table></div>';
        continue;
      }
      var ul = /^\\s*[-*+]\\s+(.*)$/.exec(line);
      var ol = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        var want = ul ? 'ul' : 'ol';
        if (listStack[listStack.length - 1] !== want) {
          closeLists();
          html += want === 'ul' ? '<ul>' : '<ol>';
          listStack.push(want);
        }
        html += '<li>' + inlineMarkdown((ul || ol)[1]) + '</li>';
        continue;
      }
      para.push(line);
    }
    if (inCode) {
      html += '<pre class="code-block"><code>' + highlightCode(codeBuf.join('\\n'), codeLang) + '</code></pre>';
    }
    flushPara();
    closeLists();
    return thinkPrefix + html;
  }

  // ------------------------------------------------------------- messages
  var USER_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>';
  var ANCHOR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"></circle><path d="M12 7.5V21M6 11h12M4 15a8 8 0 0016 0"></path></svg>';

  function buildMessage(role, html, extraClass) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-' + role + (extraClass ? ' ' + extraClass : '');
    var head = document.createElement('div');
    head.className = 'msg-head';
    if (role === 'user') {
      head.innerHTML = '<span class="msg-avatar msg-you">' + USER_ICON + '</span><span class="msg-you">You</span>';
    } else if (role === 'assistant') {
      head.innerHTML = '<span class="msg-avatar msg-pluton" aria-hidden="true">' + ANCHOR_ICON + '</span><span class="msg-pluton">PLUTON</span>';
    } else {
      head.innerHTML = '<span class="msg-avatar msg-pluton" aria-hidden="true">' + ANCHOR_ICON + '</span><span class="msg-pluton">PLUTON</span>';
    }
    var body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = html;
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  function isNearBottom() {
    var box = el('chatScrollContainer');
    if (!box) return true;
    return (box.scrollHeight - box.scrollTop - box.clientHeight) <= 80;
  }

  function maybeScroll(force, smooth) {
    var box = el('chatScrollContainer');
    if (!box) return;
    var jumpBtn = el('btnJumpToLatest');
    if (force) state.followTail = true;
    if (state.followTail) {
      if (smooth && typeof box.scrollTo === 'function') {
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
      } else {
        box.scrollTop = box.scrollHeight;
      }
      state.lastScrollTop = box.scrollTop;
      if (jumpBtn) jumpBtn.classList.add('is-hidden');
    } else {
      if (jumpBtn) jumpBtn.classList.remove('is-hidden');
    }
  }

  /**
   * The scroll listener owns follow intent. A programmatic follow (append or
   * the smooth jump) only ever moves the view DOWN, so an upward move alone
   * pauses following; reaching the bottom always resumes it.
   */
  function onChatScroll() {
    var box = el('chatScrollContainer');
    if (!box) return;
    var top = box.scrollTop;
    var atBottom = isNearBottom();
    if (atBottom) {
      state.followTail = true;
    } else if (top < state.lastScrollTop - 2) {
      state.followTail = false;
    }
    state.lastScrollTop = top;
    var jumpBtn = el('btnJumpToLatest');
    if (jumpBtn) {
      if (state.followTail) jumpBtn.classList.add('is-hidden');
      else jumpBtn.classList.remove('is-hidden');
    }
  }

  /**
   * Bounded live message history: durable storage keeps the whole transcript
   * (and a session reload replays ALL of it — renderTranscript sets
   * state.bulkRendering, so bulk renders never trim). LIVE appends drop only
   * the oldest node, only while the operator follows the bottom (isNearBottom,
   * same 80 px threshold as the auto-scroll test) — a fast tool/worker burst
   * cannot grow the DOM forever, and scrolled-up reading never loses position.
   */
  var MAX_MESSAGES_DOM = 400;

  function trimMessagesList() {
    if (state.bulkRendering) return;
    var list = el('messagesList');
    if (!list) return;
    while (list.childElementCount > MAX_MESSAGES_DOM && isNearBottom()) {
      list.removeChild(list.firstElementChild);
    }
  }

  function appendMessage(role, html, extraClass) {
    var list = el('messagesList');
    if (!list) return null;
    var node = buildMessage(role, html, extraClass);
    list.appendChild(node);
    trimMessagesList();
    if (!state.bulkRendering) maybeScroll(false);
    return node;
  }

  function appendPlain(role, text, extraClass) {
    return appendMessage(role, renderMarkdown(text), extraClass);
  }

  function renderTranscript(messages) {
    var list = el('messagesList');
    if (!list) return;
    list.innerHTML = '';
    // Durable activity rows live in the same list that was just wiped. Their
    // cursor is only valid for the DOM that showed them, so re-derive them
    // instead of leaving a high cursor that would hide them forever.
    resetRunActivityView();
    state.liveBody = null;
    state.streamingText = '';
    if (!messages || messages.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'msg msg-system';
      hint.innerHTML = '<div class="msg-body">No messages in this session yet. Ask Pluton to plan, implement, or investigate.</div>';
      list.appendChild(hint);
      return;
    }
    // Full replay: every persisted message renders — the live-history trim
    // below this is suspended while this bulk render is in progress.
    state.bulkRendering = true;
    try {
      messages.forEach(function (msg) {
        if (msg.role === 'tool') {
          appendToolEvent({ name: 'tool', summary: msg.text, status: 'succeeded', output: '' });
        } else if (msg.role === 'system') {
          appendPlain('system', msg.text);
        } else {
          appendPlain(msg.role === 'user' ? 'user' : 'assistant', msg.text);
        }
      });
    } finally {
      state.bulkRendering = false;
    }
    maybeScroll(true);
  }

  // ------------------------------------------------------- durable activity
  // Concise Supervisor progress in the main conversation. Items come from the
  // durable event log (SSE run_activity frames or the seq-resumable REST
  // endpoint), never from guesses: seq is the dedupe and recovery key.
  var RUN_ACTIVITY_TONES = { info: 1, success: 1, warning: 1, error: 1, message: 1 };

  function clearRunActivity() {
    var list = el('messagesList');
    if (list) {
      var nodes = list.querySelectorAll('.msg-activity');
      Array.prototype.forEach.call(nodes, function (node) { node.remove(); });
    }
    state.activitySeq = 0;
    state.activityRunId = null;
    state.activityNeedsRebuild = false;
    if (state.activityTimer) {
      clearTimeout(state.activityTimer);
      state.activityTimer = null;
    }
  }

  /**
   * The conversation DOM was replaced (session switch / full transcript
   * render): drop the durable cursor so loadRunActivity re-fetches the last
   * window for the run. A live frame may still land first, so the next fetch
   * must use the tail window rather than resuming from that frame's seq.
   */
  function resetRunActivityView() {
    state.activitySeq = 0;
    state.activityRunId = null;
    state.activityNeedsRebuild = true;
    if (state.activityTimer) {
      clearTimeout(state.activityTimer);
      state.activityTimer = null;
    }
  }

  function appendRunActivity(item) {
    if (!item || typeof item.seq !== 'number') return false;
    if (state.activityRunId !== null && item.runId && item.runId !== state.activityRunId) return false;
    if (item.seq <= state.activitySeq) return false;
    var list = el('messagesList');
    if (!list) return false;
    var tone = RUN_ACTIVITY_TONES[item.tone] ? item.tone : 'info';
    var row = document.createElement('div');
    row.className = 'msg msg-activity tone-' + tone;
    row.setAttribute('data-activity-seq', String(item.seq));
    var time = formatTime(item.at);
    var html = '<div class="msg-activity-line">' +
      (time ? '<span class="msg-activity-time">' + escapeHtml(time) + '</span>' : '') +
      '<span class="msg-activity-actor">' + escapeHtml(item.actorLabel || 'Pluton') + '</span>' +
      '<span class="msg-activity-text">' + escapeHtml(redactSecrets(item.text || '')) + '</span>' +
      '</div>';
    if (item.detail) {
      html += '<div class="msg-activity-detail">' + escapeHtml(redactSecrets(item.detail)) + '</div>';
    }
    row.innerHTML = html;
    list.appendChild(row);
    state.activitySeq = item.seq;
    trimMessagesList();
    if (!state.bulkRendering) maybeScroll(false);
    return true;
  }

  async function loadRunActivity(runId) {
    if (!runId) return;
    if (state.activityRunId !== runId) {
      clearRunActivity();
      state.activityRunId = runId;
    }
    // One request at a time: a burst of worker frames must not open parallel
    // fetches that can render out of order. A pending flag coalesces them.
    if (state.activityFetching) {
      state.activityPending = true;
      return;
    }
    state.activityFetching = true;
    try {
      // A rebuilt DOM has no rows, so a cursor-only resume would skip the
      // window it is missing. Fetch the tail once, then resume by seq.
      var rebuild = state.activityNeedsRebuild === true || state.activitySeq <= 0;
      var res = await apiFetch('/api/runs/' + encodeURIComponent(runId) + '/activity?' +
        (rebuild ? 'tail=1&limit=200' : 'afterSeq=' + encodeURIComponent(state.activitySeq)));
      var items = res && res.activity && Array.isArray(res.activity.activity) ? res.activity.activity : [];
      items.forEach(appendRunActivity);
      state.activityNeedsRebuild = false;
    } catch (err) {
      // Activity is auxiliary: a transient failure must not break run loading.
      // The next event (or reconnect) retries from the same durable cursor.
    } finally {
      state.activityFetching = false;
      if (state.activityPending) {
        state.activityPending = false;
        scheduleActivityRefresh();
      }
    }
  }

  function scheduleActivityRefresh() {
    if (!state.activeRunId || state.activityTimer) return;
    state.activityTimer = setTimeout(function () {
      state.activityTimer = null;
      loadRunActivity(state.activeRunId);
    }, 250);
  }

  function handleRunActivityFrame(activity) {
    if (!activity || typeof activity.seq !== 'number' || !activity.runId) return;
    if (state.activeRunId && activity.runId !== state.activeRunId) return;
    if (!state.activeRunId) state.activeRunId = activity.runId;
    if (state.activityRunId !== activity.runId) {
      // A pending tail rebuild is about the conversation DOM, not the run:
      // an early live frame must not cancel it, or the earlier window is lost.
      var rebuilding = state.activityNeedsRebuild === true;
      clearRunActivity();
      state.activityRunId = activity.runId;
      state.activityNeedsRebuild = rebuilding;
    }
    appendRunActivity(activity);
    if (state.workerDetail && activity.taskId === state.workerDetail.taskId) {
      scheduleWorkerDetailRefresh();
    }
  }

  /**
   * Display-time prose-secret redaction. This pattern set DELIBERATELY
   * mirrors src/util/redact.ts (PROSE_SECRET_PATTERNS / redactProseSecrets):
   * the server redacts at-rest surfaces, the SPA redacts at display — a
   * pattern change on either side must be applied to both (the spa-ui parity
   * test enforces it). Do not add patterns here without adding them there.
   */
  function redactSecrets(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/(sk-[a-zA-Z0-9_-]{16,})/g, 'sk-[REDACTED]')
      .replace(/(bearer[ \\t]+)[a-zA-Z0-9_.-]{20,}/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|password|token|secret)[ \\t]*[:=][ \\t]*["']?)[^ \\t\\r\\n"']+/gi, '$1[REDACTED]');
  }

  var TOOL_CODE_EXTENSIONS = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'css', html: 'html',
    htm: 'html', md: 'markdown', sql: 'sql', go: 'go', rs: 'rust',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', toml: 'toml', ini: 'ini'
  };

  function langFromPath(path) {
    var p = String(path || '').toLowerCase();
    var dot = p.lastIndexOf('.');
    if (dot < 0) return '';
    return TOOL_CODE_EXTENSIONS[p.slice(dot + 1)] || '';
  }

  /**
   * Infer a language for tool output only from trustworthy signals: a file
   * path on the call, a file-oriented tool whose summary names a path, a body
   * that parses as JSON, or a shell shebang. Shell prose and logs stay plain —
   * being colourful is worth less than being correct.
   */
  function guessToolCodeLang(tool, output) {
    if (tool && tool.input && typeof tool.input === 'object') {
      var p = tool.input.path || tool.input.file_path;
      if (typeof p === 'string' && p.trim()) {
        var inputLang = langFromPath(p);
        if (inputLang) return inputLang;
      }
    }
    var toolName = String((tool && tool.name) || '').toLowerCase();
    var fileTool = /(read|write|edit|create|view|open|patch|apply)/.test(toolName);
    if (fileTool && tool && typeof tool.summary === 'string') {
      var named = tool.summary.match(/[\\w./\\-]+\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|py|sh|bash|zsh|yml|yaml|css|scss|html|htm|md|sql|go|rs|java|c|h|cpp|hpp|toml|ini)\\b/i);
      if (named) {
        var summaryLang = langFromPath(named[0]);
        if (summaryLang) return summaryLang;
      }
    }
    if (typeof output === 'string') {
      var trimmed = output.trim();
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        try { JSON.parse(trimmed); return 'json'; } catch (e) {}
      }
      if (/^#!.*\\b(?:bash|sh|zsh)\\b/.test(trimmed)) return 'bash';
    }
    return '';
  }

  function formatToolOutput(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
      .replace(/\\r\\n/g, '\\n')
      .replace(/(\\n[ \\t]*){3,}\\n/g, '\\n\\n')
      .replace(/\\t/g, '  ')
      .trim();
  }

  function formatToolInput(input) {
    if (!input) return '';
    if (typeof input === 'string') {
      var trimmed = input.trim();
      return trimmed ? '<span class="tool-input-prefix">$</span> ' + escapeHtml(redactSecrets(trimmed)) : '';
    }
    if (typeof input === 'object') {
      if (typeof input.command === 'string' && input.command.trim()) {
        return '<span class="tool-input-prefix">$</span> ' + escapeHtml(redactSecrets(input.command.trim()));
      }
      if (typeof input.url === 'string' && input.url.trim()) {
        return '<span class="tool-input-label">URL:</span> ' + escapeHtml(redactSecrets(input.url.trim()));
      }
      if (typeof input.path === 'string' || typeof input.file_path === 'string') {
        var p = (input.path || input.file_path || '').trim();
        var extra = '';
        if (typeof input.pattern === 'string' && input.pattern.trim()) {
          extra = ' <span class="tool-input-label">Pattern:</span> ' + escapeHtml(redactSecrets(input.pattern.trim()));
        }
        return '<span class="tool-input-label">Path:</span> ' + escapeHtml(redactSecrets(p)) + extra;
      }
      if (typeof input.query === 'string' && input.query.trim()) {
        return '<span class="tool-input-label">Query:</span> ' + escapeHtml(redactSecrets(input.query.trim()));
      }
      if (typeof input.pattern === 'string' && input.pattern.trim()) {
        return '<span class="tool-input-label">Pattern:</span> ' + escapeHtml(redactSecrets(input.pattern.trim()));
      }
      try {
        var str = JSON.stringify(input, null, 2);
        if (str && str.length < 300 && str !== '{}') {
          return escapeHtml(redactSecrets(str));
        }
      } catch (e) {}
    }
    return '';
  }

  /**
   * Internal plumbing the operator does not need to see: skill loading and
   * todo/plan bookkeeping are harness mechanics, not work on the user's task.
   * Real work (file reads/writes, searches, commands, tests) always renders.
   */
  function isInternalToolName(name) {
    var n = String(name || '').toLowerCase().trim();
    n = n.replace(/^mcp[._-]{1,2}[a-z0-9-]+[._-]{1,2}/, '');
    return /^(?:skill|skills|loadskill|useskill|todo|todos|todowrite|todoread|todo_write|todo_read|updateplan|update_plan|setplan|set_plan|listmcpresources|list_mcp_resources|readmcpresource|read_mcp_resource)(?:$|[._-])/.test(n);
  }

  function appendToolEvent(tool) {
    if (isInternalToolName(tool && tool.name)) return;
    var list = el('messagesList');
    if (!list) return;
    var toolId = tool.id || tool.callId || tool.name || '';
    var existing = toolId ? list.querySelector('.tool-card[data-tool-id="' + escapeHtml(toolId) + '"]') : null;

    var status = tool.status || 'succeeded';
    var name = escapeHtml(tool.name || 'tool');
    var rawSummary = tool.summary || '';
    if (existing) {
      if (tool.input) {
        existing._toolInput = tool.input;
      } else if (existing._toolInput) {
        tool.input = existing._toolInput;
      }
      if (rawSummary && rawSummary !== tool.name) {
        existing._toolSummary = rawSummary;
      } else if (existing._toolSummary) {
        rawSummary = existing._toolSummary;
      }
    }

    if (!tool.summary && rawSummary) {
      tool.summary = rawSummary;
    }
    var summary = escapeHtml(redactSecrets(tool.summary || ''));
    if (tool.output && typeof tool.output !== 'string') {
      try { tool.output = JSON.stringify(tool.output, null, 2); } catch (e) {}
    }
    var cleanedOutput = formatToolOutput(redactSecrets(tool.output || ''));
    var escapedOutput = escapeHtml(cleanedOutput);
    // Only code-like output is tokenised: a shell log is not source code.
    var codeLang = cleanedOutput ? guessToolCodeLang(tool, cleanedOutput) : '';
    var outputHtml = codeLang
      ? '<pre class="tool-code"><code>' + highlightCode(cleanedOutput, codeLang) + '</code></pre>'
      : escapedOutput;

    var inputHtml = formatToolInput(tool.input);
    var inputSection = inputHtml ? '<div class="tool-card-input">' + inputHtml + '</div>' : '';

    var bodyHtml = '';
    if (status === 'running') {
      bodyHtml = '<div class="tool-card-body is-running">' +
        (outputHtml ? outputHtml + '\\n' : '') +
        '<span class="tool-spinner"></span> <span class="tool-running-text">Running...</span>' +
        '</div>';
    } else if (outputHtml) {
      bodyHtml = '<div class="tool-card-body">' + outputHtml + '</div>';
    } else if (status === 'failed') {
      bodyHtml = '<div class="tool-card-body is-error muted">[Tool execution failed with no output]</div>';
    } else {
      bodyHtml = '<div class="tool-card-body muted">[No output returned]</div>';
    }

    var statusLabel = status === 'running' ? 'Running' : (status === 'succeeded' ? 'Completed' : (status === 'failed' ? 'Failed' : status));

    var head = '<summary class="tool-card-head">' +
      '<div class="tool-name"><span class="tool-chevron">▾</span>' + name +
      (summary && summary !== name ? ' <span class="tool-summary-chip">' + summary + '</span>' : '') +
      '</div><span class="tool-status ' + escapeHtml(status) + '">' + escapeHtml(statusLabel) + '</span>' +
      '</summary>';

    var fullContent = head + inputSection + bodyHtml;

    if (existing) {
      existing.setAttribute('data-status', status);
      existing.innerHTML = fullContent;
      existing.open = true;
      if (status === 'failed') {
        existing.classList.add('is-failed');
      } else {
        existing.classList.remove('is-failed');
      }
    } else {
      var card = document.createElement('details');
      card.className = 'tool-card activity-timeline-node' + (status === 'failed' ? ' is-failed' : '');
      if (toolId) {
        card.setAttribute('data-tool-id', toolId);
        card.setAttribute('data-call-id', toolId);
      }
      card.setAttribute('data-status', status);
      if (tool.input) card._toolInput = tool.input;
      if (rawSummary && rawSummary !== tool.name) card._toolSummary = rawSummary;
      card.innerHTML = fullContent;
      card.open = true;
      list.appendChild(card);
      trimMessagesList();
    }
    if (!state.bulkRendering) maybeScroll(false);
  }

  /**
   * Streaming renders coalesce to at most ONE markdown render + innerHTML swap
   * per animation frame (fallback 33 ms timer) instead of one per token.
   * Previously every token re-rendered the full accumulated turn through the
   * markdown pipeline: O(n^2) bytes processed across a long stream plus a full
   * DOM parse per token, which stuttered long streaming turns. Received text
   * always accumulates in state.streamingText first, so a scheduled flush can
   * never lose the tail — finalize flushes synchronously before the body is
   * cleared. Time-to-first-output stays instant: the turn's first token flushes
   * synchronously.
   */
  var streamFlushPending = false;

  function flushStreamingToken() {
    streamFlushPending = false;
    var body = state.liveBody;
    if (!body) return;
    var html = '';
    if (state.streamingThought && state.streamingThought.trim()) {
      var isStillThinking = !state.streamingText;
      html += '<details class="msg-thinking"' + (isStillThinking ? ' open' : '') + '>' +
        '<summary><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>Thinking' + (isStillThinking ? '\u2026' : '') + '</summary>' +
        '<div class="msg-thinking-body">' + escapeHtml(state.streamingThought.trim()) + (isStillThinking ? '<span class="caret-blink"></span>' : '') + '</div>' +
        '</details>';
    }
    if (state.streamingText) {
      html += renderMarkdown(state.streamingText) + '<span class="caret-blink"></span>';
    } else if (!state.streamingThought) {
      html += '<span class="caret-blink"></span>';
    }
    body.innerHTML = html;
    maybeScroll(false);
  }

  function scheduleStreamFlush() {
    if (streamFlushPending) return;
    streamFlushPending = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flushStreamingToken);
    } else {
      setTimeout(flushStreamingToken, 33);
    }
  }

  function appendStreamingToken(text) {
    var list = el('messagesList');
    if (!list) return;
    if (!state.liveBody) {
      var node = buildMessage('assistant', '');
      list.appendChild(node);
      state.liveBody = node.querySelector('.msg-body');
      state.streamingText = text;
      state.streamingThought = '';
      flushStreamingToken();
      trimMessagesList();
      return;
    }
    state.streamingText = (state.streamingText || '') + text;
    scheduleStreamFlush();
  }

  function appendStreamingThought(text) {
    var list = el('messagesList');
    if (!list) return;
    if (!state.liveBody) {
      var node = buildMessage('assistant', '');
      list.appendChild(node);
      state.liveBody = node.querySelector('.msg-body');
      state.streamingText = '';
      state.streamingThought = text;
      flushStreamingToken();
      trimMessagesList();
      return;
    }
    state.streamingThought = (state.streamingThought || '') + text;
    scheduleStreamFlush();
  }

  function finalizeStreamingTurn(interrupted, failed) {
    streamFlushPending = false; // a stale scheduled frame must not render after finalize
    if (state.liveBody) {
      var note = failed
        ? '<div class="msg-error">[Turn failed]</div>'
        : (interrupted ? '<div class="muted">[Turn interrupted by operator]</div>' : '');
      var html = '';
      if (state.streamingThought && state.streamingThought.trim()) {
        html += '<details class="msg-thinking">' +
          '<summary><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>Thinking</summary>' +
          '<div class="msg-thinking-body">' + escapeHtml(state.streamingThought.trim()) + '</div>' +
          '</details>';
      }
      html += renderMarkdown(state.streamingText) + note;
      state.liveBody.innerHTML = html;
      state.liveBody = null;
    }
    state.streamingText = '';
    state.streamingThought = '';
  }

  // ------------------------------------------------------------------ SSE
  var eventSource = null;

  function connectSSE() {
    if (eventSource) eventSource.close();
    var sseUrl = new URL('/api/events', window.location.origin);
    if (token) sseUrl.searchParams.set('token', token);
    if (state.activeProjectId) sseUrl.searchParams.set('projectId', state.activeProjectId);
    eventSource = new EventSource(sseUrl.toString());
    eventSource.onopen = function () {
      var conn = el('connectionStatus');
      if (conn) {
        conn.classList.remove('is-offline');
        conn.classList.add('is-reconnected');
        var lbl = conn.querySelector('.conn-label');
        if (lbl) lbl.textContent = 'Connected';
        setTimeout(function () {
          conn.classList.remove('is-reconnected');
        }, 2500);
      }
      reconstituteWorkerPartitions();
    };
    eventSource.onerror = function () {
      var conn = el('connectionStatus');
      if (conn) {
        conn.classList.remove('is-reconnected');
        conn.classList.add('is-offline');
        var lbl = conn.querySelector('.conn-label');
        if (lbl) lbl.textContent = 'Reconnecting\u2026';
      }
    };
    eventSource.onmessage = function (e) {
      var ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      handleServerEvent(ev);
    };
  }

  function handleServerEvent(ev) {
    if (ev.type && ev.type.startsWith('worker.')) {
      if (ev.runId && state.activeRunId && ev.runId !== state.activeRunId) return;
      handleWorkerEvent(ev);
      scheduleActivityRefresh();
    } else if (ev.type === 'token' && ev.sessionId === state.activeSessionId) {
      appendStreamingToken(ev.text);
    } else if (ev.type === 'thought' && ev.sessionId === state.activeSessionId) {
      appendStreamingThought(ev.text);
    } else if (ev.type === 'tool' && ev.sessionId === state.activeSessionId) {
      appendToolEvent(ev.tool);
      scheduleFilesRefresh();
    } else if (ev.type === 'turn_start' && ev.sessionId === state.activeSessionId) {
      setBusy(true);
      if (state.queueLength && state.queueLength > 0) {
        state.queueLength--;
        updateQueueBadge();
      }
      var queuedEl = el('messagesList') && el('messagesList').querySelector('.msg-user.is-queued');
      if (queuedEl) queuedEl.classList.remove('is-queued');
    } else if (ev.type === 'turn_end' && ev.sessionId === state.activeSessionId) {
      finalizeStreamingTurn(ev.interrupted, ev.failed);
      if (!state.queueLength || state.queueLength <= 0) {
        setBusy(false);
      }
      scheduleFilesRefresh(true);
    } else if (ev.type === 'usage' && ev.sessionId === state.activeSessionId) {
      updateUsage(ev);
    } else if (ev.type === 'approval_requested') {
      if (isQuestionApproval(ev.approval)) {
        renderQaQuestionCard(ev.approval);
      } else {
        showPendingApproval(ev.approval);
      }
      loadApprovals();
    } else if (ev.type === 'approval_decided') {
      if (state.pendingApprovalId === ev.approval.id) hidePendingApproval();
      if (isQuestionApproval(ev.approval)) {
        var existingQaCard = document.getElementById('qa-card-' + ev.approval.id) || (el('messagesList') && el('messagesList').querySelector('[data-qa-id="' + ev.approval.id + '"]'));
        if (existingQaCard) updateQaCardSettled(existingQaCard, ev.approval);
      }
      loadApprovals();
    } else if (ev.type === 'run_state') {
      state.activeRunId = ev.runId;
      applyRunState(ev.state, ev.goal, ev.error, ev.summary);
      refreshActiveRun();
      scheduleActivityRefresh();
      scheduleFilesRefresh();
      if (state.workerDetail) scheduleWorkerDetailRefresh();
    } else if (ev.type === 'task_state') {
      if (ev.runId && state.activeRunId && ev.runId !== state.activeRunId) return;
      state.tasks[ev.taskId] = { id: ev.taskId, title: ev.title, state: ev.state, runId: ev.runId };
      if (ev.runId) state.activeRunId = ev.runId;
      updateActivityBadge();
      reconstituteWorkerPartitions();
      scheduleActivityRefresh();
      scheduleFilesRefresh();
      if (state.workerDetail && state.workerDetail.taskId === ev.taskId) scheduleWorkerDetailRefresh();
    } else if (ev.type === 'run_activity') {
      handleRunActivityFrame(ev.activity);
    }
  }

  function updateUsage(usage) {
    var input = Number(usage.inputTokens || 0);
    var output = Number(usage.outputTokens || 0);
    state.usage = { input: input, output: output, costUsd: usage.costUsd };
    var node = el('sbContext');
    if (!node) return;
    // The engine reported usage: show the measured total, in tokens. A zero
    // report is still a report, so it replaces the "not reported" placeholder.
    // Nothing here is inferred - the runtime exposes no context-window
    // measurement, so none is displayed.
    node.textContent = (input + output).toLocaleString() + ' used';
    node.classList.remove('muted');
  }

  // -------------------------------------------------------------- sessions
  async function loadSessions() {
    var res = await apiFetch('/api/sessions');
    state.sessions = res.sessions || [];
    renderSessions();
    if (state.sessions.length > 0) {
      var keep = state.activeSessionId &&
        state.sessions.some(function (s) { return s.id === state.activeSessionId; });
      await selectSession(keep ? state.activeSessionId : state.sessions[0].id);
    } else {
      await createNewSession('Session 1');
    }
  }

  function renderSessions() {
    var list = el('sessionsList');
    if (!list) return;
    list.innerHTML = '';
    if (state.sessions.length === 0) {
      list.innerHTML = '<div class="empty-hint">No sessions yet. Create one to start a persisted conversation.</div>';
      return;
    }
    state.sessions.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'session-item' + (s.id === state.activeSessionId ? ' is-active' : '');
      var title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = s.title || 'Untitled Session';
      var meta = document.createElement('div');
      meta.className = 'session-meta';
      var timeStr = formatTime(s.updatedAt || s.createdAt);
      if (s.workspaceRoot) {
        var raw = s.workspaceRoot;
        var lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\\\'));
        var base = (lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw) || raw;
        meta.innerHTML = escapeHtml(timeStr) + ' <span class="session-ws-chip" title="' + escapeHtml(s.workspaceRoot) + '">\u2022 ' + escapeHtml(base) + '</span>';
      } else {
        meta.textContent = timeStr;
      }
      item.appendChild(title);
      item.appendChild(meta);
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'session-delete';
      del.title = 'Delete session';
      del.setAttribute('aria-label', 'Delete session ' + (s.title || 'Untitled Session'));
      del.innerHTML = TRASH_ICON;
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteSession(s.id);
      });
      item.appendChild(del);
      item.addEventListener('click', function () { selectSession(s.id); });
      list.appendChild(item);
    });
  }

  async function deleteSession(sessionId) {
    var target = null;
    state.sessions.forEach(function (s) { if (s.id === sessionId) target = s; });
    var ok = await plutonConfirm({
      title: 'Delete session',
      message: 'Delete "' + ((target && target.title) || 'this session') + '"? Its transcript is removed permanently.',
      confirmLabel: 'Delete session'
    });
    if (!ok) return;
    try {
      await apiFetch('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
      state.sessions = state.sessions.filter(function (s) { return s.id !== sessionId; });
      if (state.activeSessionId === sessionId) {
        state.activeSessionId = null;
        closeFileViewer(true);
        if (state.sessions.length > 0) {
          await selectSession(state.sessions[0].id);
        } else {
          await createNewSession('Session 1');
        }
      } else {
        renderSessions();
      }
      toast('Session deleted');
    } catch (err) {
      toast('Failed to delete session: ' + err.message, true);
    }
  }

  async function selectSession(sessionId) {
    closeFileViewer(true);
    state.activeSessionId = sessionId;
    renderSessions();
    try {
      var res = await apiFetch('/api/sessions/' + encodeURIComponent(sessionId));
      state.messages = res.session.messages || [];
      state.muse = res.session.activeShip || res.session.activeMuse || null;
      renderTranscript(state.messages);
      applyMuseModel();
      state.queueLength = res.session.queueLength || 0;
      updateQueueBadge();
      // A reload during an in-flight turn must show the real state, not a
      // false "ready": the server reports whether the engine is still busy.
      setBusy(res.session.busy === true);
      await loadWorkspace(sessionId);
      await loadFilesList();
      await loadApprovals();
    } catch (err) {
      toast('Failed to load session: ' + err.message, true);
    }
  }

  async function createNewSession(title, workspaceRoot) {
    try {
      // New chats start on the Manager Ship (the main chat model) whenever a
      // Manager is configured; the session itself can still be inspected and
      // its Ship changed elsewhere.
      var chatShip = preferredChatAgent((state.workspace && state.workspace.muses) || []) || state.muse;
      var res = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: title || ('Session ' + (state.sessions.length + 1)),
          shipId: chatShip ? chatShip.id : undefined,
          museId: chatShip ? chatShip.id : undefined,
          workspaceRoot: workspaceRoot || undefined
        })
      });
      state.sessions.unshift(res.session);
      await selectSession(res.session.id);
      toast('Session created');
    } catch (err) {
      toast('Failed to create session: ' + err.message, true);
    }
  }

  function openNewSessionModal() {
    var modal = el('newSessionModal');
    var input = el('newSessionNameInput');
    var wsInput = el('newSessionWorkspaceInput');
    if (modal) modal.classList.remove('is-hidden');
    if (input) { input.value = ''; input.focus(); }
    if (wsInput) { wsInput.value = ''; }
  }

  function closeNewSessionModal() {
    var modal = el('newSessionModal');
    if (modal) modal.classList.add('is-hidden');
  }

  function confirmCreateSession() {
    var input = el('newSessionNameInput');
    var wsInput = el('newSessionWorkspaceInput');
    var name = input && input.value.trim() ? input.value.trim() : ('Session ' + (state.sessions.length + 1));
    var wsRoot = wsInput && wsInput.value.trim() ? wsInput.value.trim() : undefined;
    closeNewSessionModal();
    createNewSession(name, wsRoot);
  }

  async function browseNewSessionWorkspace() {
    try {
      var res = null;
      try {
        res = await apiFetch('/api/workspace/pick', { method: 'POST' });
      } catch (pickerErr) {
        res = { cancelled: true };
      }
      var path = res && !res.cancelled && res.path ? res.path : null;
      if (!path) {
        var input = await plutonPrompt({
          title: 'Workspace folder',
          message: 'The native folder picker was unavailable. Enter or paste the workspace folder path.',
          label: 'Folder path',
          placeholder: 'C:\\\\path\\\\to\\\\project',
          confirmLabel: 'Use folder'
        });
        if (input) path = input;
      }
      if (path) {
        var wsInput = el('newSessionWorkspaceInput');
        if (wsInput) wsInput.value = path;
      }
    } catch (err) {
      toast('Folder selection failed: ' + err.message, true);
    }
  }

  // -------------------------------------------------------------- projects
  async function loadProjects() {
    try {
      var res = await apiFetch('/api/projects');
      if (res && res.ok && Array.isArray(res.projects)) {
        state.projects = res.projects;
        var queryProject = urlParams.get('project') || urlParams.get('projectId');
        if (queryProject && state.projects.some(function (p) { return p.id === queryProject; })) {
          state.activeProjectId = queryProject;
        } else if (res.activeProjectId && state.projects.some(function (p) { return p.id === res.activeProjectId; })) {
          state.activeProjectId = res.activeProjectId;
        } else if (state.projects.length > 0) {
          state.activeProjectId = state.projects[0].id;
        }
        renderProjectSelector();
      }
    } catch (err) {
      console.warn('Failed to load projects:', err);
    }
  }

  function renderProjectSelector() {
    var nameEl = el('projectSelectName');
    var activeProj = state.projects.find(function (p) { return p.id === state.activeProjectId; });
    if (nameEl) {
      nameEl.textContent = activeProj ? activeProj.name : 'Select Project';
    }
    var menu = el('projectSelectMenu');
    if (!menu) return;
    menu.innerHTML = '';
    state.projects.forEach(function (proj) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-menu-item' + (proj.id === state.activeProjectId ? ' is-active' : '');
      var row = document.createElement('div');
      row.className = 'project-menu-item-name';
      row.textContent = proj.name;
      if (proj.id === state.activeProjectId) {
        var badge = document.createElement('span');
        badge.className = 'tag-mono';
        badge.style.fontSize = '9px';
        badge.textContent = 'active';
        row.appendChild(badge);
      }
      var path = document.createElement('div');
      path.className = 'project-menu-item-path';
      path.textContent = proj.rootDir;
      btn.appendChild(row);
      btn.appendChild(path);
      btn.addEventListener('click', function () {
        switchActiveProject(proj.id);
      });
      menu.appendChild(btn);
    });
  }

  async function switchActiveProject(projectId) {
    if (state.activeProjectId === projectId) {
      toggleProjectMenu(false);
      return;
    }
    state.activeProjectId = projectId;
    toggleProjectMenu(false);
    renderProjectSelector();

    // Update URL parameter without full page reload
    var newUrl = new URL(window.location.href);
    newUrl.searchParams.set('project', projectId);
    window.history.replaceState({}, '', newUrl.toString());

    // Reconnect SSE for events of selected project
    connectSSE();

    // Reload project-scoped data
    try {
      state.activeSessionId = null;
      state.activeRunId = null;
      await loadWorkspace();
      await loadSessions();
      await loadModels();
      await loadProviders();
      await loadMcp();
      await loadApprovals();
      await loadSettings();
      if (state.sidebarTab === 'files') {
        await loadFiles();
      }
      var target = state.projects.find(function (p) { return p.id === projectId; });
      toast('Switched to project: ' + (target ? target.name : projectId));
    } catch (err) {
      toast('Failed to refresh project workspace: ' + err.message, true);
    }
  }

  function toggleProjectMenu(show) {
    var menu = el('projectSelectMenu');
    var btn = el('projectSelectBtn');
    if (!menu) return;
    var isOpen = typeof show === 'boolean' ? show : menu.classList.contains('is-hidden');
    if (isOpen) {
      menu.classList.remove('is-hidden');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    } else {
      menu.classList.add('is-hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  // ------------------------------------------------------------- workspace
  async function loadWorkspace(sessionId) {
    try {
      var sid = sessionId || state.activeSessionId;
      var path = sid ? ('/api/workspace?sessionId=' + encodeURIComponent(sid)) : '/api/workspace';
      var res = await apiFetch(path);
      state.workspace = res.workspace;
      var nameNode = el('workspaceName');
      var pathNode = el('workspacePath');
      var filesLabel = el('filesWorkspaceLabel');
      var rootNode = el('settingsWorkspaceRoot');
      if (nameNode) nameNode.textContent = state.workspace.name || 'workspace';
      if (pathNode) pathNode.textContent = state.workspace.rootDir || '';
      if (filesLabel) filesLabel.textContent = state.workspace.rootDir || '';
      if (rootNode) rootNode.textContent = state.workspace.rootDir || '';
      var runtimeInfo = el('runtimeInfo');
      if (runtimeInfo) {
        runtimeInfo.innerHTML =
          kvRow('Project', state.workspace.name) +
          kvRow('Root', state.workspace.rootDir) +
          kvRow('Agents', String((state.workspace.muses || []).length)) +
          kvRow('Default branch', state.workspace.defaultBranch) +
          kvRow('Pending approvals', String(state.workspace.approvalsPending || 0)) +
          kvRow('Active run', state.workspace.activeRun ? state.workspace.activeRun.state : 'none');
      }
      if (state.workspace.activeRun) {
        state.activeRunId = state.workspace.activeRun.id;
      }
      if (!state.muse && state.workspace && state.workspace.muses && state.workspace.muses.length > 0) {
        state.muse = preferredChatAgent(state.workspace.muses);
        applyMuseModel();
      }
      renderMuseModels();
      renderPermissions();
      renderProjectIdentity();
      refreshActiveRun();
    } catch (err) {
      toast('Failed to load workspace: ' + err.message, true);
    }
  }

  async function pickWorkspaceFolder() {
    try {
      toast('Opening folder picker\u2026');
      var res = null;
      try {
        res = await apiFetch('/api/workspace/pick', { method: 'POST' });
      } catch (pickerErr) {
        res = { cancelled: true };
      }
      var targetPath = res && !res.cancelled && res.path ? res.path : null;
      if (!targetPath) {
        var current = (state.workspace && state.workspace.rootDir) || '';
        var input = await plutonPrompt({
          title: 'Change workspace',
          message: 'The native folder picker was unavailable. Enter or paste the workspace folder path.',
          label: 'Folder path',
          value: current,
          placeholder: 'C:\\\\path\\\\to\\\\project',
          confirmLabel: 'Switch workspace'
        });
        if (input) {
          targetPath = input;
        } else {
          toast('Folder selection cancelled');
          return;
        }
      }
      if (state.activeSessionId) {
        var patchRes = await apiFetch('/api/sessions/' + encodeURIComponent(state.activeSessionId), {
          method: 'PATCH',
          body: JSON.stringify({ workspaceRoot: targetPath })
        });
        if (patchRes.session) {
          var idx = state.sessions.findIndex(function (s) { return s.id === state.activeSessionId; });
          if (idx >= 0) {
            state.sessions[idx] = patchRes.session;
          }
          renderSessions();
        }
      }
      await loadWorkspace(state.activeSessionId);
      await loadFilesList();
      toast('Switched workspace to: ' + targetPath);
    } catch (err) {
      toast('Failed to change workspace: ' + err.message, true);
    }
  }

  function explainWorkspacePin() {
    pickWorkspaceFolder();
  }

  function kvRow(key, value) {
    return '<div class="kv-row"><span class="kv-key">' + escapeHtml(key) +
      '</span><span class="kv-val" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</span></div>';
  }

  // ----------------------------------------------------------------- MCP
  var lastMcpSnapshot = null;

  async function loadMcp() {
    // Background tabs skip the poll entirely: no fetch, no render churn; a
    // visibilitychange listener re-runs one load the moment the tab returns.
    if (document.hidden) return;
    try {
      var res = await apiFetch('/api/mcp');
      // Unchanged registry → keep the previous render: the poll keeps the
      // badge fresh without rebuilding popover DOM every interval.
      var snapshot = JSON.stringify(res || null);
      if (snapshot === lastMcpSnapshot) return;
      lastMcpSnapshot = snapshot;
      state.mcp = res;
      renderMcp();
    } catch (err) {
      // The badge keeps its last known value; the popover surfaces the error.
      var list = el('mcpServersList');
      if (list) list.innerHTML = '<div class="popover-empty">Failed to read the MCP registry: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderMcp() {
    var badge = el('mcpCountBadge');
    var button = el('mcpToggleBtn');
    if (badge) {
      var n = state.mcp.connected || 0;
      badge.textContent = n + ' connected';
      if (button) button.classList.toggle('is-zero', n === 0);
    }
    var summary = el('mcpPopoverSummary');
    if (summary) summary.textContent = (state.mcp.connected || 0) + ' / ' + (state.mcp.total || 0) + ' active';
    var cardCount = el('mcpCardCount');
    if (cardCount) cardCount.textContent = (state.mcp.connected || 0) + ' connected';
    var list = el('mcpServersList');
    if (list) {
      var servers = state.mcp.servers || [];
      if (servers.length === 0) {
        list.innerHTML = '<div class="popover-empty">No MCP server is registered. A bridge is registered when an engine session starts; until then the count is genuinely zero.</div>';
      } else {
        list.innerHTML = servers.map(function (s) {
          return '<div class="mcp-popover-item"><div><div class="popover-item-name">' + escapeHtml(s.name) +
            '</div><div class="mcp-popover-detail">' + escapeHtml(s.detail || '') + '</div></div>' +
            '<span class="tool-status ' + (s.state === 'connected' ? 'succeeded' : 'failed') + '">' + escapeHtml(s.state) + '</span></div>';
        }).join('');
      }
    }
    var cardList = el('mcpCardList');
    if (cardList) {
      var cardServers = state.mcp.servers || [];
      if (cardServers.length === 0) {
        cardList.innerHTML = '<div class="empty-hint">No MCP server registered yet.</div>';
      } else {
        cardList.innerHTML = cardServers.map(function (s) {
          return '<div class="mcp-item"><div><div class="mcp-item-name">' + escapeHtml(s.name) +
            ' <span class="muted">' + escapeHtml(s.kind) + '</span></div>' +
            '<div class="mcp-item-detail">' + escapeHtml(s.museName || '') + ' \\u00b7 ' + escapeHtml(s.detail || '') + '</div></div>' +
            '<span class="tool-status ' + (s.state === 'connected' ? 'succeeded' : 'failed') + '">' + escapeHtml(s.state) + '</span></div>';
        }).join('');
      }
    }
  }

  // --------------------------------------------------------------- models
  async function loadModels() {
    try {
      var res = await apiFetch('/api/models');
      state.models = res.models || {};
      renderModelRegistry();
      renderMuseModels();
      renderModelPopover();
      var searchIn = el('modelSearchInput');
      renderModelSelectList(searchIn ? searchIn.value : '');
    } catch (err) {
      var node = el('modelRegistry');
      if (node) node.innerHTML = '<div class="empty-hint">Failed to read the model registry: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function modelEntries() {
    var out = [];
    Object.keys(state.models).forEach(function (engine) {
      (state.models[engine] || []).forEach(function (m) {
        out.push({
          engine: engine,
          id: m.id,
          label: m.label || m.id,
          source: m.source,
          available: m.available !== false,
          reason: m.reason,
          provider: m.provider,
          providerName: m.providerName
        });
      });
    });
    return out;
  }

  function renderModelRegistry() {
    var node = el('modelRegistry');
    if (!node) return;
    var engines = Object.keys(state.models);
    if (engines.length === 0) {
      node.innerHTML = '<div class="empty-hint">No model registry available.</div>';
      return;
    }
    node.innerHTML = engines.map(function (engine) {
      var list = state.models[engine] || [];
      return '<div class="registry-group"><div class="registry-head"><span>' + escapeHtml(engine) +
        '</span><span>' + list.length + ' models</span></div><div class="registry-list">' +
        list.map(function (m) {
          var current = state.muse && m.id === state.muse.model;
          return '<div class="registry-item' + (current ? ' is-current' : '') + '"><span>' +
            escapeHtml(m.label || m.id) + '</span><span>' + escapeHtml(m.source || '') + '</span></div>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function renderModelPopover() {
    var list = el('modelListContainer');
    if (!list) return;
    var entries = modelEntries();
    if (entries.length === 0) {
      list.innerHTML = '<div class="popover-empty">No models reported by the engine. The engine may not be installed; the configured model stays active.</div>';
      return;
    }
    list.innerHTML = entries.map(function (m) {
      var current = state.muse && m.id === state.muse.model;
      return '<div class="popover-item' + (current ? ' is-current' : '') + '" data-model="' + escapeHtml(m.id) +
        '" data-engine="' + escapeHtml(m.engine) + '" data-provider="' + escapeHtml(m.provider || '') +
        '"><div class="popover-item-name">' + escapeHtml(m.label) +
        '</div><div class="popover-item-engine">' + escapeHtml(m.engine) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.popover-item'), function (node) {
      node.addEventListener('click', function () {
        switchModel(
          node.getAttribute('data-model'),
          node.getAttribute('data-provider') || undefined,
          node.getAttribute('data-engine') || undefined
        );
      });
    });
  }

  function renderModelSelectList(filter) {
    var list = el('modelListContainer');
    if (!list) return;
    var filterLower = (filter || '').trim().toLowerCase();
    var entries = modelEntries();

    if (filterLower) {
      entries = entries.filter(function (m) {
        var idMatch = String(m.id || '').toLowerCase().indexOf(filterLower) !== -1;
        var labelMatch = String(m.label || '').toLowerCase().indexOf(filterLower) !== -1;
        var engMatch = String(m.engine || '').toLowerCase().indexOf(filterLower) !== -1;
        var provMatch = String(m.providerName || m.provider || '').toLowerCase().indexOf(filterLower) !== -1;
        return idMatch || labelMatch || engMatch || provMatch;
      });
    }

    if (entries.length === 0) {
      list.innerHTML = '<div class="popover-empty">No models match your search.</div>';
      return;
    }

    var groups = {};
    entries.forEach(function (m) {
      var groupKey = m.providerName || (m.provider ? ('Provider: ' + m.provider) : (m.engine ? ('Engine: ' + m.engine) : 'Other'));
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(m);
    });

    var targetShipId = state.modelSelectTargetShipId || (state.muse ? state.muse.id : null);
    var targetShip = null;
    if (state.workspace && state.workspace.muses) {
      targetShip = state.workspace.muses.find(function (s) { return s.id === targetShipId; });
    }
    var currentModel = targetShip ? targetShip.model : (state.muse ? state.muse.model : null);

    var groupHtmlList = Object.keys(groups).map(function (groupName) {
      var items = groups[groupName];
      return '<div class="model-group">' +
        '<div class="model-group-title">' + escapeHtml(groupName) + ' (' + items.length + ')</div>' +
        items.map(function (m) {
          var isCurrent = currentModel === m.id;
          var availClass = m.available ? 'is-avail' : 'is-unavail';
          var availLabel = m.available ? 'Available' : (m.reason ? escapeHtml(m.reason) : 'Unavailable');
          return '<div class="model-card-item' + (isCurrent ? ' is-current' : '') + '" data-model="' + escapeHtml(m.id) +
            '" data-engine="' + escapeHtml(m.engine) + '" data-provider="' + escapeHtml(m.provider || '') + '">' +
            '<div class="model-card-main">' +
              '<div class="model-card-name">' + escapeHtml(m.label || m.id) + (isCurrent ? ' <span class="tag-mono" style="color:var(--accent-cyan);">Active</span>' : '') + '</div>' +
              '<div class="model-card-meta">' +
                '<span class="mono">' + escapeHtml(m.id) + '</span>' +
                '<span>\\u00b7</span>' +
                '<span class="model-avail-dot ' + availClass + '" title="' + availLabel + '"></span>' +
                '<span>' + availLabel + '</span>' +
              '</div>' +
            '</div>' +
            '<button class="btn-xs ' + (isCurrent ? 'btn-secondary' : 'btn-primary') + '" type="button">' + (isCurrent ? 'Selected' : 'Select') + '</button>' +
          '</div>';
        }).join('') +
      '</div>';
    });

    list.innerHTML = groupHtmlList.join('');

    Array.prototype.forEach.call(list.querySelectorAll('.model-card-item'), function (item) {
      item.addEventListener('click', function () {
        var modelId = item.getAttribute('data-model');
        var engineId = item.getAttribute('data-engine') || undefined;
        var providerId = item.getAttribute('data-provider') || undefined;
        selectModelForShip(targetShipId, modelId, providerId, engineId);
      });
    });
  }

  function openModelSelectModal(targetShipId) {
    state.modelSelectTargetShipId = targetShipId || (state.muse ? state.muse.id : null);
    var modal = el('modelSelectModal');
    if (!modal) return;
    var targetLabel = el('modelSelectTargetShip');
    if (targetLabel) {
      var shipName = state.modelSelectTargetShipId;
      if (state.workspace && state.workspace.muses) {
        var s = state.workspace.muses.find(function (x) { return x.id === state.modelSelectTargetShipId; });
        if (s) shipName = (s.displayName || s.id) + ' (' + (s.role || s.engine) + ')';
      }
      targetLabel.textContent = shipName ? ('Assign model to ' + shipName) : 'Assign model to Ship';
    }
    var searchInput = el('modelSearchInput');
    if (searchInput) searchInput.value = '';
    modal.classList.remove('is-hidden');
    renderModelSelectList('');
    loadModels();
    if (searchInput) searchInput.focus();
  }

  function closeModelSelectModal() {
    var modal = el('modelSelectModal');
    if (modal) modal.classList.add('is-hidden');
  }

  async function selectModelForShip(shipId, modelId, providerId, engineId) {
    closeModelSelectModal();
    if (shipId) {
      await switchMuseModel(shipId, modelId, providerId, engineId);
    } else {
      await switchModel(modelId, providerId, engineId);
    }
  }

  function applyMuseModel() {
    var node = el('activeModelName');
    if (node) node.textContent = state.muse ? state.muse.model : '\\u2014';
    var badge = el('modelRegistry');
    renderModelRegistry();
  }

  async function switchModel(modelId, providerId, engineId) {
    if (!state.muse) {
      try {
        var shipRes = await apiFetch('/api/ships');
        var ships = (shipRes && (shipRes.ships || shipRes.muses)) || [];
        if (ships.length > 0) {
          state.muse = preferredChatAgent(ships);
          applyMuseModel();
        }
      } catch (e) {}
    }
    if (!state.muse) {
      toast('No active agent: open a session first.', true);
      return;
    }
    if (state.muse.model === modelId) {
      toggleModelPopover(false);
      return;
    }
    var previous = state.muse.model;
    var previousProvider = state.muse.provider !== undefined ? state.muse.provider : null;
    var previousEngine = state.muse.engineKind;
    var museId = state.muse.id;
    try {
      var reqBody = { model: modelId };
      if (providerId !== undefined) reqBody.provider = providerId;
      if (engineId !== undefined) reqBody.engine = engineId;
      await apiFetch('/api/muses/' + encodeURIComponent(state.muse.id) + '/model', {
        method: 'POST',
        body: JSON.stringify(reqBody)
      });
      state.muse.model = modelId;
      if (providerId !== undefined) state.muse.provider = providerId || null;
      if (engineId !== undefined) state.muse.engineKind = engineId;
      if (state.workspace && state.workspace.muses) {
        var found = state.workspace.muses.find(function (m) { return m.id === museId; });
        if (found) {
          found.model = modelId;
          if (providerId !== undefined) found.provider = providerId || null;
          if (engineId !== undefined) found.engineKind = engineId;
        }
      }
      if (state.workspace && state.workspace.ships) {
        var foundShip = state.workspace.ships.find(function (s) { return s.id === museId; });
        if (foundShip) {
          foundShip.model = modelId;
          if (providerId !== undefined) foundShip.provider = providerId || null;
          if (engineId !== undefined) foundShip.engineKind = engineId;
        }
      }
      applyMuseModel();
      renderMuseModels();
      toggleModelPopover(false);
      // Switching back to the model that was active before is a real inverse:
      // the engine offered it, it was running, and the same endpoint applies
      // it. No other operation in this UI has a safe inverse.
      toast('Model switched to ' + modelId, false, {
        label: 'Undo',
        run: function () { switchMuseModel(museId, previous, previousProvider, previousEngine); },
      });
    } catch (err) {
      toast('Model switch failed: ' + err.message, true);
    }
  }

  // ------------------------------------------------------ muse model cards
  // Presentation order is computed by coworkerRank below (role/id/name based);
  // the former flat ordering array here was defined but never read — a
  // rebound empty table must not come back.
  function coworkerRank(m) {
    var role = String(m.role || '').toLowerCase();
    var id = String(m.id || m.slug || '').toLowerCase();
    var name = String(m.displayName || m.name || '').toLowerCase();
    if (role === 'supervisor' || id === 'manager' || name.indexOf('manager') !== -1) return 1;
    if (role === 'qa' || role === 'tester' || id === 'qa' || id === 'tester' || name.indexOf('qa') !== -1 || name.indexOf('tester') !== -1) return 2;
    if (role === 'researcher' || id === 'researcher' || name.indexOf('research') !== -1) return 3;
    if (role === 'coder' || role === 'worker' || id === 'coder' || name.indexOf('coder') !== -1 || role === 'developer') return 4;
    if (role === 'reviewer' || role === 'verification' || id === 'reviewer' || name.indexOf('review') !== -1) return 5;
    return 99;
  }

  /**
   * The Manager is the default chat Ship. Its model is the main chat model,
   * and its settings row is labelled accordingly.
   */
  function isManagerAgent(m) {
    if (!m) return false;
    var role = String(m.role || '').toLowerCase();
    var id = String(m.id || m.slug || '').toLowerCase();
    return role === 'supervisor' || id === 'manager';
  }

  /** Pick the Manager Ship, falling back to the first addressable agent. */
  function preferredChatAgent(muses) {
    var list = muses || [];
    var manager = null;
    list.forEach(function (m) {
      if (!manager && isManagerAgent(m) && String(m.id || m.slug || '') !== '') manager = m;
    });
    return manager || list.filter(function (m) { return m && String(m.id || m.slug || '') !== ''; })[0] || null;
  }

  function renderMuseModels() {
    var node = el('museModelList');
    if (!node || !state.workspace) return;
    var muses = state.workspace.muses || [];
    if (muses.length === 0) {
      node.innerHTML = '<div class="empty-hint">No agents configured.</div>';
      return;
    }
    // Rank ORDERS the list; it never hides an agent. Distinct agents sharing
    // a role bucket (two researchers, two coders, unknown roles) all stay
    // visible and individually addressable. Display name breaks rank ties so
    // "Coder - X" precedes "Coder - Z" regardless of internal id order.
    var sortedMuses = muses
      .filter(function (m) { return m && String(m.id || m.slug || '') !== ''; })
      .map(function (m) {
        return {
          m: m,
          rank: coworkerRank(m),
          id: String(m.id || m.slug).toLowerCase(),
          name: String(m.displayName || m.name || m.id || m.slug).toLowerCase()
        };
      })
      .sort(function (a, b) {
        return (a.rank - b.rank) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
    if (sortedMuses.length === 0) {
      node.innerHTML = '<div class="empty-hint">No addressable agents configured (entries without an id cannot be configured).</div>';
      return;
    }
    var engineModels = state.models || {};
    node.innerHTML = sortedMuses.map(function (entry) {
      var m = entry.m;
      var options = engineModels[m.engine] || [];
      var opts = options.map(function (opt) {
        var id = opt.id;
        return '<option value="' + escapeHtml(id) + '" data-engine="' + escapeHtml(opt.engine || m.engine) +
          '" data-provider="' + escapeHtml(opt.provider || '') + '"' + (id === m.model ? ' selected' : '') + '>' +
          escapeHtml(opt.label || id) + '</option>';
      }).join('');
      if (options.length === 0 || !options.some(function (o) { return o.id === m.model; })) {
        opts = '<option value="' + escapeHtml(m.model) + '" selected>' + escapeHtml(m.model) + '</option>' + opts;
      }
      var roleTag = isManagerAgent(m) ? ' <span class="muted">(main chat model)</span>' : '';
      return '<div class="muse-row"><div class="muse-row-head"><span class="muse-name">' + escapeHtml(m.displayName || m.id) +
        '</span><span class="muse-role">' + escapeHtml(m.role || 'unknown role') + ' \\u00b7 ' + escapeHtml(m.engine || '') + roleTag + '</span></div>' +
        '<div style="display:flex;align-items:center;gap:6px;"><select class="mini-select" data-muse="' + escapeHtml(String(m.id || m.slug)) + '">' + opts + '</select>' +
        '<button type="button" class="btn-xs btn-secondary btn-ship-model-select" data-muse="' + escapeHtml(String(m.id || m.slug)) + '" title="Browse and search all models">Browse...</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(node.querySelectorAll('select'), function (sel) {
      sel.addEventListener('change', function () {
        var chosen = sel.options[sel.selectedIndex];
        switchMuseModel(
          sel.getAttribute('data-muse'),
          sel.value,
          chosen ? (chosen.getAttribute('data-provider') || undefined) : undefined,
          chosen ? (chosen.getAttribute('data-engine') || undefined) : undefined
        );
      });
    });
    Array.prototype.forEach.call(node.querySelectorAll('.btn-ship-model-select'), function (btn) {
      btn.addEventListener('click', function () {
        openModelSelectModal(btn.getAttribute('data-muse'));
      });
    });
  }

  /**
   * Generation counter for model switches: a newer selection invalidates the
   * in-flight one, so a stale completion never overwrites newer UI state.
   */
  var modelSwitchSeq = 0;

  async function switchMuseModel(museId, modelId, providerId, engineId) {
    if (!museId) return; // nothing addressable: the API itself 404s empty ids
    var switchSeq = ++modelSwitchSeq;
    var previous = null;
    var previousProvider;
    var previousEngine;
    if (state.muse && state.muse.id === museId) {
      previous = state.muse.model;
      previousProvider = state.muse.provider !== undefined ? state.muse.provider : null;
      previousEngine = state.muse.engineKind;
    } else if (state.workspace) {
      var prior = (state.workspace.muses || []).filter(function (m) { return m && m.id === museId; })[0];
      if (prior) {
        previous = prior.model;
        previousProvider = prior.provider !== undefined ? prior.provider : null;
        previousEngine = prior.engineKind;
      }
    }
    try {
      var reqBody = { model: modelId };
      if (providerId !== undefined) reqBody.provider = providerId;
      if (engineId !== undefined) reqBody.engine = engineId;
      await apiFetch('/api/muses/' + encodeURIComponent(museId) + '/model', {
        method: 'POST',
        body: JSON.stringify(reqBody)
      });
    } catch (err) {
      if (switchSeq !== modelSwitchSeq) return;
      var detail = err && err.message ? String(err.message) : String(err);
      toast('Model switch failed for ' + museId + ': ' + detail, true);
      return;
    }
    if (switchSeq !== modelSwitchSeq) return; // a newer selection owns the UI state now
    // Every Ship owns its model: only the changed Ship is updated.
    if (state.muse && state.muse.id === museId) {
      state.muse.model = modelId;
      if (providerId !== undefined) state.muse.provider = providerId || null;
      if (engineId !== undefined) state.muse.engineKind = engineId;
      applyMuseModel();
    }
    if (state.workspace && state.workspace.muses) {
      state.workspace.muses = state.workspace.muses.map(function (m) {
        if (!m || m.id !== museId) return m;
        var next = Object.assign({}, m, { model: modelId });
        if (providerId !== undefined) next.provider = providerId || null;
        if (engineId !== undefined) next.engineKind = engineId;
        return next;
      });
      renderMuseModels();
    }
    toast('Model switched to ' + modelId, false,
      previous && previous !== modelId ? {
        label: 'Undo',
        run: function () { switchMuseModel(museId, previous, previousProvider, previousEngine); },
      } : undefined);
  }

  function renderPermissions() {
    var node = el('permissionsList');
    if (!node || !state.workspace) return;
    var muses = state.workspace.muses || [];
    if (muses.length === 0) {
      node.innerHTML = '<div class="empty-hint">No agents configured.</div>';
      return;
    }
    node.innerHTML = muses.map(function (m) {
      var perms = m.permissions || [];
      return '<div class="perm-row"><div class="perm-head"><span class="muse-name">' + escapeHtml(m.displayName) +
        '</span><span class="perm-mode">' + escapeHtml(m.approvalMode || 'n/a') + '</span></div><div class="chips">' +
        (perms.length === 0
          ? '<span class="chip-perm">no explicit permissions</span>'
          : perms.map(function (p) { return '<span class="chip-perm">' + escapeHtml(p) + '</span>'; }).join('')) +
        '</div></div>';
    }).join('');
  }

  // ------------------------------------------------------------- settings
  async function loadSettings() {
    try {
      var res = await apiFetch('/api/settings');
      if (res && res.settings) {
        state.settings = res.settings;
        renderSettings();
      }
    } catch (err) {
      console.warn('Could not load settings:', err);
    }
  }

  function renderSettings() {
    if (!state.settings) return;
    var acct = state.settings.account || {};
    var badge = el('accountStatusBadge');
    var userNode = el('accountUsername');
    var emailNode = el('accountEmail');
    var box = el('accountInfoBox');
    var form = el('accountLoginForm');
    if (badge) {
      if (acct.connected) {
        badge.className = 'badge badge-ok';
        badge.textContent = 'Connected';
      } else {
        badge.className = 'badge badge-warn';
        badge.textContent = 'Disconnected';
      }
    }
    if (userNode) userNode.textContent = acct.username || 'pluton-developer';
    if (emailNode) emailNode.textContent = acct.email || 'developer@pluton.account';
    if (box) box.classList.toggle('is-hidden', !acct.connected);
    if (form) form.classList.toggle('is-hidden', !!acct.connected);

    var perms = state.settings.permissions || {};
    var autoTool = el('toggleAutonomous');
    var parallel = el('toggleParallel');
    var autoRead = el('toggleAutoApproveRead');
    var terminal = el('toggleTerminalBash');
    if (autoTool) autoTool.checked = perms.autonomousToolExecution !== false;
    if (parallel) parallel.checked = perms.parallelSubAgents !== false;
    if (autoRead) autoRead.checked = perms.autoApproveReadTools !== false;
    if (terminal) terminal.checked = perms.terminalAndBash !== false;

    var effort = el('thinkingEffortSelect');
    if (effort && state.settings.thinkingEffort) {
      effort.value = state.settings.thinkingEffort;
    }
  }

  async function saveSettings(partial) {
    try {
      var res = await apiFetch('/api/settings', {
        method: 'POST',
        body: JSON.stringify(partial)
      });
      if (res && res.settings) {
        state.settings = res.settings;
        renderSettings();
        toast('Settings updated');
      }
    } catch (err) {
      toast('Failed to save settings: ' + err.message, true);
    }
  }

  async function saveProjectName() {
    var input = el('projectNameInput');
    if (!input) return;
    var name = input.value.trim();
    if (!name) {
      toast('Project name is required', true);
      return;
    }
    var projectId = state.workspace && state.workspace.projectId;
    if (!projectId) {
      toast('No project loaded', true);
      return;
    }
    try {
      var res = await apiFetch('/api/projects/' + encodeURIComponent(projectId), {
        method: 'PATCH',
        body: JSON.stringify({ name: name })
      });
      if (res && res.project) {
        state.workspace.name = res.project.name;
        var active = state.projects.find(function (p) { return p.id === res.project.id; });
        if (active) {
          active.name = res.project.name;
          active.slug = res.project.slug;
        }
        var nameNode = el('workspaceName');
        if (nameNode) nameNode.textContent = res.project.name;
        renderProjectSelector();
        renderProjectIdentity();
        toast('Project renamed to ' + res.project.name);
      }
    } catch (err) {
      toast('Rename failed: ' + err.message, true);
    }
  }

  async function handleSignOutAccount() {
    try {
      var res = await apiFetch('/api/account/signout', { method: 'POST', body: '{}' });
      if (res && res.account) {
        state.settings.account = res.account;
        renderSettings();
        toast('Signed out of Pluton Account');
      }
    } catch (err) {
      toast('Sign out failed: ' + err.message, true);
    }
  }

  async function handleSignInAccount() {
    var input = el('loginUserInput');
    var val = input && input.value ? input.value.trim() : '';
    if (!val) val = 'pluton-developer';
    var email = val.indexOf('@') !== -1 ? val : (val + '@pluton.account');
    try {
      var res = await apiFetch('/api/account/signin', {
        method: 'POST',
        body: JSON.stringify({ username: val, email: email })
      });
      if (res && res.account) {
        state.settings.account = res.account;
        renderSettings();
        toast('Pluton Account linked successfully');
      }
    } catch (err) {
      toast('Sign in failed: ' + err.message, true);
    }
  }

  function handleToggleApiKey() {
    var input = el('customApiKeyInput');
    var openIcon = el('eyeIconOpen');
    var closedIcon = el('eyeIconClosed');
    if (!input) return;
    var isPw = input.type === 'password';
    input.type = isPw ? 'text' : 'password';
    if (openIcon) openIcon.classList.toggle('is-hidden', !isPw);
    if (closedIcon) closedIcon.classList.toggle('is-hidden', isPw);
  }

  async function verifyAndAddCustomModel() {
    var nameInput = el('customModelNameInput');
    var keyInput = el('customApiKeyInput');
    var status = el('modelVerifyStatus');
    var modelName = nameInput && nameInput.value ? nameInput.value.trim() : '';
    var apiKey = keyInput && keyInput.value ? keyInput.value.trim() : '';

    if (!modelName) {
      if (status) {
        status.className = 'card-status-text is-error';
        status.textContent = 'Model ID / Name is required.';
      }
      return;
    }

    if (status) {
      status.className = 'card-status-text';
      status.textContent = 'Verifying model registration...';
    }

    try {
      var res = await apiFetch('/api/models/custom', {
        method: 'POST',
        body: JSON.stringify({ modelName: modelName, apiKey: apiKey })
      });
      if (res && res.ok) {
        if (status) {
          status.className = 'card-status-text is-success';
          status.textContent = 'Model registered successfully!';
        }
        if (nameInput) nameInput.value = '';
        if (keyInput) keyInput.value = '';
        toast('Custom model registered: ' + modelName);
        await loadModels();
        await loadWorkspace();
      }
    } catch (err) {
      if (status) {
        status.className = 'card-status-text is-error';
        status.textContent = 'Verification error: ' + err.message;
      }
      toast('Failed to register model: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------- providers
  async function loadProviders() {
    try {
      var res = await apiFetch('/api/providers');
      state.providers = res.providers || [];
      renderProviders();
    } catch (err) {
      var node = el('providerTable');
      if (node) node.innerHTML = '<div class="empty-hint">Failed to load providers: ' + escapeHtml(err.message) + '</div>';
    }
  }

  async function triggerImportProviders() {
    var btn = el('btnImportProviders');
    if (btn) btn.disabled = true;
    try {
      var res = await apiFetch('/api/providers/import', { method: 'POST', body: JSON.stringify({}) });
      if (res && res.report) {
        var count = (res.report.imported || []).length;
        if (count > 0) {
          toast('Imported ' + count + ' provider(s) from OpenCode');
        } else {
          toast('No new OpenCode providers to import');
        }
      }
      await loadProviders();
      await loadModels();
    } catch (err) {
      toast('Failed to import OpenCode providers: ' + err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderProviders() {
    var node = el('providerTable');
    if (!node) return;
    var list = state.providers || [];
    if (list.length === 0) {
      node.innerHTML = '<div class="empty-hint">No AI providers configured yet. Click "+ Add Provider" to connect OpenAI, OpenRouter, DeepSeek, or any compatible endpoint.</div>';
      return;
    }
    node.innerHTML = list.map(function (p) {
      var keyBadge = p.hasCredential
        ? '<span class="tag-mono" style="color:#86efac;border-color:rgba(34,197,94,0.3);">Key Configured</span>'
        : '<span class="tag-mono" style="color:#fca5a5;border-color:rgba(239,68,68,0.3);">No Key</span>';
      return '<div class="provider-card" id="prov-card-' + escapeHtml(p.id) + '">' +
        '<div class="provider-card-head">' +
          '<div class="provider-meta">' +
            '<span class="provider-name">' + escapeHtml(p.displayName || p.id) + '</span>' +
            '<span class="tag-mono">' + escapeHtml(p.id) + '</span>' +
            '<span class="tag-mono">' + escapeHtml(p.engine) + '</span>' +
            keyBadge +
          '</div>' +
        '</div>' +
        '<div class="provider-url mono">' + escapeHtml(p.baseUrl) + '</div>' +
        '<div class="provider-actions">' +
          '<button type="button" class="btn-xs btn-secondary btn-prov-key" data-provider="' + escapeHtml(p.id) + '">' + (p.hasCredential ? 'Update Key' : 'Set Key') + '</button>' +
          (p.hasCredential ? '<button type="button" class="btn-xs btn-secondary btn-prov-rm-key" data-provider="' + escapeHtml(p.id) + '">Remove Key</button>' : '') +
          '<button type="button" class="btn-xs btn-secondary btn-prov-validate" data-provider="' + escapeHtml(p.id) + '">Validate</button>' +
          '<button type="button" class="btn-xs btn-secondary btn-prov-delete" data-provider="' + escapeHtml(p.id) + '" style="color:#fca5a5;">Delete</button>' +
        '</div>' +
        '<div class="provider-status-msg is-hidden" id="prov-status-' + escapeHtml(p.id) + '"></div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call(node.querySelectorAll('.btn-prov-key'), function (btn) {
      btn.addEventListener('click', function () {
        openProviderKeyModal(btn.getAttribute('data-provider'));
      });
    });
    Array.prototype.forEach.call(node.querySelectorAll('.btn-prov-rm-key'), function (btn) {
      btn.addEventListener('click', function () {
        removeProviderKey(btn.getAttribute('data-provider'));
      });
    });
    Array.prototype.forEach.call(node.querySelectorAll('.btn-prov-validate'), function (btn) {
      btn.addEventListener('click', function () {
        validateProvider(btn.getAttribute('data-provider'));
      });
    });
    Array.prototype.forEach.call(node.querySelectorAll('.btn-prov-delete'), function (btn) {
      btn.addEventListener('click', function () {
        deleteProvider(btn.getAttribute('data-provider'));
      });
    });
  }

  function openAddProviderModal() {
    var modal = el('providerAddModal');
    if (!modal) return;
    var status = el('providerAddStatus');
    if (status) { status.textContent = ''; status.className = 'card-status-text'; }
    var idInput = el('providerIdInput');
    if (idInput) idInput.value = '';
    var nameInput = el('providerDisplayNameInput');
    if (nameInput) nameInput.value = '';
    var urlInput = el('providerBaseUrlInput');
    if (urlInput) urlInput.value = '';
    var keyInput = el('providerApiKeyInput');
    if (keyInput) keyInput.value = '';
    modal.classList.remove('is-hidden');
    if (idInput) idInput.focus();
  }

  function closeAddProviderModal() {
    var modal = el('providerAddModal');
    if (modal) modal.classList.add('is-hidden');
  }

  async function submitAddProvider() {
    var idInput = el('providerIdInput');
    var engineSelect = el('providerEngineSelect');
    var nameInput = el('providerDisplayNameInput');
    var urlInput = el('providerBaseUrlInput');
    var keyInput = el('providerApiKeyInput');
    var status = el('providerAddStatus');

    var id = idInput && idInput.value ? idInput.value.trim().toLowerCase() : '';
    var engine = engineSelect ? engineSelect.value : 'openai-compatible';
    var displayName = nameInput && nameInput.value ? nameInput.value.trim() : '';
    var baseUrl = urlInput && urlInput.value ? urlInput.value.trim() : '';
    var apiKey = keyInput && keyInput.value ? keyInput.value.trim() : '';

    if (!id) {
      if (status) { status.className = 'card-status-text is-error'; status.textContent = 'Provider ID is required (e.g. openrouter).'; }
      return;
    }
    if (!baseUrl) {
      if (status) { status.className = 'card-status-text is-error'; status.textContent = 'Base URL is required.'; }
      return;
    }

    if (status) { status.className = 'card-status-text'; status.textContent = 'Adding provider...'; }

    try {
      var payload = {
        id: id,
        engine: engine,
        baseUrl: baseUrl,
        displayName: displayName || id
      };
      if (apiKey) payload.apiKey = apiKey;

      var res = await apiFetch('/api/providers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res && res.ok) {
        toast('Provider added: ' + id);
        closeAddProviderModal();
        await loadProviders();
        await loadModels();
      }
    } catch (err) {
      if (status) {
        status.className = 'card-status-text is-error';
        status.textContent = 'Failed to add provider: ' + err.message;
      }
      toast('Failed to add provider: ' + err.message, true);
    }
  }

  var activeKeyProviderId = null;

  function openProviderKeyModal(providerId) {
    activeKeyProviderId = providerId;
    var modal = el('providerKeyModal');
    if (!modal) return;
    var sub = el('providerKeySubtitle');
    if (sub) sub.textContent = 'Store credential for provider: ' + providerId;
    var input = el('providerKeyInput');
    if (input) input.value = '';
    var status = el('providerKeyStatus');
    if (status) { status.textContent = ''; status.className = 'card-status-text'; }
    modal.classList.remove('is-hidden');
    if (input) input.focus();
  }

  function closeProviderKeyModal() {
    activeKeyProviderId = null;
    var modal = el('providerKeyModal');
    if (modal) modal.classList.add('is-hidden');
  }

  async function submitProviderKey() {
    if (!activeKeyProviderId) return;
    var input = el('providerKeyInput');
    var status = el('providerKeyStatus');
    var key = input && input.value ? input.value.trim() : '';
    if (!key) {
      if (status) { status.className = 'card-status-text is-error'; status.textContent = 'API key cannot be empty.'; }
      return;
    }
    if (status) { status.className = 'card-status-text'; status.textContent = 'Saving key...'; }
    try {
      var res = await apiFetch('/api/providers/' + encodeURIComponent(activeKeyProviderId) + '/key', {
        method: 'POST',
        body: JSON.stringify({ apiKey: key })
      });
      if (res && res.ok) {
        toast('Key saved securely for ' + activeKeyProviderId);
        closeProviderKeyModal();
        await loadProviders();
        await loadModels();
      }
    } catch (err) {
      if (status) {
        status.className = 'card-status-text is-error';
        status.textContent = 'Error: ' + err.message;
      }
      toast('Failed to save key: ' + err.message, true);
    }
  }

  async function removeProviderKey(providerId) {
    var ok = await openPlutonDialog({
      title: 'Remove API Key',
      message: 'Remove the stored credential for provider "' + providerId + '"? The provider configuration will remain.',
      confirmLabel: 'Remove Key',
      danger: true
    });
    if (!ok) return;
    try {
      var res = await apiFetch('/api/providers/' + encodeURIComponent(providerId) + '/key', {
        method: 'DELETE'
      });
      if (res && res.ok) {
        toast('Credential removed for ' + providerId);
        await loadProviders();
        await loadModels();
      }
    } catch (err) {
      toast('Failed to remove key: ' + err.message, true);
    }
  }

  async function validateProvider(providerId) {
    var statusNode = el('prov-status-' + providerId);
    if (statusNode) {
      statusNode.className = 'provider-status-msg';
      statusNode.textContent = 'Validating connectivity...';
      statusNode.classList.remove('is-hidden');
    }
    try {
      var res = await apiFetch('/api/providers/' + encodeURIComponent(providerId) + '/validate', {
        method: 'POST'
      });
      var rep = res.report;
      if (statusNode) {
        var isOk = rep.liveCheck === 'passed' || rep.authConfigured;
        statusNode.className = 'provider-status-msg ' + (isOk ? 'is-ok' : 'is-error');
        statusNode.textContent = rep.detail + (rep.modelsCount !== undefined ? ' (' + rep.modelsCount + ' models discovered)' : '');
      }
      toast('Validation ' + (rep.liveCheck === 'passed' ? 'passed' : 'result: ' + rep.detail));
      await loadModels();
    } catch (err) {
      if (statusNode) {
        statusNode.className = 'provider-status-msg is-error';
        statusNode.textContent = 'Validation error: ' + err.message;
      }
      toast('Validation failed: ' + err.message, true);
    }
  }

  async function deleteProvider(providerId) {
    var ok = await openPlutonDialog({
      title: 'Delete Provider',
      message: 'Are you sure you want to delete provider "' + providerId + '"? Metadata and credentials will be permanently removed.',
      confirmLabel: 'Delete Provider',
      danger: true
    });
    if (!ok) return;
    try {
      var res = await apiFetch('/api/providers/' + encodeURIComponent(providerId), {
        method: 'DELETE'
      });
      if (res && res.ok) {
        toast('Provider ' + providerId + ' deleted');
        await loadProviders();
        await loadModels();
      }
    } catch (err) {
      toast('Failed to delete provider: ' + err.message, true);
    }
  }

  function adjustTextareaHeight(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  }

  // ----------------------------------------------------------- voice input
  function toggleVoiceInput() {
    var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtn = el('btnMic');
    var input = el('promptInput');

    if (!SpeechRec) {
      toast('Web Speech API is not supported in this browser environment.', true);
      return;
    }

    if (state.isRecordingVoice) {
      if (state.speechRecognition) {
        state.speechRecognition.stop();
      }
      state.isRecordingVoice = false;
      if (micBtn) micBtn.classList.remove('is-listening');
      toast('Voice recording stopped.');
      return;
    }

    try {
      var recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = function () {
        state.isRecordingVoice = true;
        if (micBtn) micBtn.classList.add('is-listening');
        toast('Listening... Speak into your microphone.');
      };

      recognition.onresult = function (event) {
        var transcript = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (input && transcript) {
          var cur = input.value;
          input.value = cur ? (cur + ' ' + transcript.trim()) : transcript.trim();
          adjustTextareaHeight(input);
        }
      };

      recognition.onerror = function (event) {
        console.warn('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          toast('Microphone permission denied.', true);
        } else if (event.error !== 'no-speech') {
          toast('Voice input error: ' + event.error, true);
        }
        state.isRecordingVoice = false;
        if (micBtn) micBtn.classList.remove('is-listening');
      };

      recognition.onend = function () {
        state.isRecordingVoice = false;
        if (micBtn) micBtn.classList.remove('is-listening');
      };

      state.speechRecognition = recognition;
      recognition.start();
    } catch (err) {
      state.isRecordingVoice = false;
      if (micBtn) micBtn.classList.remove('is-listening');
      toast('Failed to start voice recognition: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------ approvals
  async function loadApprovals() {
    try {
      var res = await apiFetch('/api/approvals');
      var all = res.approvals || [];
      all.forEach(function (a) {
        if (isQuestionApproval(a)) {
          renderQaQuestionCard(a);
        }
      });
      var pending = all.filter(function (a) { return a.status === 'pending' && !isQuestionApproval(a); });
      renderApprovals(pending);
      if (pending.length > 0 && !state.pendingApprovalId) {
        showPendingApproval(pending[0]);
      }
    } catch (err) {
      var node = el('approvalsList');
      if (node) node.innerHTML = '<div class="empty-hint">Failed to read approvals: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderApprovals(pending) {
    var node = el('approvalsList');
    if (!node) return;
    if (!pending || pending.length === 0) {
      node.innerHTML = '<div class="empty-hint">No pending approvals.</div>';
      return;
    }
    node.innerHTML = pending.map(function (a) {
      return '<div class="approval-row"><div class="approval-row-action">' + escapeHtml(a.action || 'action') + '</div>' +
        '<div class="approval-row-reason">' + escapeHtml(a.reason || '') + '</div>' +
        '<div class="approval-row-actions">' +
        '<button class="btn-sm btn-ok" data-approve-continue="' + escapeHtml(a.id) + '">Approve &amp; Continue</button>' +
        '<button class="btn-sm btn-primary" data-approve="' + escapeHtml(a.id) + '">Approve</button>' +
        '<button class="btn-sm btn-danger" data-deny="' + escapeHtml(a.id) + '">Deny</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(node.querySelectorAll('[data-approve-continue]'), function (b) {
      b.addEventListener('click', function () { decidePendingApproval(b.getAttribute('data-approve-continue'), 'approved', true); });
    });
    Array.prototype.forEach.call(node.querySelectorAll('[data-approve]'), function (b) {
      b.addEventListener('click', function () { decidePendingApproval(b.getAttribute('data-approve'), 'approved', false); });
    });
    Array.prototype.forEach.call(node.querySelectorAll('[data-deny]'), function (b) {
      b.addEventListener('click', function () { decidePendingApproval(b.getAttribute('data-deny'), 'denied', false); });
    });
  }

  function showPendingApproval(approval) {
    if (!approval) return;
    state.pendingApprovalId = approval.id;
    var banner = el('pinnedApprovalBanner');
    var action = el('approvalAction');
    var reason = el('approvalReason');
    if (action) action.textContent = 'Approval required: ' + (approval.action || 'Execute action');
    if (reason) reason.textContent = approval.reason || ('Requested by ' + (approval.requestedByShip || approval.requestedByMuse || 'agent'));
    if (banner) banner.classList.remove('is-hidden');
    var okCont = el('btnBannerApproveContinue');
    var ok = el('btnBannerApprove');
    var no = el('btnBannerDeny');
    if (okCont) okCont.onclick = function () { decidePendingApproval(approval.id, 'approved', true); };
    if (ok) ok.onclick = function () { decidePendingApproval(approval.id, 'approved', false); };
    if (no) no.onclick = function () { decidePendingApproval(approval.id, 'denied', false); };
  }

  function hidePendingApproval() {
    state.pendingApprovalId = null;
    var banner = el('pinnedApprovalBanner');
    if (banner) banner.classList.add('is-hidden');
  }

  async function decidePendingApproval(id, decision, autoContinue) {
    try {
      var res = await apiFetch('/api/approvals/' + encodeURIComponent(id) + '/decide', {
        method: 'POST',
        body: JSON.stringify({ decision: decision, autoContinue: !!autoContinue })
      });
      hidePendingApproval();
      toast('Approval recorded: ' + decision);
      await loadApprovals();
      await refreshActiveRun();
    } catch (err) {
      toast('Failed to record approval: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------ qa questions
  function isQuestionApproval(approval) {
    if (!approval) return false;
    return approval.kind === 'question' ||
      approval.action === 'qa.question' ||
      (typeof approval.action === 'string' && approval.action.indexOf('question') !== -1);
  }

  var autoDecidingApprovals = {};
  async function autoDecideQuestionApproval(approval) {
    if (!approval || approval.status !== 'pending' || !approval.id) return;
    if (autoDecidingApprovals[approval.id]) return;
    autoDecidingApprovals[approval.id] = true;
    var scope = approval.scope || {};
    if (typeof scope === 'string') {
      try { scope = JSON.parse(scope); } catch (e) { scope = {}; }
    }
    var options = approval.options || scope.options || [];
    var selectedOption = approval.selectedOption || (options.length > 0 ? options[0] : undefined);
    try {
      await apiFetch('/api/approvals/' + encodeURIComponent(approval.id) + '/decide', {
        method: 'POST',
        body: JSON.stringify({
          decision: 'approved',
          selectedOption: selectedOption,
          autoContinue: true
        })
      });
      loadApprovals();
      refreshActiveRun();
    } catch (err) {
      delete autoDecidingApprovals[approval.id];
    }
  }

  function renderQaQuestionCardHtml(opts) {
    var titleHtml = '<div class="qa-title">' + escapeHtml(opts.title) + '</div>';
    var descHtml = opts.description ? '<div class="qa-desc">' + escapeHtml(opts.description) + '</div>' : '';
    var badgesHtml = opts.dependentTasks && opts.dependentTasks.length > 0
      ? '<div class="qa-badges">' + opts.dependentTasks.map(function (t) { return '<span class="qa-badge">' + escapeHtml(t) + '</span>'; }).join('') + '</div>'
      : '';
    var optionsHtml = opts.options && opts.options.length > 0
      ? '<div class="qa-options">' + opts.options.map(function (opt) {
          var isSelected = opts.selectedOption === opt;
          return '<button type="button" class="qa-option-btn' + (isSelected ? ' is-selected' : '') + '" data-option="' + escapeHtml(opt) + '">' + escapeHtml(opt) + '</button>';
        }).join('') + '</div>'
      : '';
    var statusHtml = opts.resolved
      ? '<div class="qa-resolved-status qa-resolved">Unblocked and confirmed' + (opts.selectedOption ? ': <strong>' + escapeHtml(opts.selectedOption) + '</strong>' : '') + '</div>'
      : '';
    var actionsHtml = '<div class="qa-actions"><button type="button" class="btn-primary qa-confirm-btn' +
      (opts.resolved ? ' is-resolved' : '') + '" data-confirm-qa="' + escapeHtml(opts.id) + '"' +
      (opts.resolved ? ' disabled' : '') + '>Confirm & Unblock</button></div>';
    var resolvedClass = opts.resolved ? ' qa-resolved' : '';
    return '<div class="qa-card' + resolvedClass + '" id="qa-card-' + escapeHtml(opts.id) + '" data-qa-id="' + escapeHtml(opts.id) + '">' +
      '<div class="qa-card-head">' + titleHtml + badgesHtml + '</div>' +
      descHtml +
      optionsHtml +
      statusHtml +
      actionsHtml +
      '</div>';
  }

  function renderQaQuestionCard(approval) {
    var list = el('messagesList');
    if (approval && approval.id) {
      var existing = document.getElementById('qa-card-' + approval.id) || (list && list.querySelector('[data-qa-id="' + approval.id + '"]'));
      if (existing) existing.remove();
    }
    if (approval && approval.status === 'pending') {
      autoDecideQuestionApproval(approval);
    }
  }

  function bindQaCardEvents(card, approvalId) {
    var optionBtns = card.querySelectorAll('.qa-option-btn');
    Array.prototype.forEach.call(optionBtns, function (btn) {
      btn.addEventListener('click', function () {
        if (card.classList.contains('qa-resolved')) return;
        Array.prototype.forEach.call(optionBtns, function (b) { b.classList.remove('is-selected'); });
        btn.classList.add('is-selected');
        var confirmBtn = card.querySelector('[data-confirm-qa]');
        if (confirmBtn) confirmBtn.disabled = false;
      });
    });

    var confirmBtn = card.querySelector('[data-confirm-qa]');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async function () {
        if (confirmBtn.disabled) return;
        var selectedBtn = card.querySelector('.qa-option-btn.is-selected');
        var selectedOption = selectedBtn ? selectedBtn.getAttribute('data-option') : undefined;
        try {
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Unblocking\\u2026';
          var res = await apiFetch('/api/approvals/' + encodeURIComponent(approvalId) + '/decide', {
            method: 'POST',
            body: JSON.stringify({
              decision: 'approved',
              selectedOption: selectedOption,
              autoContinue: true
            })
          });
          toast('Question confirmed & unblocked');
          updateQaCardSettled(card, { id: approvalId, status: 'approved', selectedOption: selectedOption });
          await loadApprovals();
          await refreshActiveRun();
        } catch (err) {
          toast('Failed to confirm question: ' + err.message, true);
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Confirm & Unblock';
        }
      });
    }
  }

  function updateQaCardSettled(card, approval) {
    if (!card) return;
    card.classList.add('qa-resolved');
    var selectedOption = approval.selectedOption;
    if (!selectedOption) {
      var selBtn = card.querySelector('.qa-option-btn.is-selected');
      if (selBtn) selectedOption = selBtn.getAttribute('data-option');
    }
    var existingStatus = card.querySelector('.qa-resolved-status');
    if (!existingStatus) {
      var statusDiv = document.createElement('div');
      statusDiv.className = 'qa-resolved-status qa-resolved';
      statusDiv.innerHTML = 'Unblocked and confirmed' + (selectedOption ? ': <strong>' + escapeHtml(selectedOption) + '</strong>' : '');
      var actions = card.querySelector('.qa-actions');
      if (actions) {
        card.insertBefore(statusDiv, actions);
      } else {
        card.appendChild(statusDiv);
      }
    } else if (selectedOption) {
      existingStatus.innerHTML = 'Unblocked and confirmed: <strong>' + escapeHtml(selectedOption) + '</strong>';
    }
    var confirmBtn = card.querySelector('[data-confirm-qa]');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.classList.add('is-resolved');
      confirmBtn.textContent = 'Confirm & Unblock';
    }
    var optionBtns = card.querySelectorAll('.qa-option-btn');
    Array.prototype.forEach.call(optionBtns, function (b) {
      if (selectedOption && b.getAttribute('data-option') === selectedOption) {
        b.classList.add('is-selected');
      } else if (selectedOption) {
        b.classList.remove('is-selected');
      }
    });
  }

  // ------------------------------------------------------------ orchestra
  async function loadRunDetail(runId) {
    if (!runId) {
      renderOrchestra(null, [], []);
      return;
    }
    // A different run means the inspector holds stale partitions: drop the
    // previous run's tasks/workers before reconstituting from this run's data.
    if (state.loadedRunId && state.loadedRunId !== runId) {
      state.tasks = {};
      state.workers = {};
      clearRunActivity();
      if (workerDetailIsOpen()) closeWorkerDetail();
      var grid = el('rightInspectorGrid');
      if (grid) grid.innerHTML = '';
    }
    state.loadedRunId = runId;
    try {
      var res = await apiFetch('/api/runs/' + encodeURIComponent(runId));
      renderOrchestra(res.run.run, res.run.tasks || [], res.run.edges || [], res.run.supervisorStale === true);
      if (res.run && res.run.run) {
        state.activeRunState = res.run.run.state;
      }
      if (res.run && res.run.tasks) {
        if (res.run.run && TERMINAL_RUN_STATES[res.run.run.state]) {
          state.tasks = {};
        } else {
          res.run.tasks.forEach(function (t) {
            if (!t || !t.id) return;
            state.tasks[t.id] = { id: t.id, title: t.title, state: t.state, runId: runId };
          });
        }
        updateActivityBadge();
        reconstituteWorkerPartitions(res.run.tasks);
      }
      // Recover activity missed while disconnected (the log watcher only
      // streams future events); the cursor makes this exactly-once.
      await loadRunActivity(runId);
    } catch (err) {
      renderOrchestra(null, [], []);
      renderDag([], []);
    }
  }

  async function refreshActiveRun() {
    await loadRunDetail(state.activeRunId);
  }

  function renderOrchestra(run, tasks, edges, supervisorStale) {
    var node = el('activeRunCard');
    if (node) {
      if (!run) {
        node.innerHTML = '<div class="empty-hint">No active run in this workspace.</div>';
      } else {
        var muses = (state.workspace && state.workspace.muses) || [];
        // The run's own persisted answer: what a fresh read (and every later
        // reload) returns for a terminal run - not just the state badge.
        var finalRow = '';
        if (TERMINAL_RUN_STATES[run.state] && typeof run.finalSummary === 'string' && run.finalSummary !== '') {
          finalRow = '<div class="orchestra-row orchestra-result"><span>Result</span><span>' +
            escapeHtml(redactSecrets(run.finalSummary)) + '</span></div>';
        }
        // Stranded-run hint: never a state change, just honest evidence the
        // run row may have outlived its supervisor.
        var staleRow = '';
        if (supervisorStale) {
          staleRow = '<div class="orchestra-row orchestra-stale"><span>Supervisor</span><span>' +
            'heartbeat stale - the run may be stranded; use Resume to recover it' +
            '</span></div>';
        }
        node.innerHTML =
          '<div class="orchestra-row"><span>Run</span><span class="mono">' + escapeHtml(run.id) + '</span></div>' +
          '<div class="orchestra-row"><span>Goal</span><span>' + escapeHtml(run.goal) + '</span></div>' +
          '<div class="orchestra-row"><span>State</span><span class="badge ' + (run.state === 'completed' ? 'badge-ok' : run.state === 'failed' ? 'badge-off' : 'badge-warn') + '">' + escapeHtml(run.state) + '</span></div>' +
          finalRow +
          staleRow +
          '<div class="orchestra-row"><span>Tasks</span><span>' + tasks.length + ' (' + tasks.filter(function (t) { return t.state === 'completed'; }).length + ' done)</span></div>' +
          '<div class="orchestra-row"><span>Team</span><span>' + muses.length + ' agents</span></div>';
      }
    }
    renderDag(tasks, edges);
    var verifyBtn = el('btnVerifyRedispatch');
    var resumeBtn = el('btnResumeRun');
    var diffBtn = el('btnViewRunDiff');
    if (run) {
      if (verifyBtn) verifyBtn.classList.toggle('is-hidden', !(run.state === 'verifying' || run.state === 'active' || run.state === 'awaiting_approval'));
      if (resumeBtn) resumeBtn.classList.toggle('is-hidden', !(run.state === 'active' || run.state === 'awaiting_approval'));
      if (diffBtn) diffBtn.classList.remove('is-hidden');
    } else {
      if (verifyBtn) verifyBtn.classList.add('is-hidden');
      if (resumeBtn) resumeBtn.classList.add('is-hidden');
      if (diffBtn) diffBtn.classList.add('is-hidden');
    }
  }

  function renderDag(tasks, edges) {
    var container = el('dagContainer');
    if (!container) return;
    if (!tasks || tasks.length === 0) {
      container.innerHTML = '<div class="empty-hint">No tasks admitted for this run yet.</div>';
      return;
    }
    var depths = {};
    tasks.forEach(function (t) {
      var prereqs = edges.filter(function (e) { return e.toTaskId === t.id; });
      if (prereqs.length === 0) depths[t.id] = 0;
    });
    for (var iter = 0; iter < 20; iter++) {
      tasks.forEach(function (t) {
        var prereqs = edges.filter(function (e) { return e.toTaskId === t.id; });
        var maxP = -1;
        prereqs.forEach(function (p) {
          if (depths[p.fromTaskId] !== undefined) maxP = Math.max(maxP, depths[p.fromTaskId]);
        });
        var next = maxP + 1;
        if (next > (depths[t.id] || 0)) depths[t.id] = next;
      });
    }
    var stageMap = {};
    tasks.forEach(function (t) {
      var d = depths[t.id] || 0;
      if (!stageMap[d]) stageMap[d] = [];
      stageMap[d].push(t);
    });
    var stages = Object.keys(stageMap).map(Number).sort(function (a, b) { return a - b; });
    var renderCardHtml = function (t) {
      var pill = t.state === 'completed' ? 'succeeded' : (t.state === 'running' || t.state === 'active') ? 'running' : (t.state === 'failed' || t.state === 'cancelled') ? 'failed' : 'pending';
      // The persisted worker result body (defect 2026-10-21): workers' actual
      // answers are stored in result_json, so a finished card shows the
      // content that task.get_result keeps returning - not just the state pill.
      var resultBody = t && t.result && typeof t.result === 'object' && !Array.isArray(t.result)
        && typeof t.result.text === 'string' && t.result.text !== '' ? t.result.text : '';
      var resultRow = resultBody ? '<div class="dag-task-result" title="' +
        escapeHtml(redactSecrets(resultBody)) + '">' +
        escapeHtml(redactSecrets(resultBody.slice(0, 600))) + (resultBody.length > 600 ? '\u2026' : '') +
        '</div>' : '';
      return '<div class="dag-task-card state-' + escapeHtml(t.state) + '"><div class="dag-card-header">' +
        '<div class="dag-task-title">' + escapeHtml(t.title) + '</div>' +
        '<span class="tool-status ' + pill + '">' + escapeHtml(t.state) + '</span></div>' +
        '<div class="dag-task-meta"><span>' + escapeHtml(t.assigneeMuseId || 'coordinator') + '</span>' +
        '<span>' + escapeHtml(t.id) + '</span></div>' +
        resultRow +
        '<div class="dag-task-actions"><button class="btn-secondary" data-task-diff="' + escapeHtml(t.id) + '">View Diff</button>' +
        (t.state === 'verifying' ? '<button class="btn-secondary" data-task-verify="' + escapeHtml(t.id) + '">Verify Task</button>' : '') +
        '</div></div>';
    };
    var content = '';
    if (state.dagViewMode === 'flow') {
      content = '<div class="dag-flow-container">' + stages.map(function (stageIdx, idx) {
        var stageTasks = stageMap[stageIdx] || [];
        var label = stageIdx === 0 ? 'Stage 1 \\u00b7 Root' : 'Stage ' + (stageIdx + 1) + ' \\u00b7 Dependent';
        return (idx > 0 ? '<div class="dag-flow-arrow">&#10148;</div>' : '') +
          '<div class="dag-stage-col"><div class="dag-stage-header"><span>' + label + '</span><span>' + stageTasks.length + ' tasks</span></div>' +
          stageTasks.map(renderCardHtml).join('') + '</div>';
      }).join('') + '</div>';
    } else {
      content = tasks.map(renderCardHtml).join('');
    }
    container.innerHTML = '<div class="card-head-actions" style="justify-content:space-between;">' +
      '<span class="card-sub">Run Tasks DAG (' + tasks.length + ' tasks)</span>' +
      '<button class="btn-secondary" id="btnToggleDagMode">' + (state.dagViewMode === 'flow' ? 'Card List' : 'Stage Pipeline') + '</button></div>' +
      content;
    var toggle = el('btnToggleDagMode');
    if (toggle) {
      toggle.addEventListener('click', function () {
        state.dagViewMode = state.dagViewMode === 'flow' ? 'list' : 'flow';
        refreshActiveRun();
      });
    }
    Array.prototype.forEach.call(container.querySelectorAll('[data-task-diff]'), function (b) {
      b.addEventListener('click', function () { loadTaskDiff(b.getAttribute('data-task-diff')); });
    });
    Array.prototype.forEach.call(container.querySelectorAll('[data-task-verify]'), function (b) {
      b.addEventListener('click', function () { plutonVerifyTask(state.activeRunId, b.getAttribute('data-task-verify')); });
    });
  }

  async function plutonVerifyTask(runId, taskId) {
    try {
      toast('Running verification checks on ' + taskId + '\\u2026');
      var res = await apiFetch('/api/runs/' + encodeURIComponent(runId) + '/verify', {
        method: 'POST',
        body: JSON.stringify({ taskId: taskId, dispatch: true })
      });
      var report = res.taskReports && res.taskReports[0] ? res.taskReports[0].verdict : 'complete';
      toast('Task verified. Report: ' + report);
      refreshActiveRun();
    } catch (err) {
      toast('Verification error: ' + err.message, true);
    }
  }

  // ---------------------------------------------------------------- files
  var CHEV_ICON = '<svg class="file-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
  var TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/></svg>';

  function getFileIconSvg(name, isDir, isOpen) {
    if (isDir) {
      if (isOpen) {
        return '<svg class="file-icon file-icon-dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/><path d="M3 13h18"/></svg>';
      }
      return '<svg class="file-icon file-icon-dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
    }

    var lower = String(name || '').toLowerCase();
    var ext = lower.split('.').pop();

    if (lower === 'package.json' || lower === 'package-lock.json' || lower === 'yarn.lock' || lower === 'pnpm-lock.yaml') {
      return '<svg class="file-icon icon-manifest" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
    }
    if (lower.indexOf('tsconfig') !== -1 || lower.indexOf('.config.') !== -1 || lower.indexOf('.env') === 0) {
      return '<svg class="file-icon icon-config" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';
    }

    if (ext === 'ts') {
      return '<svg class="file-icon icon-ts" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9h4M10 9v7M15 11c-.5-.6-1-1-1.7-1-.9 0-1.3.5-1.3 1.1 0 1.5 2.5 1.3 2.5 2.9 0 .9-.7 1.6-1.8 1.6-.9 0-1.6-.5-2-1.2"/></svg>';
    }
    if (ext === 'tsx') {
      return '<svg class="file-icon icon-tsx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 9h3M8.5 9v6M12 11l3 4M15 11l-3 4M17 11c-.4-.6-.8-1-1.4-1-.8 0-1.1.5-1.1 1 0 1.4 2.1 1.2 2.1 2.6 0 .8-.6 1.4-1.5 1.4-.8 0-1.3-.4-1.7-1"/></svg>';
    }
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
      return '<svg class="file-icon icon-js" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M10 9v5a2 2 0 01-2 2H7M16 11c-.5-.6-1-1-1.7-1-.9 0-1.3.5-1.3 1.1 0 1.5 2.5 1.3 2.5 2.9 0 .9-.7 1.6-1.8 1.6-.9 0-1.6-.5-2-1.2"/></svg>';
    }
    if (ext === 'jsx') {
      return '<svg class="file-icon icon-jsx" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 9v5a2 2 0 01-2 2H6M13 11l3 4M16 11l-3 4"/></svg>';
    }
    if (ext === 'py') {
      return '<svg class="file-icon icon-py" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9H7a3 3 0 00-3 3v2a3 3 0 003 3h1v-2a2 2 0 012-2h4a2 2 0 002-2V9a3 3 0 00-3-3h-2M12 15h5a3 3 0 003-3v-2a3 3 0 00-3-3h-1v2a2 2 0 01-2 2h-4a2 2 0 00-2 2v2a3 3 0 003 3h2"/><circle cx="8" cy="9" r="1" fill="currentColor"/><circle cx="16" cy="15" r="1" fill="currentColor"/></svg>';
    }
    if (ext === 'json') {
      return '<svg class="file-icon icon-json" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4c-1.5 0-2 1-2 2v4c0 1-.5 1.5-1.5 1.5C3.5 11.5 3 12 3 12s.5.5 1.5.5c1 0 1.5.5 1.5 1.5v4c0 1 .5 2 2 2M16 4c1.5 0 2 1 2 2v4c0 1 .5 1.5 1.5 1.5 1 0 1.5.5 1.5.5s-.5.5-1.5.5c-1 0-1.5.5-1.5 1.5v4c0 1-.5 2-2 2"/></svg>';
    }
    if (ext === 'yml' || ext === 'yaml') {
      return '<svg class="file-icon icon-yaml" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l6 8v8M20 4l-6 8"/></svg>';
    }
    if (ext === 'md' || ext === 'markdown' || ext === 'txt') {
      return '<svg class="file-icon icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8v8l3-3 3 3V8M17 11l-2 3h4z"/></svg>';
    }
    if (ext === 'html' || ext === 'htm') {
      return '<svg class="file-icon icon-html" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6M14 4l-4 16"/></svg>';
    }
    if (ext === 'css' || ext === 'scss' || ext === 'less') {
      return '<svg class="file-icon icon-css" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l1.5 15L12 21l4.5-3L18 3H6z"/><path d="M9 8h6M8.5 12h6M10 16l2 1 2-1"/></svg>';
    }
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg' || ext === 'ico' || ext === 'webp') {
      return '<svg class="file-icon icon-img" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
    }
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'bat' || ext === 'cmd' || ext === 'ps1') {
      return '<svg class="file-icon icon-sh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-5-6-5M12 19h8"/></svg>';
    }

    return '<svg class="file-icon icon-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
  }

  function updateBreadcrumbs(path) {
    state.currentNavPath = path || '';
    var container = el('fileBreadcrumbs');
    if (!container) return;
    var html = '<span class="file-breadcrumb-segment" data-breadcrumb-path="" title="Workspace root">root</span>';
    if (path && path.trim() !== '') {
      var parts = path.split('/').filter(Boolean);
      var accum = '';
      for (var i = 0; i < parts.length; i++) {
        accum = accum ? accum + '/' + parts[i] : parts[i];
        html += '<span class="file-breadcrumb-sep">/</span>';
        html += '<span class="file-breadcrumb-segment" data-breadcrumb-path="' + escapeHtml(accum) + '">' + escapeHtml(parts[i]) + '</span>';
      }
    }
    container.innerHTML = html;
    Array.prototype.forEach.call(container.querySelectorAll('.file-breadcrumb-segment'), function (seg) {
      seg.addEventListener('click', function () {
        var segPath = seg.getAttribute('data-breadcrumb-path');
        navigateBreadcrumb(segPath);
      });
    });
  }

  async function navigateBreadcrumb(segPath) {
    if (!segPath) {
      updateBreadcrumbs('');
      return;
    }
    await expandDirRecursively(segPath);
  }

  function renderDirectoryChildren(dirPath, entries, hasMore) {
    if (!entries || entries.length === 0) {
      return '<div class="empty-hint" style="padding: 4px 12px; font-size: 11px;">(empty directory)</div>';
    }
    var html = '';
    entries.forEach(function (entry) {
      if (entry.type === 'dir') {
        var isOpen = state.expandedDirs.has(entry.path);
        var dirCached = state.dirCache[entry.path];
        html += '<div class="file-row file-dir' + (isOpen ? ' is-open' : '') + '" data-dir-path="' + escapeHtml(entry.path) + '" role="treeitem" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
          CHEV_ICON + getFileIconSvg(entry.name, true, isOpen) +
          '<span class="file-name">' + escapeHtml(entry.name) + '</span>' +
          '</div>';
        html += '<div class="file-children' + (isOpen ? '' : ' is-collapsed') + '" data-children-for="' + escapeHtml(entry.path) + '">';
        if (isOpen && dirCached) {
          html += renderDirectoryChildren(entry.path, dirCached.entries, dirCached.hasMore);
        }
        html += '</div>';
      } else {
        html += '<div class="file-row file-item" data-path="' + escapeHtml(entry.path) + '" title="' + escapeHtml(entry.path) + '" role="treeitem">' +
          getFileIconSvg(entry.name, false, false) +
          '<span class="file-name">' + escapeHtml(entry.name) + '</span>' +
          '<button class="file-row-delete" type="button" data-delete-path="' + escapeHtml(entry.path) + '" title="Delete file" aria-label="Delete file ' + escapeHtml(entry.path) + '">' + TRASH_ICON + '</button>' +
          '</div>';
      }
    });
    if (hasMore) {
      html += '<div class="file-load-more" data-load-more-dir="' + escapeHtml(dirPath) + '" role="button" tabindex="0">Load more\\u2026 (' + entries.length + ' shown)</div>';
    }
    return html;
  }

  async function onDirRowClick(row) {
    var dirPath = row.getAttribute('data-dir-path');
    if (!dirPath) return;
    var kids = row.nextElementSibling;
    if (!kids || !kids.classList.contains('file-children')) return;

    if (state.expandedDirs.has(dirPath)) {
      state.expandedDirs.delete(dirPath);
      row.classList.remove('is-open');
      row.setAttribute('aria-expanded', 'false');
      kids.classList.add('is-collapsed');
      var icon = row.querySelector('.file-icon');
      if (icon) {
        var parts = dirPath.split('/');
        icon.outerHTML = getFileIconSvg(parts[parts.length - 1], true, false);
      }
    } else {
      state.expandedDirs.add(dirPath);
      row.classList.add('is-open');
      row.setAttribute('aria-expanded', 'true');
      kids.classList.remove('is-collapsed');
      var icon = row.querySelector('.file-icon');
      if (icon) {
        var parts = dirPath.split('/');
        icon.outerHTML = getFileIconSvg(parts[parts.length - 1], true, true);
      }
      updateBreadcrumbs(dirPath);
      if (!state.dirCache[dirPath]) {
        kids.innerHTML = '<div class="empty-hint" style="padding: 4px 12px; font-size: 11px;">Loading\\u2026</div>';
        try {
          var url = '/api/files?dir=' + encodeURIComponent(dirPath);
          if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
          var res = await apiFetch(url);
          state.dirCache[dirPath] = {
            entries: res.entries || [],
            total: res.total || 0,
            hasMore: !!res.hasMore,
            offset: res.offset || 0
          };
          kids.innerHTML = renderDirectoryChildren(dirPath, state.dirCache[dirPath].entries, state.dirCache[dirPath].hasMore);
          bindFileTree(kids);
        } catch (err) {
          kids.innerHTML = '<div class="empty-hint wd-error" style="padding: 4px 12px;">Failed to load: ' + escapeHtml(err.message) + '</div>';
        }
      }
    }
  }

  async function loadMoreDirectory(dirPath, btn) {
    var cached = state.dirCache[dirPath];
    if (!cached) return;
    var nextOffset = (cached.offset || 0) + 500;
    btn.textContent = 'Loading\\u2026';
    btn.style.pointerEvents = 'none';
    try {
      var url = '/api/files?dir=' + encodeURIComponent(dirPath) + '&offset=' + nextOffset + '&limit=500';
      if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      var res = await apiFetch(url);
      var newEntries = res.entries || [];
      cached.entries = cached.entries.concat(newEntries);
      cached.offset = nextOffset;
      cached.hasMore = !!res.hasMore;
      var kids = btn.parentElement;
      if (kids) {
        kids.innerHTML = renderDirectoryChildren(dirPath, cached.entries, cached.hasMore);
        bindFileTree(kids);
      }
    } catch (err) {
      btn.textContent = 'Load more failed. Retry?';
      btn.style.pointerEvents = '';
    }
  }

  function bindFileTree(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.file-dir'), function (row) {
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        onDirRowClick(row);
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll('.file-item'), function (row) {
      row.addEventListener('click', function () {
        var rootList = el('filesList');
        if (rootList) {
          Array.prototype.forEach.call(rootList.querySelectorAll('.file-item'), function (i) { i.classList.remove('is-active'); });
        }
        row.classList.add('is-active');
        openFile(row.getAttribute('data-path'));
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll('[data-delete-path]'), function (button) {
      button.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteWorkspaceFile(button.getAttribute('data-delete-path'));
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll('[data-load-more-dir]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dirPath = btn.getAttribute('data-load-more-dir');
        loadMoreDirectory(dirPath, btn);
      });
    });
  }

  function highlightSearchMatch(text, query) {
    if (!text) return '';
    if (!query) return escapeHtml(text);
    var lowerText = text.toLowerCase();
    var lowerQuery = query.toLowerCase();
    var idx = lowerText.indexOf(lowerQuery);
    if (idx === -1) return escapeHtml(text);
    var before = escapeHtml(text.slice(0, idx));
    var match = escapeHtml(text.slice(idx, idx + query.length));
    var after = escapeHtml(text.slice(idx + query.length));
    return before + '<span class="file-search-match">' + match + '</span>' + after;
  }

  async function searchWorkspace(query) {
    var searchResults = el('fileSearchResults');
    var filesList = el('filesList');
    if (filesList) filesList.classList.add('is-hidden');
    if (!searchResults) return;
    searchResults.classList.remove('is-hidden');
    searchResults.innerHTML = '<div class="empty-hint" style="padding: 8px;">Searching workspace\\u2026</div>';

    try {
      var url = '/api/files/search?q=' + encodeURIComponent(query);
      if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      var res = await apiFetch(url);
      var matches = res.matches || [];
      if (matches.length === 0) {
        searchResults.innerHTML = '<div class="empty-hint" style="padding: 8px;">No matches found for "' + escapeHtml(query) + '".</div>';
        return;
      }
      var html = '';
      matches.forEach(function (m) {
        var isDir = m.type === 'dir';
        var icon = getFileIconSvg(m.name, isDir, false);
        html += '<div class="file-search-result-item" data-search-path="' + escapeHtml(m.path) + '" data-search-type="' + m.type + '" title="' + escapeHtml(m.path) + '">';
        html += icon;
        html += '<span class="file-name truncate">' + highlightSearchMatch(m.path, query) + '</span>';
        html += '</div>';
      });
      if (res.truncated) {
        html += '<div class="empty-hint" style="font-size: 11px; padding: 4px 8px;">Capped at ' + matches.length + ' matches. Refine query for more.</div>';
      }
      searchResults.innerHTML = html;
      bindSearchResults(searchResults);
    } catch (err) {
      searchResults.innerHTML = '<div class="empty-hint wd-error" style="padding: 8px;">Search failed: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function bindSearchResults(container) {
    Array.prototype.forEach.call(container.querySelectorAll('.file-search-result-item'), function (item) {
      item.addEventListener('click', async function () {
        var path = item.getAttribute('data-search-path');
        var type = item.getAttribute('data-search-type');
        if (type === 'file') {
          openFile(path);
        } else if (type === 'dir') {
          var searchIn = el('fileSearchInput');
          if (searchIn) searchIn.value = '';
          var clearBtn = el('fileSearchClear');
          if (clearBtn) clearBtn.classList.add('is-hidden');
          var searchRes = el('fileSearchResults');
          if (searchRes) searchRes.classList.add('is-hidden');
          var list = el('filesList');
          if (list) list.classList.remove('is-hidden');
          await expandDirRecursively(path);
        }
      });
    });
  }

  async function expandDirRecursively(dirPath) {
    var parts = dirPath.split('/').filter(Boolean);
    var accum = '';
    for (var i = 0; i < parts.length; i++) {
      accum = accum ? accum + '/' + parts[i] : parts[i];
      state.expandedDirs.add(accum);
      if (!state.dirCache[accum]) {
        try {
          var url = '/api/files?dir=' + encodeURIComponent(accum);
          if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
          var res = await apiFetch(url);
          state.dirCache[accum] = {
            entries: res.entries || [],
            total: res.total || 0,
            hasMore: !!res.hasMore,
            offset: res.offset || 0
          };
        } catch (e) {}
      }
    }
    var listNode = el('filesList');
    if (listNode && state.dirCache['']) {
      listNode.innerHTML = renderDirectoryChildren('', state.dirCache[''].entries, state.dirCache[''].hasMore);
      bindFileTree(listNode);
    }
    updateBreadcrumbs(dirPath);
  }

  async function deleteWorkspaceFile(path) {
    var ok = await plutonConfirm({
      title: 'Delete file',
      message: 'Delete "' + path + '" from the workspace? This cannot be undone.',
      confirmLabel: 'Delete file',
      danger: true
    });
    if (!ok) return;
    try {
      var url = '/api/files/content?path=' + encodeURIComponent(path);
      if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      await apiFetch(url, { method: 'DELETE' });
      if (state.editorTabs.some(function (t) { return t.path === path; })) {
        await closeEditorTab(path, true);
      } else if (state.viewerPath === path) {
        closeFileViewer(true);
      }
      await loadFilesList();
      toast('File deleted');
    } catch (err) {
      toast('Failed to delete ' + path + ': ' + err.message, true);
    }
  }

  /**
   * Render the "the file list could not be read" state with a working retry.
   *
   * The retry re-issues the same real API call - there is no cached list to
   * fall back on, and the failure is usually transient (the server is still
   * starting, the workspace is momentarily unreadable).
   */
  function renderFileListError(listNode, message, retryFn) {
    if (!listNode) return;
    listNode.innerHTML = '<div class="empty-hint">Failed to list files: ' + escapeHtml(message) + '</div>' +
      '<button class="btn-secondary btn-retry" type="button" data-action="retry-file-list">Retry</button>';
    var retry = listNode.querySelector('[data-action="retry-file-list"]');
    if (retry) retry.addEventListener('click', retryFn);
  }

  var filesRefreshTimer = null;
  function scheduleFilesRefresh(immediate) {
    if (filesRefreshTimer) clearTimeout(filesRefreshTimer);
    if (immediate) {
      filesRefreshTimer = null;
      loadFilesList(true);
      return;
    }
    filesRefreshTimer = setTimeout(function () {
      filesRefreshTimer = null;
      loadFilesList(true);
    }, 350);
  }

  async function loadFilesList(background) {
    var list = el('filesList');
    if (list && !background && (!state.dirCache[''] || state.dirCache[''].entries.length === 0)) {
      list.innerHTML = '<div class="empty-hint">Loading files\\u2026</div>';
    }
    try {
      var res = state.activeSessionId
        ? await apiFetch('/api/files?sessionId=' + encodeURIComponent(state.activeSessionId))
        : await apiFetch('/api/files');
      var entries = res.entries || [];
      state.dirCache[''] = {
        entries: entries,
        total: res.total || 0,
        hasMore: !!res.hasMore,
        offset: res.offset || 0
      };
      state.fileList = res.files || entries.map(function (e) { return e.path; });
      var listNode = el('filesList');
      if (!listNode) return;
      if (entries.length === 0) {
        listNode.innerHTML = '<div class="empty-hint">No files in the workspace.</div>';
        return;
      }
      listNode.innerHTML = renderDirectoryChildren('', entries, state.dirCache[''].hasMore);
      bindFileTree(listNode);
      updateBreadcrumbs(state.currentNavPath || '');
    } catch (err) {
      if (!background) {
        renderFileListError(el('filesList'), err.message, function () { loadFilesList(); });
      }
    }
  }

  // ------------------------------------------------------- main-area viewer
  var MAX_HIGHLIGHT_CHARS = 200000;

  function fileViewerIsOpen() {
    var viewer = el('fileViewer');
    return !!(viewer && !viewer.classList.contains('is-hidden'));
  }

  function updateCodeGutter(text) {
    var gutter = el('codeGutter');
    if (!gutter) return;
    var lineCount = String(text || '').split('\\n').length;
    if (lineCount > 5000) {
      gutter.textContent = '1\\n\\u22ee\\n' + lineCount;
      return;
    }
    var out = '';
    for (var i = 1; i <= lineCount; i++) out += i + (i < lineCount ? '\\n' : '');
    gutter.textContent = out;
  }

  function renderViewerCode(text, lang) {
    var body = el('fileCodeBody');
    if (!body) return;
    var src = String(text || '');
    if (src.length > MAX_HIGHLIGHT_CHARS) {
      // Huge files stay responsive: plain text, no token pass on every key.
      body.textContent = src;
    } else {
      body.innerHTML = highlightCode(src, lang);
    }
    updateCodeGutter(src);
  }

  function renderViewerDiff(diffText) {
    var body = el('fileCodeBody');
    if (!body) return;
    if (!diffText || diffText.trim() === '') {
      body.innerHTML = '<span class="muted">// No changes</span>';
      updateCodeGutter('// No changes');
      return;
    }
    var lines = diffText.split('\\n');
    body.innerHTML = lines.map(function (line) {
      var escapedLine = escapeHtml(line);
      if (line.charAt(0) === '+' && line.slice(0, 3) !== '+++') return '<span class="code-line-add">' + escapedLine + '</span>';
      if (line.charAt(0) === '-' && line.slice(0, 3) !== '---') return '<span class="code-line-del">' + escapedLine + '</span>';
      if (line.slice(0, 2) === '@@') return '<span class="code-line-hunk">' + escapedLine + '</span>';
      return escapedLine;
    }).join('\\n');
    updateCodeGutter(diffText);
  }

  function setViewerDirty(dirty) {
    state.viewerDirty = dirty;
    var badge = el('fileViewerDirty');
    if (badge) badge.classList.toggle('is-hidden', !dirty);
    var save = el('fileViewerSave');
    if (save) save.classList.toggle('is-hidden', !state.viewerEditing);
    var edit = el('fileViewerEdit');
    if (edit) edit.classList.toggle('is-hidden', state.viewerEditing || state.viewerDiff);
  }

  function syncCodeScroll(source) {
    if (!source) return;
    var highlight = el('codeHighlight');
    var gutter = el('codeGutter');
    if (highlight && highlight !== source) {
      highlight.scrollTop = source.scrollTop;
      highlight.scrollLeft = source.scrollLeft;
    }
    if (gutter) gutter.scrollTop = source.scrollTop;
  }

  function renderEditorTabs() {
    var tabsBar = el('fileTabsBar');
    if (!tabsBar) return;
    if (!state.editorTabs || state.editorTabs.length === 0) {
      tabsBar.innerHTML = '';
      return;
    }
    var html = '';
    state.editorTabs.forEach(function (tab) {
      var isActive = tab.path === state.activeTabPath;
      var parts = String(tab.path).split('/');
      var name = parts[parts.length - 1] || tab.path;
      html += '<div class="file-tab' + (isActive ? ' is-active' : '') + '" data-tab-path="' + escapeHtml(tab.path) + '" title="' + escapeHtml(tab.path) + '" role="tab" aria-selected="' + (isActive ? 'true' : 'false') + '">';
      if (tab.isDirty) {
        html += '<span class="file-tab-dirty" title="Unsaved changes"></span>';
      }
      html += '<span class="file-tab-title">' + escapeHtml(name) + '</span>';
      html += '<button class="file-tab-close" type="button" data-close-tab="' + escapeHtml(tab.path) + '" title="Close tab" aria-label="Close tab">&times;</button>';
      html += '</div>';
    });
    tabsBar.innerHTML = html;

    Array.prototype.forEach.call(tabsBar.querySelectorAll('.file-tab'), function (tabEl) {
      tabEl.addEventListener('click', function () {
        var p = tabEl.getAttribute('data-tab-path');
        if (p && p !== state.activeTabPath) switchEditorTab(p);
      });
    });
    Array.prototype.forEach.call(tabsBar.querySelectorAll('[data-close-tab]'), function (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var p = closeBtn.getAttribute('data-close-tab');
        if (p) closeEditorTab(p);
      });
    });
  }

  function snapshotActiveTab() {
    if (!state.activeTabPath) return;
    var tab = state.editorTabs.find(function (t) { return t.path === state.activeTabPath; });
    if (!tab) return;
    var input = el('fileEditorInput');
    if (input) {
      tab.content = input.value;
      tab.scrollTop = input.scrollTop;
      tab.scrollLeft = input.scrollLeft;
      if (typeof input.selectionStart === 'number') {
        tab.selectionStart = input.selectionStart;
        tab.selectionEnd = input.selectionEnd;
      }
    }
    tab.isDirty = (tab.content !== tab.originalContent);
    tab.editing = state.viewerEditing;
  }

  function switchEditorTab(targetPath, skipSnapshot) {
    if (!skipSnapshot) {
      snapshotActiveTab();
    }
    var tab = state.editorTabs.find(function (t) { return t.path === targetPath; });
    if (!tab) return;

    state.activeTabPath = targetPath;
    state.viewerPath = tab.path;
    state.viewerOriginal = tab.originalContent;
    state.viewerEditing = tab.editing;
    state.viewerDiff = tab.diff;
    state.viewerDirty = tab.isDirty;

    var viewer = el('fileViewer');
    if (viewer) {
      viewer.classList.remove('is-hidden');
      viewer.classList.toggle('is-editing', tab.editing);
    }

    var nameNode = el('fileViewerPath');
    if (nameNode) nameNode.textContent = tab.path;
    var iconNode = el('fileViewerIcon');
    if (iconNode) {
      var parts = String(tab.path).split('/');
      iconNode.innerHTML = getFileIconSvg(parts[parts.length - 1] || tab.path, false, false);
    }
    var langNode = el('fileViewerLang');
    if (langNode) langNode.textContent = tab.lang || 'text';
    var meta = el('fileViewerMeta');
    if (meta) {
      if (tab.diff) {
        meta.textContent = 'Read-only worktree diff';
      } else if (tab.editing) {
        meta.textContent = 'Editing \\u2014 Ctrl+S saves, Esc closes';
      } else {
        meta.textContent = (tab.lang ? tab.lang + ' \\u2014 ' : '') + 'click Edit (or Ctrl+E) to modify';
      }
    }

    var input = el('fileEditorInput');
    if (input) {
      input.value = tab.content;
      input.scrollTop = tab.scrollTop || 0;
      input.scrollLeft = tab.scrollLeft || 0;
      if (tab.editing && typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(tab.selectionStart || 0, tab.selectionEnd || 0);
        } catch (e) {}
      }
    }
    var highlight = el('codeHighlight');
    if (highlight) {
      highlight.scrollTop = tab.scrollTop || 0;
      highlight.scrollLeft = tab.scrollLeft || 0;
    }

    if (tab.diff) renderViewerDiff(tab.content);
    else renderViewerCode(tab.content, tab.lang);

    setViewerDirty(tab.isDirty);
    renderEditorTabs();
    updateBreadcrumbs(tab.path);
  }

  async function closeEditorTab(path, force) {
    var tabIndex = state.editorTabs.findIndex(function (t) { return t.path === path; });
    if (tabIndex === -1) return;
    var tab = state.editorTabs[tabIndex];

    if (path === state.activeTabPath) {
      var input = el('fileEditorInput');
      if (input) {
        tab.content = input.value;
        tab.isDirty = (tab.content !== tab.originalContent);
      }
    }

    if (!force && tab.isDirty) {
      var ok = await plutonConfirm({
        title: 'Discard changes',
        message: 'Discard unsaved changes to ' + path + '?',
        confirmLabel: 'Discard changes',
        danger: true
      });
      if (!ok) return;
    }

    state.editorTabs.splice(tabIndex, 1);

    if (state.editorTabs.length === 0) {
      closeFileViewer(true);
      return;
    }

    if (state.activeTabPath === path) {
      var nextIndex = tabIndex < state.editorTabs.length ? tabIndex : state.editorTabs.length - 1;
      var nextTab = state.editorTabs[nextIndex];
      switchEditorTab(nextTab.path, true);
    } else {
      renderEditorTabs();
    }
  }

  function openFileViewer(path, content, options) {
    options = options || {};
    var viewer = el('fileViewer');
    if (!viewer) return;

    snapshotActiveTab();

    var existingTab = state.editorTabs.find(function (t) { return t.path === path; });
    if (!existingTab) {
      var lang = options.lang || langFromPath(path);
      var newTab = {
        path: path,
        content: String(content || ''),
        originalContent: String(content || ''),
        isDirty: false,
        diff: options.diff === true,
        lang: lang,
        scrollTop: 0,
        scrollLeft: 0,
        selectionStart: 0,
        selectionEnd: 0,
        editing: false
      };
      state.editorTabs.push(newTab);
    } else if (content !== undefined && !existingTab.isDirty) {
      existingTab.content = String(content || '');
      existingTab.originalContent = String(content || '');
      if (options.diff !== undefined) existingTab.diff = options.diff === true;
      if (options.lang) existingTab.lang = options.lang;
    }

    state.activeTabPath = path;
    switchEditorTab(path, true);
  }

  function enterFileEditMode() {
    if (!fileViewerIsOpen() || !state.viewerPath || state.viewerDiff) return;
    state.viewerEditing = true;
    if (state.activeTabPath) {
      var tab = state.editorTabs.find(function (t) { return t.path === state.activeTabPath; });
      if (tab) tab.editing = true;
    }
    var viewer = el('fileViewer');
    if (viewer) viewer.classList.add('is-editing');
    var input = el('fileEditorInput');
    if (input) {
      input.value = state.viewerOriginal;
      input.focus();
      if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, 0);
      // Focusing after assigning a multi-line value parks the caret at the end;
      // reset both panes after focus so editing opens at the top of the file.
      input.scrollTop = 0;
      input.scrollLeft = 0;
    }
    var highlight = el('codeHighlight');
    if (highlight) { highlight.scrollTop = 0; highlight.scrollLeft = 0; }
    setViewerDirty(false);
    var meta = el('fileViewerMeta');
    if (meta) meta.textContent = 'Editing \\u2014 Ctrl+S saves, Esc closes';
    syncCodeScroll(input);
  }

  function onFileEditorInput() {
    var input = el('fileEditorInput');
    if (!input) return;
    var isDirty = input.value !== state.viewerOriginal;
    setViewerDirty(isDirty);
    if (state.activeTabPath) {
      var tab = state.editorTabs.find(function (t) { return t.path === state.activeTabPath; });
      if (tab) {
        tab.content = input.value;
        tab.isDirty = isDirty;
        renderEditorTabs();
      }
    }
    renderViewerCode(input.value, langFromPath(state.viewerPath));
    syncCodeScroll(input);
  }

  async function saveFileContent() {
    if (!state.viewerPath || !state.viewerEditing) return null;
    var input = el('fileEditorInput');
    if (!input) return null;
    var content = input.value;
    if (content === state.viewerOriginal) {
      setViewerDirty(false);
      return null;
    }
    var saveBtn = el('fileViewerSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving\\u2026'; }
    try {
      var url = '/api/files/content?path=' + encodeURIComponent(state.viewerPath);
      if (state.activeSessionId) url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      await apiFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content
      });
      state.viewerOriginal = content;
      setViewerDirty(false);
      if (state.activeTabPath) {
        var tab = state.editorTabs.find(function (t) { return t.path === state.activeTabPath; });
        if (tab) {
          tab.content = content;
          tab.originalContent = content;
          tab.isDirty = false;
          renderEditorTabs();
        }
      }
      var meta = el('fileViewerMeta');
      if (meta) meta.textContent = 'Saved \\u2014 Ctrl+S saves, Esc closes';
      toast('Saved ' + state.viewerPath);
      return true;
    } catch (err) {
      toast('Failed to save ' + state.viewerPath + ': ' + err.message, true);
      return false;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      setViewerDirty(state.viewerDirty);
    }
  }

  async function closeFileViewer(force) {
    if (!force) {
      var dirtyTab = state.editorTabs.find(function (t) { return t.isDirty; });
      if (dirtyTab || state.viewerDirty) {
        var path = (dirtyTab ? dirtyTab.path : state.viewerPath) || 'this file';
        var ok = await plutonConfirm({
          title: 'Discard changes',
          message: 'Discard unsaved changes to ' + path + '?',
          confirmLabel: 'Discard changes',
          danger: true
        });
        if (!ok) return;
      }
    }
    var viewer = el('fileViewer');
    if (viewer) { viewer.classList.add('is-hidden'); viewer.classList.remove('is-editing'); }
    state.editorTabs = [];
    state.activeTabPath = null;
    state.viewerPath = null;
    state.viewerOriginal = '';
    state.viewerEditing = false;
    state.viewerDiff = false;
    state.viewerDirty = false;
    var badge = el('fileViewerDirty');
    if (badge) badge.classList.add('is-hidden');
    var input = el('fileEditorInput');
    if (input) input.value = '';
    var list = el('filesList');
    if (list) Array.prototype.forEach.call(list.querySelectorAll('.file-item'), function (i) { i.classList.remove('is-active'); });
    renderEditorTabs();
  }

  async function openFile(path) {
    try {
      var url = '/api/files/content?path=' + encodeURIComponent(path);
      if (state.activeSessionId) {
        url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      }
      var res = await apiFetch(url);
      openFileViewer(path, res.content || '');
      updateBreadcrumbs(path);
    } catch (err) {
      toast('Failed to read ' + path + ': ' + err.message, true);
    }
  }

  function renderDiffContent(diffText, title) {
    openFileViewer(title || 'Worktree Diff', diffText || '', { diff: true, lang: 'diff' });
    var meta = el('fileViewerMeta');
    if (meta) meta.textContent = 'Read-only worktree diff \\u2014 Esc closes';
  }

  async function loadDiffsTab(runId) {
    var list = el('filesList');
    if (!list) return;
    if (!runId) {
      try {
        var runsRes = await apiFetch('/api/runs');
        var runs = (runsRes && runsRes.runs) || [];
        if (runs.length > 0) {
          runId = runs[0].id;
          state.activeRunId = runId;
        }
      } catch (e) {}
    }
    if (!runId) {
      list.innerHTML = '<div class="empty-hint">Select a run to view worktree diffs.</div>';
      return;
    }
    try {
      var res = await apiFetch('/api/runs/' + encodeURIComponent(runId) + '/diff');
      var diffs = res.diffs || [];
      if (diffs.length === 0) {
        list.innerHTML = '<div class="empty-hint">No worktree modifications recorded for run ' + escapeHtml(runId) + '.</div>';
        renderDiffContent('', 'No worktree diffs');
        return;
      }
      list.innerHTML = diffs.map(function (d, idx) {
        return '<div class="file-row file-item' + (idx === 0 ? ' is-active' : '') + '" data-diff-idx="' + idx + '">' +
          escapeHtml(d.taskTitle || d.taskId || 'Worktree Diff') + '</div>';
      }).join('');
      renderDiffContent(diffs[0].diff || '// Clean worktree (no changes)', diffs[0].taskTitle || diffs[0].taskId || 'Worktree Diff');
      Array.prototype.forEach.call(list.querySelectorAll('.file-item'), function (item) {
        item.addEventListener('click', function () {
          Array.prototype.forEach.call(list.querySelectorAll('.file-item'), function (i) { i.classList.remove('is-active'); });
          item.classList.add('is-active');
          var selected = diffs[Number(item.getAttribute('data-diff-idx'))];
          if (selected) renderDiffContent(selected.diff || '// Clean worktree (no changes)', selected.taskTitle || selected.taskId || 'Worktree Diff');
        });
      });
    } catch (err) {
      list.innerHTML = '<div class="empty-hint">Failed to load diffs: ' + escapeHtml(err.message) + '</div>';
    }
  }

  async function loadTaskDiff(taskId) {
    try {
      var res = await apiFetch('/api/tasks/' + encodeURIComponent(taskId) + '/diff');
      renderDiffContent(res.diff || '// No uncommitted or staged changes in task checkout', 'Task Worktree Diff: ' + taskId);
    } catch (err) {
      toast('Failed to load task diff: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------- composer
  function updateQueueBadge() {
    var badge = el('queueBadge');
    if (!badge) return;
    var q = state.queueLength || 0;
    if (q > 0) {
      badge.textContent = q + ' queued';
      badge.classList.remove('is-hidden');
    } else {
      badge.classList.add('is-hidden');
    }
  }

  var busyFilePollTimer = null;
  function startBusyFilePolling() {
    if (busyFilePollTimer) return;
    busyFilePollTimer = setInterval(function () {
      if (!state.busy) {
        stopBusyFilePolling();
        return;
      }
      loadFilesList(true);
    }, 2000);
  }
  function stopBusyFilePolling() {
    if (busyFilePollTimer) {
      clearInterval(busyFilePollTimer);
      busyFilePollTimer = null;
    }
  }

  function setBusy(busy, busyLabel) {
    state.busy = busy;
    if (busy) {
      startBusyFilePolling();
    } else {
      stopBusyFilePolling();
      scheduleFilesRefresh(true);
      state.queueLength = 0;
    }
    updateQueueBadge();
    var btn = el('btnPrimary');
    var label = el('actionBtnLabel');
    var thinking = el('thinkingStatus');
    var text = el('thinkingText');
    if (btn) btn.classList.toggle('is-busy', busy);
    if (label) label.textContent = busy ? 'Stop' : 'Send';
    if (thinking) {
      thinking.classList.toggle('is-busy', busy);
      thinking.classList.remove('mode-plan', 'mode-build', 'mode-chat');
      thinking.classList.add('mode-' + state.mode);
    }
    if (text) {
      text.textContent = busy
        ? (busyLabel || (state.mode === 'plan' ? 'Planning\\u2026' : (state.mode === 'build' ? 'Building\\u2026' : 'Thinking\\u2026')))
        : 'Ready';
    }
    updateActivityBadge();
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === 'plan' || mode === 'build') {
      state.buildOrPlanMode = mode;
    }
    // Plan/Build live in the modeToggleBtn split control; the standalone
    // plan/build buttons no longer exist in the markup.
    var chat = el('modeChatBtn');
    var toggle = el('modeToggleBtn');
    var toggleLabel = el('modeToggleLabel');
    if (chat) chat.classList.toggle('is-active', mode === 'chat');
    if (toggle) {
      toggle.classList.toggle('is-active', mode === 'plan' || mode === 'build');
      toggle.classList.toggle('is-plan', mode === 'plan');
      toggle.classList.toggle('is-build', mode === 'build');
    }
    if (toggleLabel) {
      toggleLabel.textContent = (mode === 'build') ? 'Build' : (mode === 'plan' ? 'Plan' : (state.buildOrPlanMode === 'build' ? 'Build' : 'Plan'));
    }

    var composer = document.querySelector('.composer');
    if (composer) {
      composer.classList.remove('mode-plan', 'mode-build', 'mode-chat');
      composer.classList.add('mode-' + mode);
    }
    var thinking = el('thinkingStatus');
    if (thinking) {
      thinking.classList.remove('mode-plan', 'mode-build', 'mode-chat');
      thinking.classList.add('mode-' + mode);
    }
    var promptInput = el('promptInput');
    if (promptInput) {
      if (mode === 'plan') {
        promptInput.placeholder = 'Plan mode: formulate architecture, task breakdowns and test criteria\\u2026 (Enter to submit, Shift+Enter for newline)';
      } else if (mode === 'build') {
        promptInput.placeholder = 'Build mode: run supervised multi-agent build with task delegation\\u2026 (Enter to submit, Shift+Enter for newline)';
      } else {
        promptInput.placeholder = 'Ask Pluton to plan, implement, investigate\\u2026 (Enter to submit, Shift+Enter for newline)';
      }
    }
  }

  /**
   * Reconcile the composer with the durable state of the active run.
   *
   * A supervised build has no turn_end frame - it reports through the
   * run_state frames derived from the event log. Without this the composer
   * would stay "Thinking..." forever once the run reached a terminal state,
   * and the Send button would stay a Stop button aimed at a finished run.
   *
   * Reported once per run: the server may broadcast a terminal frame directly
   * AND the log-watcher may emit the same frame a moment later.
   */
  function applyRunState(runState, goal, error, summary) {
    var runId = state.activeRunId;
    if (!runId) return;
    state.activeRunState = runState;
    if (TERMINAL_RUN_STATES[runState]) {
      state.tasks = {};
      updateActivityBadge();
      if (state.settledRunId === runId) return;
      state.settledRunId = runId;
      setBusy(false);
      if (state.mode !== 'build') return;
      var labels = {
        completed: 'completed',
        failed: 'failed',
        cancelled: 'cancelled',
        uncertain: 'ended with an uncertain outcome'
      };
      var cls = runState === 'failed' || runState === 'uncertain' ? 'msg-error' : '';
      var detail = (runState === 'failed' || runState === 'uncertain')
        ? (error || summary || (goal ? 'Goal: ' + goal : ''))
        : (summary || (goal ? 'Goal: ' + goal : ''));
      // Same redaction gate as every other dynamic detail surface (tool cards,
      // result cards, worker stream): terminal run text can quote a
      // settlement or failure reason, so credential-shaped strings are
      // masked before rendering. HTML escaping stays separate downstream.
      detail = redactSecrets(String(detail));
      var msg = 'Build ' + labels[runState] + ' - run ' + runId + (detail ? ': ' + detail : '');
      appendPlain('system', msg, cls);
      return;
    }
    // The run is still live. Say what it is waiting for: a build parked at the
    // verification gate is not "thinking", it is waiting for the operator.
    if (state.mode === 'build' && state.busy) {
      setBusy(true, RUN_STATUS_TEXT[runState] || 'The team is working...');
    }
  }

  function buildPromptText() {
    var text = el('promptInput').value;
    if (state.attachments.length === 0) return text.trim();
    var blocks = state.attachments.map(function (a) {
      return '<file path="' + a.path + '">\\n' + a.content + '\\n</file>';
    });
    return text.trim() + '\\n\\n' + blocks.join('\\n\\n');
  }

  async function submitPrompt() {
    var input = el('promptInput');
    var text = input.value.trim();
    if (!text) return;
    if (state.mode === 'build') {
      if (state.busy) return;
      // Only the first Build asks the operator to establish the project. A
      // known persistent session continues directly; approvals inside the run
      // are unaffected by skipping this panel.
      if (shouldConfirmBuild()) {
        openBuildConfirm(text);
        return;
      }
      await startBuild(text);
      return;
    }
    if (!state.activeSessionId) {
      toast('No active session.', true);
      return;
    }
    var full = buildPromptText();
    var attached = state.attachments.map(function (a) {
      return a.name + ' (' + a.sizeLabel + ')';
    }).join(', ');
    var wasBusy = state.busy;
    if (!wasBusy) setBusy(true);
    try {
      var url = new URL('/api/sessions/' + encodeURIComponent(state.activeSessionId) + '/prompt', window.location.origin);
      if (token) url.searchParams.set('token', token);
      var res = await fetch(url.toString(), {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, apiHeaders()),
        body: JSON.stringify({ text: full, mode: state.mode })
      });
      if (res.status === 202) {
        input.value = '';
        input.style.height = 'auto';
        clearAttachments();
        var payload = null;
        try { payload = await res.json(); } catch (e) {}
        if (payload && payload.status === 'enqueued') {
          state.queueLength = (state.queueLength || 0) + 1;
          updateQueueBadge();
          appendPlain('user', text + (attached ? '\\n\\n*Attached: ' + attached + '*' : ''), 'is-queued');
          toast('Prompt enqueued in session inbox');
        } else {
          appendPlain('user', text + (attached ? '\\n\\n*Attached: ' + attached + '*' : ''));
        }
      } else {
        var errPayload = null;
        try { errPayload = await res.json(); } catch (e) {}
        throw new Error(errPayload && errPayload.error ? errPayload.error : ('Prompt failed with status ' + res.status));
      }
    } catch (err) {
      appendPlain('system', '[Error dispatching prompt: ' + err.message + ']', 'msg-error');
      if (!wasBusy) setBusy(false);
    }
  }

  /**
   * Show the supervised-build confirmation.
   *
   * Only the FIRST build in a project opens this panel: it is where the
   * operator establishes the persistent workspace and display name. Later
   * builds reuse that session and dispatch directly.
   */
  function currentProjectSession() {
    var ws = state.workspace || {};
    return ws.projectSession || null;
  }

  function shouldConfirmBuild() {
    var session = currentProjectSession();
    return !session || !(session.buildCount > 0);
  }

  function renderProjectIdentity() {
    var ws = state.workspace || {};
    var nameInput = el('projectNameInput');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = ws.name || '';
    var meta = el('projectIdentityMeta');
    if (meta) {
      var session = ws.projectSession;
      meta.textContent = session
        ? ('Build #' + session.buildCount + ' · ' + (session.workspaceRoot || ws.rootDir || ''))
        : 'No Build session yet — the first Build establishes this workspace.';
    }
  }

  function openBuildConfirm(goal) {
    if (state.buildConfirmOpen || state.buildDispatching) return;
    var panel = el('buildConfirm');
    if (!panel) return;
    var wsNode = el('buildConfirmWorkspace');
    var goalNode = el('buildConfirmGoal');
    var ws = state.workspace || {};
    if (wsNode) wsNode.textContent = ws.rootDir || (ws.name ? ws.name : 'unknown workspace');
    if (goalNode) goalNode.textContent = goal;
    var nameInput = el('buildConfirmProjectName');
    if (nameInput) {
      nameInput.value = ws.name || '';
      nameInput.readOnly = false;
    }
    state.pendingBuildGoal = goal;
    panel.classList.remove('is-hidden');
    state.buildConfirmOpen = true;
    var start = el('btnBuildConfirmStart');
    if (nameInput) nameInput.focus();
    else if (start) start.focus();
  }

  function closeBuildConfirm(restoreFocus) {
    var panel = el('buildConfirm');
    if (panel) panel.classList.add('is-hidden');
    state.buildConfirmOpen = false;
    state.pendingBuildGoal = null;
    if (restoreFocus) {
      var input = el('promptInput');
      if (input) input.focus();
    }
  }

  async function startBuild(goal, projectName) {
    state.buildDispatching = true;
    setBusy(true);
    try {
      var res = await apiFetch('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          goal: goal,
          sessionId: state.activeSessionId || undefined,
          projectName: projectName || undefined
        })
      });
      var input = el('promptInput');
      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      clearAttachments();
      appendPlain('user', goal);
      var runId = res.run.id;
      state.activeRunId = runId;
      state.settledRunId = null;
      if (res.projectSession) {
        state.workspace = state.workspace || {};
        state.workspace.projectSession = res.projectSession;
        if (res.run.workspaceRoot) state.workspace.rootDir = res.run.workspaceRoot;
        renderProjectIdentity();
      }
      appendPlain('system', 'Build started \\u2014 run ' + runId + ' (' + res.run.state + '). The manager agent plans and delegates to the team.');
      await apiFetch('/api/runs/' + encodeURIComponent(runId) + '/start', {
        method: 'POST',
        body: '{}'
      });
    } catch (err) {
      appendPlain('system', '[Build failed: ' + err.message + ']', 'msg-error');
      setBusy(false);
    } finally {
      state.buildDispatching = false;
    }
  }

  async function handlePrimaryAction() {
    if (!state.busy) {
      await submitPrompt();
      return;
    }
    try {
      if (state.mode === 'build' && state.activeRunId) {
        var runRes = await apiFetch('/api/runs/' + encodeURIComponent(state.activeRunId) + '/cancel', {
          method: 'POST',
          body: '{}'
        });
        if (runRes.cancelled) {
          toast('Run cancellation requested');
        } else {
          // The run was already over: settle the composer now instead of
          // waiting for a terminal frame that will never arrive.
          toast('The run was already finished');
          setBusy(false);
        }
      } else if (state.activeSessionId) {
        var res = await apiFetch('/api/sessions/' + encodeURIComponent(state.activeSessionId) + '/cancel', {
          method: 'POST',
          body: '{}'
        });
        toast(res.cancelled ? 'Turn cancelled' : 'Nothing was running');
        setBusy(false);
      } else {
        setBusy(false);
      }
    } catch (err) {
      setBusy(false);
      updateActivityBadge();
      toast('Turn cancelled (reset)');
    }
  }

  // ---------------------------------------------------------- attachments
  function renderAttachments() {
    var tray = el('attachmentPreviewContainer');
    if (!tray) return;
    if (state.attachments.length === 0) {
      tray.classList.add('is-hidden');
      tray.innerHTML = '';
      return;
    }
    tray.classList.remove('is-hidden');
    tray.innerHTML = state.attachments.map(function (a, idx) {
      return '<span class="attach-chip"><span>' + escapeHtml(a.name) + '</span>' +
        '<span class="attach-size">' + escapeHtml(a.sizeLabel) + '</span>' +
        '<button type="button" data-remove-attach="' + idx + '" aria-label="Remove attachment">\\u00d7</button></span>';
    }).join('');
    Array.prototype.forEach.call(tray.querySelectorAll('[data-remove-attach]'), function (b) {
      b.addEventListener('click', function () {
        state.attachments.splice(Number(b.getAttribute('data-remove-attach')), 1);
        renderAttachments();
      });
    });
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  async function openAttachModal() {
    var modal = el('attachModal');
    var list = el('attachFileList');
    if (modal) modal.classList.remove('is-hidden');
    if (!list) return;
    list.innerHTML = '<div class="empty-hint">Loading workspace files\\u2026</div>';
    try {
      var url = state.activeSessionId
        ? ('/api/files?sessionId=' + encodeURIComponent(state.activeSessionId))
        : '/api/files';
      var res = await apiFetch(url);
      var files = res.files || [];
      if (files.length === 0) {
        list.innerHTML = '<div class="empty-hint">The workspace has no readable files.</div>';
        return;
      }
      list.innerHTML = files.map(function (f) {
        var attached = state.attachments.some(function (a) { return a.path === f; });
        return '<div class="attach-row' + (attached ? ' is-attached' : '') + '" data-attach-path="' + escapeHtml(f) + '">' +
          '<span class="attach-row-path">' + escapeHtml(f) + '</span>' +
          '<span>' + (attached ? 'attached' : 'attach') + '</span></div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('[data-attach-path]'), function (row) {
        row.addEventListener('click', function () { attachFile(row.getAttribute('data-attach-path')); });
      });
    } catch (err) {
      renderFileListError(list, err.message, function () { openAttachModal(); });
    }
  }

  function closeAttachModal() {
    var modal = el('attachModal');
    if (modal) modal.classList.add('is-hidden');
    var attach = el('btnAttach');
    if (attach) attach.focus();
  }

  async function attachFile(path) {
    if (state.attachments.some(function (a) { return a.path === path; })) return;
    try {
      var url = '/api/files/content?path=' + encodeURIComponent(path);
      if (state.activeSessionId) {
        url += '&sessionId=' + encodeURIComponent(state.activeSessionId);
      }
      var res = await apiFetch(url);
      var content = res.content || '';
      var truncated = false;
      if (content.length > MAX_ATTACH_CHARS) {
        content = content.slice(0, MAX_ATTACH_CHARS);
        truncated = true;
      }
      // The aggregate bound is enforced HERE, at the point where the file is
      // added. Without it the assembled prompt grows without limit, crosses
      // the server's request-body bound, and the operator gets a broken
      // response instead of a clear message.
      var attachedChars = state.attachments.reduce(function (sum, a) { return sum + a.content.length; }, 0);
      if (attachedChars + content.length > MAX_TOTAL_ATTACH_CHARS) {
        toast('Attachment limit reached: ' + Math.round(MAX_TOTAL_ATTACH_CHARS / 1000) + ' kB total. Remove an attachment first.', true);
        return;
      }
      var nameParts = path.split('/');
      state.attachments.push({
        path: path,
        name: nameParts[nameParts.length - 1] || path,
        content: content,
        sizeLabel: formatBytes(res.size) + (truncated ? ' (truncated)' : '')
      });
      renderAttachments();
      openAttachModal();
    } catch (err) {
      toast('Failed to attach ' + path + ': ' + err.message, true);
    }
  }

  // ------------------------------------------------------------- activity
  function updateActivityBadge() {
    var badge = el('shipActivityBadgeContainer');
    if (!badge) return;
    var working = (state.mode === 'build' && state.activeRunId)
      ? Object.keys(state.tasks).filter(function (id) {
          var t = state.tasks[id];
          if (state.activeRunState && TERMINAL_RUN_STATES[state.activeRunState]) return false;
          return t.state === 'running' || t.state === 'needs_approval' || t.state === 'needs_input' || t.state === 'verifying';
        })
      : [];
    var isWorking = working.length > 0 || state.busy || state.streaming;
    if (!isWorking) {
      badge.classList.add('is-hidden');
      return;
    }
    badge.classList.remove('is-hidden');
    var text = el('shipCountText');
    // Never invent a head-count: when the manager is still planning there are
    // zero workers, and the badge says so instead of showing a placeholder 3.
    if (text) {
      text.textContent = working.length > 0
        ? working.length + ' Ship' + (working.length > 1 ? 's' : '') + ' working'
        : (state.mode === 'build' ? 'Team preparing\u2026' : 'Working\u2026');
    }
    var tip = el('shipActivityTooltip');
    if (tip) {
      tip.innerHTML = '<div style="font-weight:600;color:#fff;border-bottom:1px solid var(--border-soft);padding-bottom:3px;">Active Ship Tasks</div>' +
        (working.length > 0
          ? working.map(function (id) { return '<div>\u2693 ' + escapeHtml(state.tasks[id].title || id) + '</div>'; }).join('')
          : '<div>\u2693 ' + (state.mode === 'build' ? 'Team orchestration in progress\u2026' : 'Prompt turn execution in progress\u2026') + '</div>');
    }
  }

  // -------------------------------------------------- right-side inspector
  function toggleRightInspector(force) {
    var insp = el('rightInspector');
    if (!insp) return;
    var show = force === undefined ? insp.classList.contains('is-hidden') : force;
    state.rightInspectorOpen = show;
    insp.classList.toggle('is-hidden', !show);
    if (show) {
      updateInspectorPartitionsLayout();
      reconstituteWorkerPartitions();
    }
  }

  function sanitizeId(str) {
    return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  // Authoritative active task states: exactly the states in which a worker is
  // running, admitted with a live session, or waiting on the operator/children
  // (not finished). Anything terminal or merely queued stays out of the
  // inspector; history is retained in state.workers for the detail view.
  var ACTIVE_WORKER_STATES = {
    admitted: 1,
    running: 1,
    waiting_for_children: 1,
    needs_approval: 1,
    needs_input: 1,
    verifying: 1
  };

  function isActiveWorkerState(status) {
    return !!ACTIVE_WORKER_STATES[status];
  }

  function updateWorkerEmptyState() {
    var grid = el('rightInspectorGrid');
    if (!grid) return;
    var partitions = grid.querySelectorAll('.worker-partition');
    var empty = grid.querySelector('.worker-empty');
    if (partitions.length === 0) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'worker-empty';
        empty.innerHTML = '<div class="worker-empty-title">No active workers</div>' +
          '<div class="worker-empty-hint">Worker activity appears here while a task is running.</div>';
        grid.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  }

  function updateInspectorPartitionsLayout() {
    var grid = el('rightInspectorGrid');
    if (!grid) return;
    var partitions = grid.querySelectorAll('.worker-partition');
    var count = partitions.length;
    var countBadge = el('rightInspectorCount');
    if (countBadge) {
      countBadge.textContent = count + ' active worker' + (count === 1 ? '' : 's');
    }
    if (count > 4) {
      grid.classList.add('has-many-workers');
    } else {
      grid.classList.remove('has-many-workers');
    }
    updateWorkerEmptyState();
  }

  /** Create, update, or remove the one partition for a worker from its state. */
  function syncWorkerPartition(worker) {
    var grid = el('rightInspectorGrid');
    if (!grid || !worker || !worker.taskId) return;
    var partitionId = 'worker-partition-' + sanitizeId(worker.taskId);
    var partition = document.getElementById(partitionId);
    if (!isActiveWorkerState(worker.status)) {
      if (partition) partition.remove();
      return;
    }
    if (!partition) {
      partition = createWorkerPartitionElement(worker);
      grid.appendChild(partition);
      if (worker.logs && worker.logs.length > 0) {
        worker.logs.forEach(function (log) {
          appendWorkerStreamEntry(partition, log.text, log.cls);
        });
      }
    } else {
      updateWorkerPartitionElement(partition, worker);
    }
  }

  function createWorkerPartitionElement(worker) {
    var partitionId = 'worker-partition-' + sanitizeId(worker.taskId);
    var partition = document.createElement('div');
    partition.id = partitionId;
    partition.className = 'worker-partition';
    partition.setAttribute('data-task-id', worker.taskId);

    var head = document.createElement('div');
    head.className = 'worker-partition-head';
    // The header is the accessible control; the whole card is also clickable.
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-label', 'Open details for ' + (worker.shipName || worker.role || 'worker'));

    var title = document.createElement('div');
    title.className = 'worker-partition-title';
    // One primary identity: the configured Ship display name (role is only a
    // fallback when no display name was captured). Never both.
    title.innerHTML = '<span class="worker-partition-name" title="' + escapeHtml(worker.shipName || worker.role || 'worker') + '">' + escapeHtml(worker.shipName || worker.role || 'worker') + '</span>' +
      ' <span class="worker-partition-task" title="' + escapeHtml(worker.taskId) + '">' + escapeHtml(worker.taskId) + '</span>' +
      (worker.model ? ' <span class="tag-mono worker-partition-model" title="' + escapeHtml(worker.model) + '">' + escapeHtml(worker.model) + '</span>' : '');

    var statusWrap = document.createElement('div');
    statusWrap.className = 'worker-partition-meta';
    statusWrap.innerHTML = '<span class="worker-badge-status is-' + escapeHtml(worker.status || 'active') + '">' + escapeHtml(worker.status || 'active') + '</span>';

    head.appendChild(title);
    head.appendChild(statusWrap);

    var workspaceLine = null;
    if (worker.workspace) {
      workspaceLine = document.createElement('div');
      workspaceLine.className = 'mono worker-partition-workspace-line';
      workspaceLine.textContent = worker.workspace;
      workspaceLine.title = worker.workspace;
    }

    var stream = document.createElement('div');
    stream.className = 'worker-stream';

    partition.appendChild(head);
    if (workspaceLine) partition.appendChild(workspaceLine);
    partition.appendChild(stream);
    return partition;
  }

  function updateWorkerPartitionElement(partition, worker) {
    if (!partition || !worker) return;
    var nameBadge = partition.querySelector('.worker-partition-name');
    if (nameBadge && (worker.shipName || worker.role)) {
      nameBadge.textContent = worker.shipName || worker.role;
      nameBadge.title = worker.shipName || worker.role;
    }
    var statusBadge = partition.querySelector('.worker-badge-status');
    if (statusBadge) {
      statusBadge.className = 'worker-badge-status is-' + escapeHtml(worker.status || 'active');
      statusBadge.textContent = worker.status || 'active';
    }
    var title = partition.querySelector('.worker-partition-title');
    if (!title) return;
    if (worker.model) {
      var modelSpan = title.querySelector('.worker-partition-model');
      if (!modelSpan) {
        modelSpan = document.createElement('span');
        modelSpan.className = 'tag-mono worker-partition-model';
        title.appendChild(modelSpan);
      }
      modelSpan.textContent = worker.model;
      modelSpan.title = worker.model;
    }
    if (worker.workspace) {
      var wsLine = partition.querySelector('.worker-partition-workspace-line');
      if (!wsLine) {
        wsLine = document.createElement('div');
        wsLine.className = 'mono worker-partition-workspace-line';
        var streamEl = partition.querySelector('.worker-stream');
        if (streamEl) partition.insertBefore(wsLine, streamEl);
        else partition.appendChild(wsLine);
      }
      wsLine.textContent = worker.workspace;
      wsLine.title = worker.workspace;
    }
  }

  function appendWorkerStreamEntry(partition, text, entryClass) {
    if (!partition || !text) return;
    var stream = partition.querySelector('.worker-stream');
    if (!stream) return;
    var atBottom = (stream.scrollHeight - stream.scrollTop - stream.clientHeight) <= 30;

    var entry = document.createElement('div');
    entry.className = 'worker-stream-entry' + (entryClass ? ' ' + entryClass : '');
    entry.textContent = text;
    stream.appendChild(entry);

    // Bounded live stream (mirrors the transcript trim): drop the oldest
    // entries only while the operator watches live (atBottom before the append);
    // scrolled-up reading pauses the trim instead of losing position.
    while (stream.childElementCount > MAX_WORKER_STREAM_ENTRIES && atBottom) {
      stream.removeChild(stream.firstElementChild);
    }

    if (atBottom) {
      stream.scrollTop = stream.scrollHeight;
    }
  }

  function handleWorkerEvent(ev) {
    if (!ev || !ev.taskId) return;
    var worker = state.workers[ev.taskId];
    if (!worker) {
      worker = {
        taskId: ev.taskId,
        role: ev.role || 'worker',
        shipName: ev.shipName || '',
        model: ev.model || '',
        workspace: ev.workspace || '',
        status: 'active',
        logs: []
      };
      state.workers[ev.taskId] = worker;
    }
    if (ev.role) worker.role = ev.role;
    if (ev.shipName) worker.shipName = ev.shipName;
    if (ev.model) worker.model = ev.model;
    if (ev.workspace) worker.workspace = ev.workspace;

    // Activity-only messages never change a worker's lifecycle status.
    if (ev.type === 'worker.started' || ev.type === 'worker.progress') {
      worker.status = 'running';
      scheduleFilesRefresh();
    } else if (ev.type === 'worker.question' || ev.type === 'worker.waiting') {
      worker.status = 'waiting';
    } else if (ev.type === 'worker.completed') {
      worker.status = 'completed';
      scheduleFilesRefresh();
    } else if (ev.type === 'worker.failed') {
      worker.status = 'failed';
      scheduleFilesRefresh();
    } else if (ev.type === 'worker.cancelled') {
      worker.status = 'cancelled';
      scheduleFilesRefresh();
    } else if (ev.type === 'worker.created') {
      worker.status = 'created';
    }

    // Authoritative filter: the card exists only while the worker is active.
    // A terminal event removes it from the inspector, never from state.workers.
    syncWorkerPartition(worker);
    updateInspectorPartitionsLayout();
    if (state.workerDetail && state.workerDetail.taskId === ev.taskId) {
      scheduleWorkerDetailRefresh();
    }

    var entryText = '';
    var entryClass = '';
    if (ev.payload) {
      if (ev.type === 'worker.message' && typeof ev.payload.body === 'string') {
        var senderLabel = typeof ev.payload.senderLabel === 'string' ? ev.payload.senderLabel : 'worker';
        var recipientLabel = typeof ev.payload.recipientLabel === 'string' ? ev.payload.recipientLabel : 'worker';
        var messageKind = typeof ev.payload.kind === 'string' ? ev.payload.kind : 'message';
        entryText = '\u2192 ' + senderLabel + ' \u2192 ' + recipientLabel + ' (' + messageKind + '): ' + ev.payload.body;
        entryClass = 'is-message';
      } else if (typeof ev.payload.token === 'string') {
        entryText = ev.payload.token;
        entryClass = 'is-token';
      } else if (typeof ev.payload.step === 'string') {
        entryText = '\u203a ' + ev.payload.step;
      } else if (typeof ev.payload.text === 'string') {
        entryText = ev.payload.text;
      } else if (typeof ev.payload.summary === 'string') {
        entryText = '\u2714 ' + ev.payload.summary;
      } else if (typeof ev.payload.error === 'string') {
        entryText = '\u2716 ' + ev.payload.error;
        entryClass = 'is-err';
      } else if (typeof ev.payload.question === 'string') {
        entryText = '? ' + ev.payload.question;
      } else {
        var keys = Object.keys(ev.payload);
        if (keys.length > 0) {
          entryText = JSON.stringify(ev.payload);
        }
      }
    }
    if (!entryText) {
      entryText = '[' + ev.type.replace('worker.', '') + ']';
    }
    entryText = redactSecrets(entryText);

    // Bounded retained log state: the per-task log keeps the newest entries
    // only (the durable event log is the complete record). Without this a
    // chatty long task grows the session's memory + every partition re-render
    // without bound.
    worker.logs.push({ text: entryText, cls: entryClass, timestamp: ev.timestamp || Date.now() });
    if (worker.logs.length > MAX_WORKER_STREAM_ENTRIES) {
      worker.logs.shift();
    }
    var partition = document.getElementById('worker-partition-' + sanitizeId(ev.taskId));
    if (partition) {
      appendWorkerStreamEntry(partition, entryText, entryClass);
    }
    updateActivityBadge();
  }

  function reconstituteWorkerPartitions(tasksList) {
    var tasks = tasksList || (state.tasks ? Object.values(state.tasks) : []);
    var grid = el('rightInspectorGrid');
    if (!grid) return;

    // Tasks are authoritative for assignment/state; live worker events refine
    // them afterwards (a just-started worker may still look queued here).
    if (Array.isArray(tasks) && tasks.length > 0) {
      tasks.forEach(function (t) {
        if (!t || !t.id) return;
        var worker = state.workers[t.id];
        if (!worker) {
          worker = {
            taskId: t.id,
            role: t.role || 'worker',
            shipName: t.shipDisplayName || '',
            model: t.model || '',
            workspace: t.workspace || '',
            status: t.state || 'active',
            logs: []
          };
          state.workers[t.id] = worker;
        } else {
          if (t.state) worker.status = t.state;
          if (!worker.role && t.role) worker.role = t.role;
          if (!worker.shipName && t.shipDisplayName) worker.shipName = t.shipDisplayName;
          if (!worker.model && t.model) worker.model = t.model;
          if (!worker.workspace && t.workspace) worker.workspace = t.workspace;
        }
      });
    }

    Object.keys(state.workers).forEach(function (id) {
      syncWorkerPartition(state.workers[id]);
    });

    // A partition may outlive its worker record (run switch, pruned history):
    // remove anything that is not an active, still-known worker.
    Array.prototype.forEach.call(grid.querySelectorAll('.worker-partition'), function (partition) {
      var taskId = partition.getAttribute('data-task-id');
      var worker = taskId ? state.workers[taskId] : null;
      if (!worker || !isActiveWorkerState(worker.status)) partition.remove();
    });

    updateInspectorPartitionsLayout();
  }

  // ------------------------------------------------------ worker detail view
  // A read-only, authoritative view of one task. Closing it is a view
  // operation: it never cancels the worker and never deletes its output.

  function workerDetailIsOpen() {
    var modal = el('workerDetailModal');
    return !!(modal && !modal.classList.contains('is-hidden'));
  }

  function openWorkerDetail(taskId) {
    if (!taskId || !state.activeRunId) return;
    var modal = el('workerDetailModal');
    if (!modal) return;
    state.workerDetail = {
      runId: state.activeRunId,
      taskId: taskId,
      detail: null,
      timer: null,
      fetching: false,
      pending: false
    };
    modal.classList.remove('is-hidden');
    var body = el('workerDetailBody');
    if (body) body.innerHTML = '<div class="wd-empty">Loading worker detail…</div>';
    var title = el('workerDetailTitle');
    var worker = state.workers[taskId];
    if (title) title.textContent = (worker && (worker.shipName || worker.role)) || 'Worker detail';
    var status = el('workerDetailStatus');
    if (status) {
      status.className = 'worker-badge-status';
      status.textContent = (worker && worker.status) || 'loading';
    }
    var input = el('workerDetailMessageInput');
    if (input) {
      input.value = '';
      input.disabled = true;
    }
    var send = el('workerDetailSend');
    if (send) send.disabled = true;
    var hint = el('workerDetailHint');
    if (hint) hint.textContent = 'Loading worker state…';
    loadWorkerDetail();
  }

  function closeWorkerDetail() {
    var modal = el('workerDetailModal');
    if (modal) modal.classList.add('is-hidden');
    if (state.workerDetail && state.workerDetail.timer) {
      clearTimeout(state.workerDetail.timer);
    }
    state.workerDetail = null;
    var input = el('workerDetailMessageInput');
    if (input) input.value = '';
    var send = el('workerDetailSend');
    if (send) send.disabled = true;
  }

  async function loadWorkerDetail() {
    var ctx = state.workerDetail;
    if (!ctx) return;
    if (ctx.fetching) {
      ctx.pending = true;
      return;
    }
    ctx.fetching = true;
    try {
      var res = await apiFetch(
        '/api/runs/' + encodeURIComponent(ctx.runId) +
        '/tasks/' + encodeURIComponent(ctx.taskId) + '/detail'
      );
      if (!state.workerDetail || state.workerDetail.taskId !== ctx.taskId) return;
      state.workerDetail.detail = res.detail;
      renderWorkerDetail(res.detail);
    } catch (err) {
      if (state.workerDetail && state.workerDetail.taskId === ctx.taskId) {
        var body = el('workerDetailBody');
        if (body) {
          body.innerHTML = '<div class="wd-empty wd-error">' +
            escapeHtml(redactSecrets(err && err.message ? err.message : 'Failed to load worker detail')) +
            '</div>';
        }
      }
    } finally {
      ctx.fetching = false;
      if (state.workerDetail === ctx && ctx.pending) {
        ctx.pending = false;
        scheduleWorkerDetailRefresh();
      }
    }
  }

  function scheduleWorkerDetailRefresh(delay) {
    var ctx = state.workerDetail;
    if (!ctx || ctx.timer) return;
    ctx.timer = setTimeout(function () {
      if (!state.workerDetail || state.workerDetail !== ctx) return;
      ctx.timer = null;
      loadWorkerDetail();
    }, delay === undefined ? 400 : delay);
  }

  function wdText(value) {
    return escapeHtml(redactSecrets(String(value === null || value === undefined ? '' : value)));
  }

  function wdEmpty(text) {
    return '<div class="wd-empty">' + escapeHtml(text) + '</div>';
  }

  function wdSection(title, html) {
    return '<section class="wd-section"><div class="wd-section-title">' + escapeHtml(title) + '</div>' + html + '</section>';
  }

  function wdKv(label, value) {
    var shown = value === null || value === undefined || value === ''
      ? '<span class="wd-muted">not recorded</span>'
      : wdText(value);
    return '<div class="wd-kv"><span class="wd-kv-label">' + escapeHtml(label) + '</span>' +
      '<span class="wd-kv-value">' + shown + '</span></div>';
  }

  function wdList(items) {
    if (!items || items.length === 0) return wdEmpty('None recorded.');
    return '<ul class="wd-list">' + items.map(function (item) {
      return '<li>' + wdText(item) + '</li>';
    }).join('') + '</ul>';
  }

  function wdActivity(items) {
    if (!items || items.length === 0) return wdEmpty('No progress recorded yet.');
    return '<div class="wd-activity">' + items.map(function (item) {
      return '<div class="wd-activity-row tone-' + escapeHtml(item.tone || 'info') + '">' +
        '<span class="wd-activity-time">' + escapeHtml(formatTime(item.at)) + '</span>' +
        '<span class="wd-activity-actor">' + wdText(item.actorLabel || item.actor || 'Pluton') + '</span>' +
        '<span class="wd-activity-text">' + wdText(item.text) + '</span>' +
        (item.detail ? '<div class="wd-activity-detail">' + wdText(item.detail) + '</div>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function wdMessages(messages) {
    if (!messages || messages.length === 0) return wdEmpty('No messages exchanged.');
    return '<div class="wd-messages">' + messages.map(function (message) {
      var direction = message.direction === 'in' ? 'received' : 'sent';
      return '<div class="wd-message is-' + escapeHtml(message.direction) + '">' +
        '<div class="wd-message-head">' +
        '<span class="wd-message-dir">' + direction + '</span>' +
        '<span class="wd-message-from">' + wdText(message.senderLabel) + '</span>' +
        '<span class="wd-message-arrow">→</span>' +
        '<span class="wd-message-to">' + wdText(message.recipientLabel) + '</span>' +
        '<span class="wd-message-kind">' + wdText(message.kind) + '</span>' +
        '<span class="wd-message-time">' + escapeHtml(formatTime(message.createdAt)) + '</span>' +
        '</div>' +
        '<div class="wd-message-body">' + wdText(message.body) + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function wdToolCalls(calls) {
    if (!calls || calls.length === 0) return wdEmpty('No tool calls recorded.');
    return '<ol class="wd-tool-list">' + calls.map(function (call) {
      return '<li class="wd-tool' + (call.isError ? ' is-error' : '') + '">' +
        '<span class="wd-tool-time">' + escapeHtml(formatTime(call.at)) + '</span>' +
        '<span class="wd-tool-step">' + wdText(call.step) + '</span>' +
        '</li>';
    }).join('') + '</ol>';
  }

  function wdFiles(files) {
    var changed = (files && files.changed) || [];
    var untracked = (files && files.untracked) || [];
    if (changed.length === 0 && untracked.length === 0) {
      return wdEmpty('No changed files recorded in the task checkout.');
    }
    var html = '';
    if (changed.length > 0) {
      html += '<div class="wd-file-group-title">Modified</div><ul class="wd-file-list">' +
        changed.map(function (path) { return '<li class="mono">' + wdText(path) + '</li>'; }).join('') +
        '</ul>';
    }
    if (untracked.length > 0) {
      html += '<div class="wd-file-group-title">Untracked</div><ul class="wd-file-list">' +
        untracked.map(function (path) { return '<li class="mono">' + wdText(path) + '</li>'; }).join('') +
        '</ul>';
    }
    if (files && files.truncated) html += '<div class="wd-muted">File list truncated.</div>';
    return html;
  }

  function wdVerification(verification) {
    if (!verification) return wdEmpty('No verification recorded for this task.');
    var verdict = verification.verdict || 'pending';
    var html = '<div class="wd-kv"><span class="wd-kv-label">Verdict</span>' +
      '<span class="wd-verdict is-' + escapeHtml(verdict) + '">' + escapeHtml(verdict) + '</span></div>';
    var checks = verification.checks || [];
    if (checks.length === 0) {
      html += wdEmpty('No verification checks ran.');
    } else {
      html += '<ul class="wd-check-list">' + checks.map(function (check) {
        return '<li class="wd-check is-' + escapeHtml(check.status) + '">' +
          '<span class="wd-check-name">' + wdText(check.name) + '</span>' +
          '<span class="wd-check-status">' + escapeHtml(check.status) + '</span>' +
          (check.exitCode === null || check.exitCode === undefined ? '' : '<span class="wd-check-meta">exit ' + escapeHtml(check.exitCode) + '</span>') +
          (check.durationMs === null || check.durationMs === undefined ? '' : '<span class="wd-check-meta">' + escapeHtml(Math.round(check.durationMs)) + ' ms</span>') +
          '<span class="wd-check-meta">attempt ' + escapeHtml(check.attempt) + '</span>' +
          '</li>';
      }).join('') + '</ul>';
    }
    return html;
  }

  function wdFinalOutput(result, failure) {
    if (failure) {
      var failureText = typeof failure === 'object'
        ? (failure.message || failure.error || JSON.stringify(failure, null, 2))
        : String(failure);
      return '<pre class="wd-pre is-error">' + wdText(String(failureText).slice(0, 20000)) + '</pre>';
    }
    if (!result) return wdEmpty('No final output recorded yet.');
    var parts = [];
    if (typeof result === 'object') {
      if (result.summary) parts.push(String(result.summary));
      if (result.text) parts.push(String(result.text));
      if (parts.length === 0) parts.push(JSON.stringify(result, null, 2));
    } else {
      parts.push(String(result));
    }
    return '<pre class="wd-pre">' + wdText(parts.join('\\n\\n').slice(0, 20000)) + '</pre>';
  }

  function renderWorkerDetail(detail) {
    if (!detail || !detail.task) return;
    var task = detail.task;
    var title = el('workerDetailTitle');
    if (title) {
      title.textContent = (task.assigneeName || task.assigneeShipId || 'Worker') + ' · ' + (task.title || task.id);
    }
    var status = el('workerDetailStatus');
    if (status) {
      status.className = 'worker-badge-status is-' + escapeHtml(task.state || 'unknown');
      status.textContent = task.state || 'unknown';
    }

    var meta = '<div class="wd-meta-grid">' +
      wdKv('Task', task.id) +
      wdKv('Run state', detail.runState) +
      wdKv('Assignee', task.assigneeName || task.assigneeShipId) +
      wdKv('Role', task.role) +
      wdKv('Engine', task.engine) +
      wdKv('Model', task.model) +
      wdKv('Attempt', task.attempt === undefined ? null : String(task.attempt)) +
      wdKv('Workspace', task.workspacePath || task.workspaceId) +
      wdKv('Created', task.createdAt) +
      wdKv('Started', task.startedAt) +
      wdKv('Completed', task.completedAt) +
      '</div>';

    var retries = detail.retries || {};
    var retryHtml = '<div class="wd-meta-grid">' +
      wdKv('Attempts', String(retries.attempts === undefined ? 0 : retries.attempts)) +
      wdKv('Retries scheduled', String(retries.retryScheduled === undefined ? 0 : retries.retryScheduled)) +
      wdKv('Revisions', String(retries.revisions === undefined ? 0 : retries.revisions)) +
      wdKv('Lease blockers', String(retries.leaseBlockers === undefined ? 0 : retries.leaseBlockers)) +
      '</div>';

    var html = meta +
      wdSection('Task brief', task.brief ? '<div class="wd-prose">' + wdText(task.brief) + '</div>' : wdEmpty('No brief recorded.')) +
      wdSection('Acceptance criteria', wdList(detail.acceptanceCriteria)) +
      wdSection('Depends on', wdList(task.dependsOn)) +
      wdSection('Write scope', wdList(task.writeScope)) +
      wdSection('Progress', wdActivity(detail.activity)) +
      wdSection('Supervisor communication', wdActivity(detail.supervisorActivity)) +
      wdSection('Tool calls', wdToolCalls(detail.toolCalls)) +
      wdSection('Changed files', wdFiles(detail.files)) +
      wdSection('Messages', wdMessages(detail.messages)) +
      wdSection('Errors, retries, and blockers', retryHtml) +
      wdSection('Verification', wdVerification(detail.verification)) +
      wdSection('Final output', wdFinalOutput(detail.result, detail.failure));

    var body = el('workerDetailBody');
    if (body) body.innerHTML = html;
    updateWorkerDetailComposer(detail);
  }

  function updateWorkerDetailComposer(detail) {
    var canMessage = !!(detail && detail.canMessage);
    var input = el('workerDetailMessageInput');
    var send = el('workerDetailSend');
    var hint = el('workerDetailHint');
    if (input) {
      input.disabled = !canMessage;
      input.placeholder = canMessage
        ? 'Message this worker (delivered at its next tool call)'
        : 'This worker is not accepting messages';
    }
    if (send) send.disabled = !canMessage;
    if (hint) {
      hint.textContent = canMessage
        ? 'Delivered at the worker\\'s next tool call.'
        : 'Read-only: the task is finished or not dispatched.';
    }
  }

  async function sendWorkerDetailMessage() {
    var ctx = state.workerDetail;
    if (!ctx || !ctx.detail || !ctx.detail.canMessage) return;
    var input = el('workerDetailMessageInput');
    var send = el('workerDetailSend');
    var body = input ? input.value.trim() : '';
    if (!body) return;
    if (send) send.disabled = true;
    if (input) input.disabled = true;
    try {
      await apiFetch(
        '/api/runs/' + encodeURIComponent(ctx.runId) +
        '/tasks/' + encodeURIComponent(ctx.taskId) + '/message',
        { method: 'POST', body: JSON.stringify({ body: body }) }
      );
      if (input) input.value = '';
      toast('Message queued for the worker');
      scheduleWorkerDetailRefresh(0);
    } catch (err) {
      toast('Message failed: ' + (err && err.message ? err.message : 'unknown error'), true);
    } finally {
      if (state.workerDetail === ctx) {
        updateWorkerDetailComposer(ctx.detail);
      }
    }
  }

  // -------------------------------------------------------------- popovers
  var MAX_WORKER_STREAM_ENTRIES = 200;
  function toggleModelPopover(force) {
    var pop = el('modelPopover');
    if (!pop) return;
    var show = force === undefined ? pop.classList.contains('is-hidden') : force;
    if (show) {
      var anchor = el('modelLabelBtn');
      if (anchor) {
        var rect = anchor.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 336)) + 'px';
        pop.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
      }
      loadModels();
    }
    pop.classList.toggle('is-hidden', !show);
  }

  function toggleMcpPopover(force) {
    var pop = el('mcpPopover');
    if (!pop) return;
    var show = force === undefined ? pop.classList.contains('is-hidden') : force;
    if (show) {
      var anchor = el('mcpToggleBtn');
      if (anchor) {
        var rect = anchor.getBoundingClientRect();
        pop.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
        pop.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
      }
      loadMcp();
    }
    pop.classList.toggle('is-hidden', !show);
  }

  // --------------------------------------------------------------- sidebar
  /**
   * Close the top-most dismissible overlay and restore focus to whatever
   * opened it.
   *
   * The order is the stacking order: the attach modal and the build
   * confirmation sit above the status-strip popovers, so Escape dismisses
   * the nearest one first. Returns true when something was closed.
   */
  function closeTopOverlay() {
    var dialog = el('plutonDialog');
    if (dialog && !dialog.classList.contains('is-hidden')) {
      var pending = plutonDialogState;
      closePlutonDialog(pending && pending.input ? null : false);
      return true;
    }
    var modelModal = el('modelSelectModal');
    if (modelModal && !modelModal.classList.contains('is-hidden')) {
      closeModelSelectModal();
      return true;
    }
    var provAddModal = el('providerAddModal');
    if (provAddModal && !provAddModal.classList.contains('is-hidden')) {
      closeAddProviderModal();
      return true;
    }
    var provKeyModal = el('providerKeyModal');
    if (provKeyModal && !provKeyModal.classList.contains('is-hidden')) {
      closeProviderKeyModal();
      return true;
    }
    var newSesModal = el('newSessionModal');
    if (newSesModal && !newSesModal.classList.contains('is-hidden')) {
      closeNewSessionModal();
      return true;
    }
    var modal = el('attachModal');
    if (modal && !modal.classList.contains('is-hidden')) {
      closeAttachModal();
      return true;
    }
    var workerModal = el('workerDetailModal');
    if (workerModal && !workerModal.classList.contains('is-hidden')) {
      // Closing the detail view never cancels the worker or deletes output.
      closeWorkerDetail();
      return true;
    }
    var insp = el('rightInspector');
    if (insp && !insp.classList.contains('is-hidden')) {
      toggleRightInspector(false);
      return true;
    }
    if (state.buildConfirmOpen) {
      closeBuildConfirm(true);
      return true;
    }
    var modelPop = el('modelPopover');
    if (modelPop && !modelPop.classList.contains('is-hidden')) {
      toggleModelPopover(false);
      var modelBtn = el('modelLabelBtn');
      if (modelBtn) modelBtn.focus();
      return true;
    }
    var mcpPop = el('mcpPopover');
    if (mcpPop && !mcpPop.classList.contains('is-hidden')) {
      toggleMcpPopover(false);
      var mcpBtn = el('mcpToggleBtn');
      if (mcpBtn) mcpBtn.focus();
      return true;
    }
    return false;
  }

  function switchSidebarTab(tabName) {
    state.sidebarTab = tabName;
    applySidebarWidth();
    var panes = { sessions: 'paneSessions', files: 'paneFiles', settings: 'paneSettings' };
    Object.keys(panes).forEach(function (key) {
      var pane = el(panes[key]);
      if (pane) pane.classList.toggle('is-hidden', key !== tabName);
    });
    var tabs = { sessions: 'sidebarTabSessions', files: 'sidebarTabFiles' };
    Object.keys(tabs).forEach(function (key) {
      var btn = el(tabs[key]);
      if (!btn) return;
      var active = key === tabName;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var settingsBtn = el('sidebarTabSettings');
    if (settingsBtn) settingsBtn.classList.toggle('is-active', tabName === 'settings');
    if (tabName === 'files') {
      var filesTab = el('tabFiles');
      var diffsTab = el('tabDiffs');
      if (filesTab) filesTab.classList.toggle('is-active', state.filesTabMode === 'files');
      if (diffsTab) diffsTab.classList.toggle('is-active', state.filesTabMode === 'diffs');
      if (state.filesTabMode === 'diffs') loadDiffsTab(state.activeRunId);
      else loadFilesList();
    } else if (tabName === 'settings') {
      loadWorkspace();
      loadApprovals();
      loadMcp();
      loadSettings();
      loadProviders();
    }
  }

  /**
   * The Settings pane is a configuration surface, not a navigation rail: it
   * needs room for model ids and selects, so the rail widens while it is open.
   * Below the overlay breakpoint the rail is a drawer and a scrim appears.
   */
  function applySidebarWidth() {
    var sidebar = el('leftSidebar');
    if (!sidebar) return;
    var restore = el('collapsedSidebarToggle');
    if (!state.sidebarOpen) {
      sidebar.classList.add('is-collapsed');
      sidebar.style.width = '0px';
      if (restore) restore.classList.remove('is-hidden');
    } else {
      sidebar.classList.remove('is-collapsed');
      sidebar.style.width = state.sidebarTab === 'settings' ? 'min(440px, 100vw)' : (state.sidebarWidth || '280px');
      if (restore) restore.classList.add('is-hidden');
    }
    var scrim = el('sidebarScrim');
    if (scrim) scrim.classList.toggle('is-visible', state.sidebarOpen && window.innerWidth <= 1000);
  }

  function toggleSidebarVisibility() {
    state.sidebarOpen = !state.sidebarOpen;
    state.sidebarUserSet = true;
    var sidebar = el('leftSidebar');
    var toggle = el('sidebarToggleBtn');
    if (!sidebar) return;
    applySidebarWidth();
    if (toggle) {
      toggle.title = state.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar';
      toggle.setAttribute('aria-label', toggle.title);
    }
  }

  /**
   * Narrow windows keep the conversation in full view: below the overlay
   * breakpoint the sidebar starts collapsed and the toggle opens it on top.
   * An explicit operator toggle always wins over the automatic behaviour.
   */
  function applyResponsiveSidebar() {
    if (state.sidebarUserSet) return;
    var narrow = window.innerWidth <= 1000;
    var sidebar = el('leftSidebar');
    if (!sidebar) return;
    state.sidebarOpen = !narrow;
    applySidebarWidth();
  }

  function initSidebarResize() {
    var handle = el('sidebarResizer');
    var sidebar = el('leftSidebar');
    if (!handle || !sidebar) return;
    var dragging = false;
    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var width = Math.max(200, Math.min(520, e.clientX));
      state.sidebarWidth = width + 'px';
      sidebar.style.width = state.sidebarWidth;
      state.sidebarOpen = true;
      sidebar.classList.remove('is-collapsed');
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
    });
  }

  // ----------------------------------------------------------------- init
  function setupComposer() {
    var input = el('promptInput');
    if (!input) return;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });
    input.addEventListener('input', function () {
      adjustTextareaHeight(input);
    });
  }

  function bindControls() {
    var dialogConfirm = el('plutonDialogConfirm');
    if (dialogConfirm) {
      dialogConfirm.addEventListener('click', function () {
        var pending = plutonDialogState;
        if (!pending) return;
        var input = el('plutonDialogInput');
        closePlutonDialog(pending.input ? (input ? input.value : '') : true);
      });
    }
    var dialogCancel = el('plutonDialogCancel');
    if (dialogCancel) {
      dialogCancel.addEventListener('click', function () {
        var pending = plutonDialogState;
        closePlutonDialog(pending && pending.input ? null : false);
      });
    }
    var dialogClose = el('plutonDialogClose');
    if (dialogClose) {
      dialogClose.addEventListener('click', function () {
        var pending = plutonDialogState;
        closePlutonDialog(pending && pending.input ? null : false);
      });
    }
    var dialogModal = el('plutonDialog');
    if (dialogModal) {
      dialogModal.addEventListener('click', function (e) {
        if (e.target !== dialogModal) return;
        var pending = plutonDialogState;
        closePlutonDialog(pending && pending.input ? null : false);
      });
    }
    var dialogInput = el('plutonDialogInput');
    if (dialogInput) {
      dialogInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (dialogConfirm) dialogConfirm.click();
        }
      });
    }

    var newBtn = el('btnNewSession');
    if (newBtn) newBtn.addEventListener('click', openNewSessionModal);
    var newConfirm = el('newSessionConfirm');
    if (newConfirm) newConfirm.addEventListener('click', confirmCreateSession);
    var newCancel = el('newSessionCancel');
    if (newCancel) newCancel.addEventListener('click', closeNewSessionModal);
    var newClose = el('newSessionClose');
    if (newClose) newClose.addEventListener('click', closeNewSessionModal);
    var newBrowse = el('btnNewSessionBrowseWorkspace');
    if (newBrowse) newBrowse.addEventListener('click', browseNewSessionWorkspace);
    var newInput = el('newSessionNameInput');
    if (newInput) {
      newInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); confirmCreateSession(); }
      });
    }
    var newWsInput = el('newSessionWorkspaceInput');
    if (newWsInput) {
      newWsInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); confirmCreateSession(); }
      });
    }

    var sessionsTab = el('sidebarTabSessions');
    if (sessionsTab) sessionsTab.addEventListener('click', function () { switchSidebarTab('sessions'); });
    var filesTab = el('sidebarTabFiles');
    if (filesTab) filesTab.addEventListener('click', function () { switchSidebarTab('files'); });
    var settingsTab = el('sidebarTabSettings');
    if (settingsTab) settingsTab.addEventListener('click', function () { switchSidebarTab('settings'); });
    var sidebarToggle = el('sidebarToggleBtn');
    if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebarVisibility);
    var projBtn = el('projectSelectBtn');
    if (projBtn) {
      projBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleProjectMenu();
      });
    }
    var sidebarScrim = el('sidebarScrim');
    if (sidebarScrim) {
      sidebarScrim.addEventListener('click', function () {
        if (window.innerWidth <= 1000) {
          state.sidebarOpen = false;
          state.sidebarUserSet = true;
          applySidebarWidth();
        }
      });
    }

    var primary = el('btnPrimary');
    if (primary) primary.addEventListener('click', handlePrimaryAction);

    // A supervised build is dispatched only after an explicit confirmation.
    var buildStart = el('btnBuildConfirmStart');
    if (buildStart) {
      buildStart.addEventListener('click', async function () {
        if (state.buildDispatching) return;
        var goal = state.pendingBuildGoal;
        if (!goal) return;
        var nameInput = el('buildConfirmProjectName');
        var projectName = nameInput ? nameInput.value.trim() : '';
        closeBuildConfirm(false);
        await startBuild(goal, projectName || undefined);
      });
    }
    var buildCancel = el('btnBuildConfirmCancel');
    if (buildCancel) buildCancel.addEventListener('click', function () { closeBuildConfirm(true); });

    var saveProjectNameBtn = el('btnSaveProjectName');
    if (saveProjectNameBtn) saveProjectNameBtn.addEventListener('click', saveProjectName);
    var projectNameField = el('projectNameInput');
    if (projectNameField) {
      projectNameField.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveProjectName();
        }
      });
    }

    // Escape dismisses the nearest overlay and puts the keyboard back where
    // it was.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (!closeTopOverlay()) return;
      e.preventDefault();
      e.stopPropagation();
    });

    // Standalone plan/build buttons were removed from the markup; the
    // modeToggleBtn split control owns Plan/Build selection now.
    var chatMode = el('modeChatBtn');
    if (chatMode) chatMode.addEventListener('click', function () { setMode('chat'); });
    var toggleMode = el('modeToggleBtn');
    if (toggleMode) {
      toggleMode.addEventListener('click', function () {
        if (state.mode === 'chat') {
          setMode(state.buildOrPlanMode || 'plan');
        } else if (state.mode === 'plan') {
          setMode('build');
        } else {
          setMode('plan');
        }
      });
    }

    var chatBox = el('chatScrollContainer');
    if (chatBox) {
      chatBox.addEventListener('scroll', onChatScroll);
    }
    var jumpBtn = el('btnJumpToLatest');
    if (jumpBtn) {
      jumpBtn.addEventListener('click', function () {
        maybeScroll(true, true);
        jumpBtn.classList.add('is-hidden');
      });
    }

    var fileViewerClose = el('fileViewerClose');
    if (fileViewerClose) {
      fileViewerClose.addEventListener('click', function () {
        if (state.activeTabPath) closeEditorTab(state.activeTabPath);
        else closeFileViewer(false);
      });
    }
    var fileViewerEdit = el('fileViewerEdit');
    if (fileViewerEdit) fileViewerEdit.addEventListener('click', enterFileEditMode);
    var fileViewerSave = el('fileViewerSave');
    if (fileViewerSave) fileViewerSave.addEventListener('click', function () { saveFileContent(); });
    var fileEditorInput = el('fileEditorInput');
    if (fileEditorInput) {
      fileEditorInput.addEventListener('input', onFileEditorInput);
      fileEditorInput.addEventListener('scroll', function () { syncCodeScroll(fileEditorInput); });
    }
    var codeHighlight = el('codeHighlight');
    if (codeHighlight) {
      codeHighlight.addEventListener('scroll', function () { syncCodeScroll(codeHighlight); });
    }
    document.addEventListener('keydown', function (e) {
      if (!fileViewerIsOpen()) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        if (state.activeTabPath) closeEditorTab(state.activeTabPath);
        else closeFileViewer(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveFileContent();
        return;
      }
      if (!state.viewerEditing && !state.viewerDiff && (e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        enterFileEditMode();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (state.activeTabPath) closeEditorTab(state.activeTabPath);
        else closeFileViewer(false);
      }
    });

    var toggleSplitViewBtn = el('btnToggleSplitView');
    if (toggleSplitViewBtn) {
      toggleSplitViewBtn.addEventListener('click', function () {
        toggleRightInspector();
      });
    }

    // The workspace chip and the file-panel label are pinned to the server's
    // project directory; clicking them explains the pin (no client-side
    // selection exists, so no label may diverge from server-confirmed state).
    var wsChip = el('workspaceChip');
    if (wsChip) wsChip.addEventListener('click', explainWorkspacePin);
    var filesWsLabel = el('filesWorkspaceLabel');
    if (filesWsLabel) filesWsLabel.addEventListener('click', explainWorkspacePin);
    var settingsWsRoot = el('settingsWorkspaceRoot');
    if (settingsWsRoot) settingsWsRoot.addEventListener('click', explainWorkspacePin);
    var btnChangeSettingsWs = el('btnChangeSettingsWorkspace');
    if (btnChangeSettingsWs) btnChangeSettingsWs.addEventListener('click', explainWorkspacePin);

    var attach = el('btnAttach');
    if (attach) attach.addEventListener('click', openAttachModal);
    var attachClose = el('attachClose');
    if (attachClose) attachClose.addEventListener('click', closeAttachModal);
    var attachCancel = el('attachCancel');
    if (attachCancel) attachCancel.addEventListener('click', closeAttachModal);

    // Voice input via Web Speech API with live speech recognition
    var mic = el('btnMic');
    if (mic) {
      mic.addEventListener('click', toggleVoiceInput);
    }

    var shipBadge = el('shipActivityBadgeContainer');
    if (shipBadge) {
      shipBadge.addEventListener('click', function () {
        toggleRightInspector();
      });
    }

    var rightInspectorClose = el('rightInspectorClose');
    if (rightInspectorClose) {
      rightInspectorClose.addEventListener('click', function () {
        toggleRightInspector(false);
      });
    }

    // Worker cards open the authoritative detail modal; the whole card is the
    // target because a worker is one identity, not a set of hidden affordances.
    var inspectorGrid = el('rightInspectorGrid');
    if (inspectorGrid) {
      inspectorGrid.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== inspectorGrid) {
          if (node.classList && node.classList.contains('worker-partition')) {
            openWorkerDetail(node.getAttribute('data-task-id'));
            return;
          }
          node = node.parentNode;
        }
      });
      inspectorGrid.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        var node = e.target;
        while (node && node !== inspectorGrid) {
          if (node.classList && node.classList.contains('worker-partition')) {
            e.preventDefault();
            openWorkerDetail(node.getAttribute('data-task-id'));
            return;
          }
          node = node.parentNode;
        }
      });
    }

    var workerDetailClose = el('workerDetailClose');
    if (workerDetailClose) workerDetailClose.addEventListener('click', closeWorkerDetail);
    var workerDetailSend = el('workerDetailSend');
    if (workerDetailSend) workerDetailSend.addEventListener('click', sendWorkerDetailMessage);
    var workerDetailInput = el('workerDetailMessageInput');
    if (workerDetailInput) {
      workerDetailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendWorkerDetailMessage();
        }
      });
    }
    var workerDetailModal = el('workerDetailModal');
    if (workerDetailModal) {
      workerDetailModal.addEventListener('click', function (e) {
        if (e.target === workerDetailModal) closeWorkerDetail();
      });
    }

    var restoreBtn = el('btnRestoreSidebar');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        state.sidebarOpen = true;
        state.sidebarUserSet = true;
        applySidebarWidth();
      });
    }

    var signOutBtn = el('btnSignOutAccount');
    if (signOutBtn) signOutBtn.addEventListener('click', handleSignOutAccount);
    var signInBtn = el('btnSignInAccount');
    if (signInBtn) signInBtn.addEventListener('click', handleSignInAccount);
    var loginInput = el('loginUserInput');
    if (loginInput) {
      loginInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); handleSignInAccount(); }
      });
    }

    var toggleKeyBtn = el('btnToggleApiKey');
    if (toggleKeyBtn) toggleKeyBtn.addEventListener('click', handleToggleApiKey);
    var verifyAddBtn = el('btnVerifyAddCustomModel');
    if (verifyAddBtn) verifyAddBtn.addEventListener('click', verifyAndAddCustomModel);
    var modelNameIn = el('customModelNameInput');
    if (modelNameIn) {
      modelNameIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); verifyAndAddCustomModel(); }
      });
    }
    var apiKeyIn = el('customApiKeyInput');
    if (apiKeyIn) {
      apiKeyIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); verifyAndAddCustomModel(); }
      });
    }

    var autoToolToggle = el('toggleAutonomous');
    if (autoToolToggle) autoToolToggle.addEventListener('change', function () { saveSettings({ permissions: { autonomousToolExecution: autoToolToggle.checked } }); });
    var parallelToggle = el('toggleParallel');
    if (parallelToggle) parallelToggle.addEventListener('change', function () { saveSettings({ permissions: { parallelSubAgents: parallelToggle.checked } }); });
    var autoApproveToggle = el('toggleAutoApproveRead');
    if (autoApproveToggle) autoApproveToggle.addEventListener('change', function () { saveSettings({ permissions: { autoApproveReadTools: autoApproveToggle.checked } }); });
    var terminalToggle = el('toggleTerminalBash');
    if (terminalToggle) terminalToggle.addEventListener('change', function () { saveSettings({ permissions: { terminalAndBash: terminalToggle.checked } }); });

    var thinkingSelect = el('thinkingEffortSelect');
    if (thinkingSelect) thinkingSelect.addEventListener('change', function () { saveSettings({ thinkingEffort: thinkingSelect.value }); });

    var modelBtn = el('modelLabelBtn');
    if (modelBtn) modelBtn.addEventListener('click', function () { openModelSelectModal(); });
    var mcpBtn = el('mcpToggleBtn');
    if (mcpBtn) mcpBtn.addEventListener('click', function () { toggleMcpPopover(); });

    // Provider management bindings
    var btnImportProv = el('btnImportProviders');
    if (btnImportProv) btnImportProv.addEventListener('click', triggerImportProviders);
    var btnOpenAddProv = el('btnOpenAddProvider');
    if (btnOpenAddProv) btnOpenAddProv.addEventListener('click', openAddProviderModal);
    var provAddClose = el('providerAddClose');
    if (provAddClose) provAddClose.addEventListener('click', closeAddProviderModal);
    var provAddCancel = el('providerAddCancel');
    if (provAddCancel) provAddCancel.addEventListener('click', closeAddProviderModal);
    var btnAddProvSubmit = el('btnAddProviderSubmit');
    if (btnAddProvSubmit) btnAddProvSubmit.addEventListener('click', submitAddProvider);

    var provKeyClose = el('providerKeyClose');
    if (provKeyClose) provKeyClose.addEventListener('click', closeProviderKeyModal);
    var provKeyCancel = el('providerKeyCancel');
    if (provKeyCancel) provKeyCancel.addEventListener('click', closeProviderKeyModal);
    var btnSaveProvKey = el('btnSaveProviderKey');
    if (btnSaveProvKey) btnSaveProvKey.addEventListener('click', submitProviderKey);

    var provKeyInput = el('providerKeyInput');
    if (provKeyInput) {
      provKeyInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitProviderKey(); }
      });
    }

    // Model select modal bindings
    var modelSelectClose = el('modelSelectClose');
    if (modelSelectClose) modelSelectClose.addEventListener('click', closeModelSelectModal);
    var modelSelectCancel = el('modelSelectCancel');
    if (modelSelectCancel) modelSelectCancel.addEventListener('click', closeModelSelectModal);
    var modelSearchIn = el('modelSearchInput');
    if (modelSearchIn) {
      modelSearchIn.addEventListener('input', function () {
        renderModelSelectList(modelSearchIn.value);
      });
      modelSearchIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') e.preventDefault();
      });
    }

    var filesTabBtn = el('tabFiles');
    var diffsTabBtn = el('tabDiffs');
    if (filesTabBtn) {
      filesTabBtn.addEventListener('click', function () {
        state.filesTabMode = 'files';
        filesTabBtn.classList.add('is-active');
        if (diffsTabBtn) diffsTabBtn.classList.remove('is-active');
        loadFilesList();
      });
    }
    if (diffsTabBtn) {
      diffsTabBtn.addEventListener('click', function () {
        state.filesTabMode = 'diffs';
        diffsTabBtn.classList.add('is-active');
        if (filesTabBtn) filesTabBtn.classList.remove('is-active');
        loadDiffsTab(state.activeRunId);
      });
    }

    var fileSearchIn = el('fileSearchInput');
    var fileSearchClear = el('fileSearchClear');
    var fileSearchResults = el('fileSearchResults');
    var filesList = el('filesList');
    var searchDebounceTimer = null;

    if (fileSearchIn) {
      fileSearchIn.addEventListener('input', function () {
        var query = (fileSearchIn.value || '').trim();
        if (fileSearchClear) fileSearchClear.classList.toggle('is-hidden', !query);
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        if (!query) {
          if (fileSearchResults) fileSearchResults.classList.add('is-hidden');
          if (filesList) filesList.classList.remove('is-hidden');
          return;
        }
        searchDebounceTimer = setTimeout(function () {
          searchWorkspace(query);
        }, 300);
      });
      fileSearchIn.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          fileSearchIn.value = '';
          if (fileSearchClear) fileSearchClear.classList.add('is-hidden');
          if (fileSearchResults) fileSearchResults.classList.add('is-hidden');
          if (filesList) filesList.classList.remove('is-hidden');
        }
      });
    }

    if (fileSearchClear) {
      fileSearchClear.addEventListener('click', function () {
        if (fileSearchIn) fileSearchIn.value = '';
        fileSearchClear.classList.add('is-hidden');
        if (fileSearchResults) fileSearchResults.classList.add('is-hidden');
        if (filesList) filesList.classList.remove('is-hidden');
        if (fileSearchIn) fileSearchIn.focus();
      });
    }

    var reloadModels = el('btnReloadModels');
    if (reloadModels) reloadModels.addEventListener('click', function () { loadModels(); toast('Model registry reloaded'); });

    var verifyBtn = el('btnVerifyRedispatch');
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async function () {
        if (!state.activeRunId) return;
        try {
          verifyBtn.disabled = true;
          verifyBtn.textContent = 'Verifying\\u2026';
          var res = await apiFetch('/api/runs/' + encodeURIComponent(state.activeRunId) + '/verify', {
            method: 'POST',
            body: JSON.stringify({ dispatch: true })
          });
          toast('Verification complete. Outcome: ' + (res.finalVerdict ? res.finalVerdict.outcome : 'finished'));
          refreshActiveRun();
        } catch (err) {
          toast('Verification failed: ' + err.message, true);
        } finally {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify & Re-dispatch';
        }
      });
    }
    var resumeBtn = el('btnResumeRun');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async function () {
        if (!state.activeRunId) return;
        try {
          resumeBtn.disabled = true;
          resumeBtn.textContent = 'Resuming\\u2026';
          var res = await apiFetch('/api/runs/' + encodeURIComponent(state.activeRunId) + '/resume', {
            method: 'POST',
            body: '{}'
          });
          toast('Run resumed. Outcome: ' + (res.summary ? res.summary.outcome : 'finished'));
          refreshActiveRun();
        } catch (err) {
          toast('Failed to resume run: ' + err.message, true);
        } finally {
          resumeBtn.disabled = false;
          resumeBtn.textContent = 'Resume Run';
        }
      });
    }
    var diffBtn = el('btnViewRunDiff');
    if (diffBtn) {
      diffBtn.addEventListener('click', function () {
        switchSidebarTab('files');
        state.filesTabMode = 'diffs';
        loadDiffsTab(state.activeRunId);
      });
    }

    document.addEventListener('click', function (e) {
      var modelPop = el('modelPopover');
      var mcpPop = el('mcpPopover');
      var projDropdown = el('projectSelectDropdown');
      var target = e.target;
      if (projDropdown && !projDropdown.contains(target)) {
        toggleProjectMenu(false);
      }
      if (modelPop && !modelPop.contains(target) && target !== el('modelLabelBtn') && !(el('modelLabelBtn') && el('modelLabelBtn').contains(target))) {
        toggleModelPopover(false);
      }
      if (mcpPop && !mcpPop.contains(target) && !(el('mcpToggleBtn') && el('mcpToggleBtn').contains(target))) {
        toggleMcpPopover(false);
      }
      // On narrow windows the sidebar is an overlay: a click outside it
      // closes it so the conversation is readable again.
      var sidebar = el('leftSidebar');
      var restoreToggle = el('collapsedSidebarToggle');
      if (sidebar && state.sidebarOpen && window.innerWidth <= 1000 && !sidebar.contains(target) && (!restoreToggle || !restoreToggle.contains(target))) {
        state.sidebarOpen = false;
        sidebar.classList.add('is-collapsed');
        applySidebarWidth();
        sidebar.style.width = '0px';
      }
    });

    window.addEventListener('resize', function () {
      toggleProjectMenu(false);
      toggleModelPopover(false);
      toggleMcpPopover(false);
      applyResponsiveSidebar();
    });
  }

  async function init() {
    bindControls();
    setupComposer();
    initSidebarResize();
    applyResponsiveSidebar();
    setMode('chat');
    await loadProjects();
    connectSSE();
    try {
      await loadWorkspace();
      await loadSessions();
      await loadModels();
      await loadProviders();
      await loadMcp();
      await loadApprovals();
      await loadSettings();
      var queryTab = urlParams.get('tab');
      if (queryTab) {
        switchSidebarTab(queryTab);
      }
      reconstituteWorkerPartitions();
    } catch (err) {
      console.error('Initialization error:', err);
      toast('Initialization failed: ' + err.message, true);
    }
    setInterval(loadMcp, MCP_POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) loadMcp();
    });
  }

  init();
})();
`,
  },
}
