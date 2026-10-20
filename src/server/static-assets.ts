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
            <span id="filesWorkspaceLabel" class="mono truncate">—</span>
            <span class="pane-tag">workspace</span>
          </div>
          <div class="sub-tabs" role="tablist">
            <button id="tabFiles" class="sub-tab is-active" type="button">Files</button>
            <button id="tabDiffs" class="sub-tab" type="button">Worktree Diffs</button>
          </div>
          <div id="filesList" class="file-list"></div>
          <div id="filePreview" class="file-preview is-hidden">
            <div id="activeFileName" class="file-preview-name mono">—</div>
            <pre class="file-preview-body"><code id="fileCodeBody">// Select a file from the workspace</code></pre>
          </div>
        </div>
      </section>

      <!-- SETTINGS PANE -->
      <section id="paneSettings" class="sidebar-pane is-hidden" role="tabpanel" aria-label="Settings">
        <div class="pane-scroll">
          <div class="card">
            <div class="card-head">
              <span class="card-title">Agent Orchestra</span><span class="tag-mono">live run</span>
            </div>
            <div id="activeRunCard" class="orchestra"></div>
            <div class="card-head-actions">
              <button id="btnVerifyRedispatch" class="btn-secondary is-hidden" type="button">Verify &amp; Re-dispatch</button>
              <button id="btnResumeRun" class="btn-secondary is-hidden" type="button">Resume Run</button>
              <button id="btnViewRunDiff" class="btn-secondary is-hidden" type="button">View Run Diff</button>
            </div>
            <div id="dagContainer" class="dag-container"></div>
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

          <!-- Ship Specific AI Models Configuration -->
          <div class="card">
            <div class="card-head">
              <span class="card-title">
                <span class="card-title-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${plutonMarkBody}</svg></span>
                Custom Ship Worker AI Model
              </span>
            </div>
            <div class="card-sub">Writes the live Muse model</div>
            <div id="museModelList" class="muse-models"></div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">MCP Servers</span><span id="mcpCardCount" class="tag-mono">—</span></div>
            <div id="mcpCardList" class="mcp-list"></div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">Workspace Root Directory</span></div>
            <div id="settingsWorkspaceRoot" class="mono path-box truncate">—</div>
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
        <div class="header-tools">
          <div id="connectionStatus" class="conn" title="Local runtime status">
            <span class="conn-dot"></span><span class="conn-label">Connected</span>
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

      <div id="buildConfirm" class="build-confirm is-hidden" role="alertdialog" aria-modal="false" aria-labelledby="buildConfirmTitle" aria-describedby="buildConfirmBody">
        <div class="build-confirm-head">
          <span id="buildConfirmTitle">Confirm supervised build</span>
          <span class="tag-mono">build</span>
        </div>
        <div id="buildConfirmBody" class="build-confirm-body">
          <div class="build-confirm-row"><span class="build-confirm-key">Operation</span><span class="build-confirm-val">Supervised build - the manager Muse plans and delegates to the team</span></div>
          <div class="build-confirm-row"><span class="build-confirm-key">Workspace</span><span class="build-confirm-val mono" id="buildConfirmWorkspace">-</span></div>
          <div class="build-confirm-row"><span class="build-confirm-key">Goal</span><span class="build-confirm-val" id="buildConfirmGoal">-</span></div>
          <div class="build-confirm-note">A build provisions worker containers and spends engine tokens. Nothing is dispatched until you confirm.</div>
        </div>
        <div class="build-confirm-actions">
          <button id="btnBuildConfirmStart" class="btn-primary" type="button">Start build</button>
          <button id="btnBuildConfirmCancel" class="btn-secondary" type="button">Cancel</button>
        </div>
      </div>

      <div class="dock">
        <div class="composer">
          <textarea id="promptInput" class="composer-textarea" rows="1" placeholder="Ask Pluton to plan, implement, investigate… (Enter to submit, Shift+Enter for newline)" spellcheck="false"></textarea>

          <div id="attachmentPreviewContainer" class="attachment-tray is-hidden"></div>

          <div class="composer-bar">
            <div class="composer-left">
              <div class="mode-switch" role="group" aria-label="Interaction mode">
                <button id="modeChatBtn" class="mode-btn is-active" type="button" title="Send the prompt straight to the active Muse">Chat</button>
                <button id="modeBuildBtn" class="mode-btn" type="button" title="Run the prompt as a supervised build: the manager Muse plans and delegates to the team">Build</button>
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
            </span>
            <span class="status-divider">|</span>
            <span class="chip" id="workspaceChip" title="Active workspace">
              <span class="chip-folder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg></span>
              <span id="workspaceName">—</span>
              <span class="chip-sep">·</span>
              <span id="workspacePath" class="mono">—</span>
            </span>
            <span class="status-divider">·</span>
            <span class="status-item">
              Model:
              <button id="modelLabelBtn" class="link-btn" type="button" title="Switch the active Muse model">
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
  </div>

  <!-- Model popover -->
  <div id="modelPopover" class="popover popover-models is-hidden" role="dialog" aria-label="Select AI model">
    <div class="popover-head">Select AI Model</div>
    <div id="modelListContainer" class="popover-body"></div>
  </div>

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
      <div class="modal-foot">
        <span class="modal-hint">The session is persisted for this project.</span>
        <button id="newSessionCancel" class="btn-secondary" type="button">Cancel</button>
        <button id="newSessionConfirm" class="btn-primary" type="button">Create Session</button>
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
  /* Surfaces */
  --bg-main: #09080e;
  --bg-sidebar: #0c0b12;
  --bg-surface: #12101b;
  --bg-message-ai: #12111a;
  --bg-message-user: #19132a;
  --bg-inset: #0e0d16;
  --bg-hover: #1e1a2e;
  --bg-active: #251c3d;

  /* Lines */
  --border: #242036;
  --border-soft: #1d1b2b;
  --border-strong: #2a2440;
  --border-user: #332656;

  /* Accents */
  --accent-purple: #a78bfa;
  --accent-purple-deep: #8b5cf6;
  --accent-purple-soft: #d8b4fe;
  --accent-cyan: #38bdf8;
  --accent-ok: #34d399;
  --accent-warn: #fbbf24;
  --accent-danger: #f87171;

  /* Text */
  --text: #f3f0fa;
  --text-soft: #e2e0ec;
  --text-muted: #a49fb4;
  --text-dim: #8e8a9f;

  --font-sans: Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
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
::-webkit-scrollbar-track { background: #0c0b12; border-radius: 999px; }
::-webkit-scrollbar-thumb { background: #221e33; border-radius: 999px; border: 1px solid rgba(255,255,255,0.02); }
::-webkit-scrollbar-thumb:hover { background: #342e4f; }
::selection { background: rgba(139,92,246,0.35); color: #fff; }
::-webkit-scrollbar-corner { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: #221e33 #0c0b12; }

:focus-visible { outline: 2px solid var(--accent-cyan); outline-offset: 2px; }

/* ===================== App shell ===================== */
.app-shell { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

.app-sidebar {
  position: relative;
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-right: 1px solid #1a1826;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  transition: width 90ms ease;
}
.app-sidebar.is-collapsed { width: 0 !important; border-right: none; }

.collapsed-toggle {
  width: 48px;
  flex-shrink: 0;
  height: 100%;
  background: var(--bg-sidebar);
  border-right: 1px solid #1a1826;
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
  border-bottom: 1px solid #191726;
  flex-shrink: 0;
}
.sidebar-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  background: #12101b;
  border: 1px solid #1f1c2e;
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
.tab-btn:hover { color: #d4d0e5; }
.tab-btn.is-active {
  background: var(--bg-active);
  color: var(--accent-purple-soft);
  border-color: rgba(76,53,117,0.6);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 6px;
  background: #12101b;
  border: 1px solid #1f1c2e;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.icon-btn svg { width: 16px; height: 16px; }
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn.is-active { background: var(--bg-active); color: var(--accent-purple-soft); border-color: rgba(76,53,117,0.6); }

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
.sidebar-resizer:hover { background: rgba(167,139,250,0.4); }

/* ===================== Sessions ===================== */
.btn-new {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #2f2749;
  background: linear-gradient(180deg, #241b3c, #1b1530);
  color: var(--accent-purple-soft);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}
.btn-new:hover { border-color: var(--accent-purple); background: linear-gradient(180deg, #2b2049, #201836); }

.session-list { display: flex; flex-direction: column; gap: 4px; }
.session-item {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background 120ms ease;
}
.session-item:hover { background: #14121f; }
.session-item.is-active { background: #1e192f; border-color: #3b2d63; }
.session-title { font-size: 12px; color: #a7a2b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-item.is-active .session-title { color: #fff; }
.session-meta { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.empty-hint { padding: 10px; font-size: 12px; color: var(--text-dim); line-height: 1.5; }

/* ===================== Files ===================== */
.pane-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-muted); padding: 0 2px; }
.pane-tag { color: var(--accent-purple); font-size: 11px; }
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
.sub-tab.is-active { color: var(--text); border-bottom-color: var(--accent-purple); }
.file-list { display: flex; flex-direction: column; max-height: 46vh; overflow-y: auto; }
.file-row {
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
.file-row:hover { background: #14121f; color: var(--text); }
.file-row.is-active { background: rgba(139,92,246,0.16); color: #fff; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chevron { width: 12px; height: 12px; flex-shrink: 0; color: var(--text-dim); transition: transform 120ms ease; }
.file-dir.is-open .file-chevron { transform: rotate(90deg); }
.file-icon { width: 13px; height: 13px; flex-shrink: 0; }
.file-dir .file-icon { color: var(--accent-purple); }
.file-item .file-icon { color: var(--text-dim); }
.file-count { margin-left: auto; font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }
.file-children.is-collapsed { display: none; }
.file-preview { border: 1px solid var(--border-soft); border-radius: var(--radius-md); overflow: hidden; }
.file-preview-name { padding: 6px 8px; background: #12101b; border-bottom: 1px solid var(--border-soft); font-size: 11px; color: var(--accent-cyan); }
.file-preview-body { max-height: 40vh; overflow: auto; padding: 8px; font-family: var(--font-mono); font-size: 11px; line-height: 1.45; white-space: pre; color: var(--text-soft); }

/* ===================== Settings cards ===================== */
.card {
  background: #151221;
  border: 1px solid #2f2749;
  border-radius: var(--radius-lg);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-head-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.card-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #fff; }
.card-title svg { width: 15px; height: 15px; color: var(--accent-purple); }
.card-sub { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
.tag-mono { font-family: var(--font-mono); font-size: 11px; color: var(--accent-purple); }
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
.notice-muted { background: #12101b; border: 1px solid var(--border); color: var(--text-muted); }

.registry { display: flex; flex-direction: column; gap: 6px; }
.registry-group { border: 1px solid var(--border-soft); border-radius: 6px; overflow: hidden; }
.registry-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: #12101b; font-size: 11px; font-family: var(--font-mono); color: var(--text-muted); }
.registry-list { max-height: 160px; overflow-y: auto; }
.registry-item { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 8px; font-size: 11px; font-family: var(--font-mono); color: var(--text-soft); }
.registry-item + .registry-item { border-top: 1px solid #16141f; }
.registry-item.is-current { color: var(--accent-purple-soft); background: rgba(139,92,246,0.1); }

.muse-models { display: flex; flex-direction: column; gap: 8px; }
.muse-row { display: flex; flex-direction: column; gap: 4px; }
.muse-row-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; }
.muse-name { color: var(--text); font-weight: 600; }
.muse-role { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
select.mini-select {
  width: 100%;
  background: #0c0b12;
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
.perm-mode { font-size: 11px; font-family: var(--font-mono); color: var(--accent-purple-soft); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip-perm { font-family: var(--font-mono); font-size: 11px; padding: 2px 5px; border-radius: 4px; background: rgba(255,255,255,0.05); color: var(--text-muted); }

.approvals { display: flex; flex-direction: column; gap: 6px; }
.approval-row { border: 1px solid var(--border); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 5px; background: #12101b; }
.approval-row-action { font-size: 12px; font-weight: 600; color: var(--accent-warn); }
.approval-row-reason { font-size: 11px; color: var(--text-muted); }
.approval-row-actions { display: flex; gap: 5px; }

.mcp-list { display: flex; flex-direction: column; gap: 5px; }
.mcp-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: 1px solid var(--border-soft); border-radius: 6px; background: #0c0b12; font-size: 11px; }
.mcp-item-name { font-family: var(--font-mono); color: var(--text); }
.mcp-item-detail { font-size: 11px; color: var(--text-dim); line-height: 1.4; }

.orchestra { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.orchestra-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dag-container { display: flex; flex-direction: column; gap: 10px; }
.dag-task-card { background: #12101b; border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px; }
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
.dag-stage-header { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-purple-soft); border-bottom: 1px solid var(--border-soft); padding-bottom: 4px; }
.dag-flow-arrow { align-self: center; color: var(--accent-purple); font-size: 12px; }
.path-box { background: #0c0b12; border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; font-size: 11px; color: var(--accent-purple-soft); }

/* Settings: Account & Profile */
.account-box { display: flex; flex-direction: column; gap: 8px; }
.account-profile {
  display: flex; align-items: center; gap: 10px;
  background: #0c0b12; border: 1px solid var(--border-soft);
  border-radius: 6px; padding: 8px 10px;
}
.account-avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #7c3aed, #4f46e5);
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
  background: #0c0b12; border: 1px solid var(--border-soft);
  border-radius: 6px; cursor: pointer; user-select: none;
}
.toggle-row:hover { border-color: var(--border-strong); }
.checkbox-custom { accent-color: var(--accent-purple-deep); width: 16px; height: 16px; cursor: pointer; }

/* Settings: Select Box */
.select-box {
  width: 100%; background: #0c0b12; border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 10px; font-size: 12px;
  color: var(--text); font-family: inherit; outline: none; cursor: pointer;
}
.select-box:focus { border-color: var(--accent-purple); }

/* ===================== Main column ===================== */
.app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100%; background: var(--bg-main); }

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 52px;
  padding: 0 18px;
  border-bottom: 1px solid #181624;
  flex-shrink: 0;
}
.brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.brand-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 6px;
  background: #1d1730; border: 1px solid #3c2d63; color: var(--accent-purple);
}
.brand-mark svg { width: 20px; height: 20px; }
.brand-name { font-weight: 700; font-size: 14px; letter-spacing: 0.08em; color: #fff; }
.brand-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: #151320; border: 1px solid #242036; color: var(--text-muted); }
.header-tools { display: flex; align-items: center; gap: 10px; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
.conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent-ok); border: 2px solid rgba(52,211,153,0.25); }
.conn.is-offline .conn-dot { background: var(--accent-danger); border-color: rgba(248,113,113,0.25); }

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
.chat-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px 20px 8px; }
.messages { display: flex; flex-direction: column; gap: 14px; max-width: 880px; }

.msg { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
.msg-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
.msg-avatar { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.msg-avatar svg { width: 14px; height: 14px; }
.msg-you { color: var(--accent-purple); }
.msg-pluton { color: var(--accent-cyan); }

.msg-user {
  align-self: flex-start;
  background: var(--bg-message-user);
  border: 1px solid var(--border-user);
  border-radius: var(--radius-lg);
  padding: 10px 14px;
}
.msg-user .msg-head { margin-bottom: 2px; }
.msg-ai {
  background: var(--bg-message-ai);
  border: 1px solid #1f1d2e;
  border-radius: var(--radius-lg);
  padding: 12px 14px;
}
.msg-ai .msg-head { margin-bottom: 6px; }
.msg-body { font-size: 13px; color: var(--text-soft); line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
.msg-user .msg-body { color: #f1eff7; }

.msg-system { color: var(--text-muted); font-size: 12px; padding: 2px 4px; }
.msg-system .msg-body { font-size: 12px; color: var(--text-muted); }
.msg-error .msg-body { color: #fca5a5; }

.msg-body p, .msg-body ul, .msg-body ol, .msg-body blockquote { max-width: 74ch; }
.msg-body p { margin: 0 0 8px; }
.msg-body p:last-child { margin-bottom: 0; }
.msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4 { color: #fff; margin: 12px 0 6px; line-height: 1.3; }
.msg-body h1 { font-size: 17px; } .msg-body h2 { font-size: 15px; } .msg-body h3 { font-size: 14px; } .msg-body h4 { font-size: 13px; }
.msg-body ul, .msg-body ol { margin: 0 0 8px; padding-left: 20px; }
.msg-body li { margin-bottom: 3px; }
.msg-body blockquote { margin: 0 0 8px; padding: 6px 0 6px 12px; border-left: 1px solid #4c3575; background: rgba(139,92,246,0.05); color: var(--text-muted); }
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
  background: rgba(139,92,246,0.08);
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
  background: #1c1a29;
  border: 1px solid #2a273d;
  color: #e2e0ec;
  padding: 1px 5px;
  border-radius: 4px;
}
.msg-body pre.code-block {
  background: #0e0d16;
  border: 1px solid #232036;
  border-radius: 10px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0 0 10px;
}
.msg-body pre.code-block code { background: none; border: none; padding: 0; font-size: 12px; line-height: 1.55; white-space: pre; }
.tok-cm { color: #8e8a9f; font-style: italic; }
.tok-st { color: #a5d6a7; }
.tok-kw { color: #c4b5fd; }
.tok-num { color: #fcd34d; }
.caret-blink { display: inline-block; width: 7px; height: 14px; background: var(--accent-cyan); vertical-align: text-bottom; animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }

/* Tool cards */
.tool-card {
  background: #12101b;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  max-width: 100%;
}
.tool-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; background: rgba(0,0,0,0.2); }
.tool-name { font-family: var(--font-mono); font-size: 12px; color: var(--accent-cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
.tool-status.running { background: rgba(251,191,36,0.18); color: var(--accent-warn); }
.tool-status.succeeded { background: rgba(16,185,129,0.18); color: var(--accent-ok); }
.tool-status.failed { background: rgba(239,68,68,0.18); color: var(--accent-danger); }
.tool-card-body { padding: 8px 10px; border-top: 1px solid var(--border-soft); font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); white-space: pre-wrap; max-height: 220px; overflow: auto; }

/* ===================== Composer ===================== */
.dock { flex-shrink: 0; padding: 0 16px 10px; background: var(--bg-main); border-top: 1px solid #181624; }
.build-confirm {
  flex-shrink: 0;
  margin: 10px 16px 0;
  background: var(--bg-inset);
  border: 1px solid #3c2d63;
  border-left: 3px solid var(--accent-purple);
  border-radius: 10px;
  overflow: hidden;
}
.build-confirm-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 12px; font-size: 12px; font-weight: 600; color: #fff;
  border-bottom: 1px solid #1f1b30;
}
.build-confirm-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.build-confirm-row { display: flex; gap: 10px; align-items: baseline; font-size: 12px; }
.build-confirm-key { flex: 0 0 82px; color: var(--text-muted); }
.build-confirm-val { flex: 1 1 auto; color: #fff; word-break: break-word; }
.build-confirm-val.mono { font-family: var(--font-mono); font-size: 11px; }
.build-confirm-note { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-top: 2px; }
.build-confirm-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 0 12px 11px; }
.composer {
  background: var(--bg-inset);
  border: 1px solid #232036;
  border-radius: 10px;
  padding: 10px;
  transition: border-color 120ms ease;
}
.composer:focus-within { border-color: #4c3575; }
.composer-textarea {
  width: 100%;
  background: transparent;
  border: none;
  resize: none;
  color: var(--text-soft);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  min-height: 24px;
  max-height: 180px;
  display: block;
}
.composer-textarea::placeholder { color: var(--text-dim); }
.composer-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #181625; flex-wrap: wrap; }
.composer-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.composer-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.mode-switch { display: inline-flex; align-items: center; gap: 2px; padding: 2px; background: #14121f; border: 1px solid #252238; border-radius: 6px; }
.mode-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.mode-btn:hover { color: #d4d0e5; }
.mode-btn.is-active { background: #1f1a30; color: var(--accent-cyan); box-shadow: 0 1px 2px rgba(0,0,0,0.4); }

.tool-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 9px;
  border-radius: 6px;
  background: #161422;
  border: 1px solid #2a263d;
  color: #b5b1c9;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.tool-btn svg { width: 14px; height: 14px; }
.tool-btn:hover:not(.is-disabled) { background: #1c1a2b; color: #fff; }
.tool-btn.is-disabled { opacity: 0.45; cursor: not-allowed; }
.tool-btn.is-listening {
  color: var(--accent-danger) !important;
  border-color: rgba(248, 113, 113, 0.6) !important;
  background: rgba(248, 113, 113, 0.12) !important;
  animation: mic-pulse 1.5s infinite;
}
@keyframes mic-pulse {
  0% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.6); }
  70% { box-shadow: 0 0 0 8px rgba(248, 113, 113, 0); }
  100% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0); }
}

.activity-badge { position: relative; }
.activity-inner { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 6px; border: 1px solid #2b2242; background: #141224; color: var(--accent-purple-soft); font-size: 12px; }
.activity-text { font-weight: 700; color: #fff; }
.boat { display: inline-flex; animation: boat 2s ease-in-out infinite; }
.boat svg { width: 16px; height: 16px; }
.card-title-mark { display: inline-flex; }
.card-title-mark svg { width: 16px; height: 16px; color: var(--accent-purple); }
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
  0% { background-position: 0% 50%; box-shadow: 0 0 10px rgba(124,58,237,0.25); }
  50% { background-position: 100% 50%; box-shadow: 0 0 16px rgba(56,189,248,0.35); }
  100% { background-position: 0% 50%; box-shadow: 0 0 10px rgba(124,58,237,0.25); }
}
.activity-badge.sea-waves .activity-inner {
  background: linear-gradient(135deg, #1d1433, #151f38, #1d1433);
  background-size: 200% 200%;
  border-color: #4c3575;
  animation: sea-waves 4s ease infinite;
}
.boat-anim { animation: boat-anim 1.8s ease-in-out infinite !important; }
.activity-tip {
  position: absolute; bottom: calc(100% + 6px); left: 0;
  width: 260px; padding: 8px 10px; border-radius: 6px;
  background: #141120; border: 1px solid #352954; box-shadow: 0 12px 30px rgba(0,0,0,0.5);
  font-size: 11px; color: var(--text-soft); display: none; z-index: 60;
}
.activity-badge:hover .activity-tip { display: block; }
.activity-tip div { padding: 2px 0; }

.btn-primary {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 14px;
  border-radius: 6px;
  background: #1b172a;
  border: 1px solid #3b2d63;
  color: #c4b5fd;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease;
}
.btn-primary:hover { background: #252038; }
.btn-primary:active { transform: scale(0.97); }
.btn-primary.is-busy { border-color: #7f1d1d; color: #fca5a5; }
.stop-square { width: 8px; height: 8px; border-radius: 2px; background: var(--accent-purple); display: inline-block; }
.btn-primary.is-busy .stop-square { background: var(--accent-danger); }

.btn-secondary {
  padding: 5px 10px; border-radius: 6px;
  background: #1c192b; border: 1px solid var(--border-strong);
  color: #b5b1c9; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.btn-secondary:hover { background: #25213b; color: #fff; }
.btn-sm { padding: 4px 9px; border-radius: 6px; font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.btn-ok { background: #065f46; color: #d1fae5; border-color: #047857; }
.btn-ok:hover { background: #047857; }
.btn-danger { background: #7f1d1d; color: #fee2e2; border-color: #991b1b; }
.btn-danger:hover { background: #991b1b; }
.btn-primary.btn-sm { background: #7c3aed; color: #fff; }
.btn-primary.btn-sm:hover { background: #6d28d9; }

/* Attachments */
.attachment-tray { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #181625; }
.attach-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; border-radius: 6px; background: #161422; border: 1px solid #2a263d; font-size: 11px; font-family: var(--font-mono); color: var(--text-soft); }
.attach-chip button { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
.attach-chip button:hover { color: var(--accent-danger); }
.attach-size { color: var(--text-dim); }

/* ===================== Status strip ===================== */
.status-strip { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 2px 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-wrap: wrap; }
.status-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.status-right { display: flex; align-items: center; gap: 8px; }
.status-item { display: inline-flex; align-items: center; gap: 5px; }
.status-anchor { color: var(--accent-purple); display: inline-flex; }
.status-anchor svg { width: 14px; height: 14px; }
.status-thinking.is-busy .status-anchor { animation: boat 1.6s ease-in-out infinite; }
.status-divider { color: #2f2b42; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; background: #14121f; border: 1px solid #252238; color: var(--text-soft); max-width: 320px; }
.chip-folder { display: inline-flex; }
.chip-folder svg { width: 14px; height: 14px; }
.chip-sep { color: #8e8a9f; }
.chip #workspacePath { color: #b5b1c9; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-btn { background: none; border: none; padding: 0; font: inherit; color: #fff; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; max-width: 260px; overflow: hidden; }
.link-btn:hover { text-decoration: underline; }
.link-btn #activeModelName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.caret { color: var(--text-muted); font-size: 11px; }
.mcp-btn { display: inline-flex; align-items: center; gap: 7px; padding: 4px 9px; border-radius: 6px; background: #151221; border: 1px solid #2d2646; color: var(--text-soft); font-family: inherit; font-size: 12px; cursor: pointer; }
.mcp-btn:hover { background: #1e1930; }
.mcp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-purple); }
.mcp-btn.is-zero .mcp-dot { background: #4b5563; }
.mcp-label { font-weight: 600; letter-spacing: 0.04em; }
.mcp-count { padding: 1px 6px; border-radius: 4px; background: #271e42; border: 1px solid rgba(76,53,117,0.6); color: #c4b5fd; font-size: 11px; font-weight: 600; }

/* ===================== Popovers ===================== */
.popover {
  position: fixed;
  z-index: 80;
  background: #12101c;
  border: 1px solid #2a2440;
  border-radius: 10px;
  box-shadow: 0 18px 44px rgba(0,0,0,0.55);
  font-family: var(--font-sans);
  overflow: hidden;
}
.popover-models { width: 320px; }
.popover-mcp { width: 290px; }
.popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; font-size: 12px; font-weight: 600; color: #fff; border-bottom: 1px solid #1f1b30; }
.popover-body { padding: 6px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.popover-item { padding: 7px 9px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; }
.popover-item:hover { background: #181528; }
.popover-item.is-current { background: #1d1730; border-color: #3b2d63; }
.popover-item-name { font-family: var(--font-mono); font-size: 12px; color: #fff; overflow: hidden; text-overflow: ellipsis; }
.popover-item-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.popover-item-engine { font-size: 11px; font-family: var(--font-mono); color: var(--accent-purple); }
.popover-empty { padding: 12px; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
.mcp-popover-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; background: #0c0b12; border: 1px solid #1f1b30; }
.mcp-popover-detail { font-size: 11px; color: var(--text-dim); line-height: 1.4; margin-top: 2px; }

/* ===================== Modals ===================== */
.modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(0,0,0,0.62); backdrop-filter: blur(3px); }
.modal-card { width: 100%; max-width: 420px; background: #14121f; border: 1px solid #31274f; border-radius: 10px; box-shadow: 0 24px 60px rgba(0,0,0,0.6); padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.modal-wide { max-width: 560px; }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.modal-title { font-size: 14px; font-weight: 600; color: #fff; display: inline-flex; align-items: center; gap: 8px; }
.modal-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-purple); }
.modal-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.modal-hint { margin-right: auto; font-size: 12px; color: var(--text-dim); }
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: #b5b1c9; }
.field input {
  width: 100%;
  background: #0c0b12;
  border: 1px solid #2a2440;
  border-radius: 6px;
  padding: 8px 10px;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
}
.field input:focus { border-color: var(--accent-purple); }
.attach-list { max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border-soft); border-radius: 10px; padding: 6px; }
.attach-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); cursor: pointer; }
.attach-row:hover { background: #181528; color: #fff; }
.attach-row.is-attached { background: rgba(139,92,246,0.14); color: var(--accent-purple-soft); }
.attach-row-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ===================== Toasts ===================== */
.toast-host { position: fixed; right: 18px; bottom: 18px; z-index: 120; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.toast { background: #14121f; border: 1px solid var(--accent-purple); color: var(--text); padding: 9px 14px; border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,0.5); font-size: 12px; max-width: 380px; opacity: 1; transition: opacity 250ms ease; }
.toast.is-error { border-color: var(--accent-danger); color: #fca5a5; }
.toast.is-fading { opacity: 0; }
.toast { display: flex; align-items: center; gap: 12px; }
.toast-action {
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid var(--accent-purple);
  color: var(--accent-purple);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.toast-action:hover { background: rgba(167,139,250,0.14); }
.toast-action:focus-visible { outline: 2px solid var(--accent-purple); outline-offset: 2px; }

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

/* ===================== Responsive ===================== */
@media (max-width: 1000px) {
  .app-sidebar { position: absolute; left: 0; top: 0; bottom: 0; z-index: 50; box-shadow: 0 18px 44px rgba(0,0,0,0.55); }
  .app-sidebar.is-collapsed { box-shadow: none; }
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
    modelChoice: null,
    mcp: { connected: 0, total: 0, transportUp: false, servers: [] },
    mode: 'chat',
    busy: false,
    streaming: false,
    streamingText: '',
    liveBody: null,
    attachments: [],
    tasks: {},
    activeRunId: null,
    selectedRunId: null,
    dagViewMode: 'flow',
    filesTabMode: 'files',
    fileList: [],
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
    isRecordingVoice: false
  };

  // ---------------------------------------------------------------- utils
  function el(id) { return document.getElementById(id); }

  function apiHeaders() {
    return { 'Content-Type': 'application/json', 'X-Pluton-Token': token };
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    var url = new URL(path, window.location.origin);
    if (token) url.searchParams.set('token', token);
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
    return html;
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
      head.innerHTML = '<span class="msg-avatar">' + USER_ICON + '</span><span class="msg-you">You</span>';
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
    return (box.scrollHeight - box.scrollTop - box.clientHeight) < 90;
  }

  function maybeScroll(force) {
    var box = el('chatScrollContainer');
    if (!box) return;
    if (force || isNearBottom()) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function appendMessage(role, html, extraClass) {
    var list = el('messagesList');
    if (!list) return null;
    var node = buildMessage(role, html, extraClass);
    list.appendChild(node);
    maybeScroll(false);
    return node;
  }

  function appendPlain(role, text, extraClass) {
    return appendMessage(role, renderMarkdown(text), extraClass);
  }

  function renderTranscript(messages) {
    var list = el('messagesList');
    if (!list) return;
    list.innerHTML = '';
    state.liveBody = null;
    state.streamingText = '';
    if (!messages || messages.length === 0) {
      var hint = document.createElement('div');
      hint.className = 'msg msg-system';
      hint.innerHTML = '<div class="msg-body">No messages in this session yet. Ask Pluton to plan, implement, or investigate.</div>';
      list.appendChild(hint);
      return;
    }
    messages.forEach(function (msg) {
      if (msg.role === 'tool') {
        appendToolEvent({ name: 'tool', summary: msg.text, status: 'succeeded', output: '' });
      } else if (msg.role === 'system') {
        appendPlain('system', msg.text);
      } else {
        appendPlain(msg.role === 'user' ? 'user' : 'assistant', msg.text);
      }
    });
    maybeScroll(true);
  }

  function appendToolEvent(tool) {
    var list = el('messagesList');
    if (!list) return;
    var card = document.createElement('div');
    card.className = 'tool-card';
    var status = tool.status || 'running';
    var head = '<div class="tool-card-head"><div class="tool-name">' +
      escapeHtml(tool.name || 'tool') +
      (tool.summary && tool.summary !== tool.name ? ' <span class="muted">(' + escapeHtml(tool.summary) + ')</span>' : '') +
      '</div><span class="tool-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></div>';
    var body = tool.output ? '<div class="tool-card-body">' + escapeHtml(tool.output) + '</div>' : '';
    card.innerHTML = head + body;
    list.appendChild(card);
    maybeScroll(false);
  }

  function appendStreamingToken(text) {
    var list = el('messagesList');
    if (!list) return;
    if (!state.liveBody) {
      var node = buildMessage('assistant', '');
      list.appendChild(node);
      state.liveBody = node.querySelector('.msg-body');
      state.streamingText = '';
    }
    state.streamingText += text;
    state.liveBody.innerHTML = renderMarkdown(state.streamingText) + '<span class="caret-blink"></span>';
    maybeScroll(false);
  }

  function finalizeStreamingTurn(interrupted, failed) {
    if (state.liveBody) {
      var note = failed
        ? '<div class="msg-error">[Turn failed]</div>'
        : (interrupted ? '<div class="muted">[Turn interrupted by operator]</div>' : '');
      state.liveBody.innerHTML = renderMarkdown(state.streamingText) + note;
      state.liveBody = null;
    }
    state.streamingText = '';
  }

  // ------------------------------------------------------------------ SSE
  var eventSource = null;

  function connectSSE() {
    if (eventSource) eventSource.close();
    var sseUrl = new URL('/api/events', window.location.origin);
    if (token) sseUrl.searchParams.set('token', token);
    eventSource = new EventSource(sseUrl.toString());
    eventSource.onopen = function () {
      var conn = el('connectionStatus');
      if (conn) {
        conn.classList.remove('is-offline');
        conn.querySelector('.conn-label').textContent = 'Connected';
      }
    };
    eventSource.onerror = function () {
      var conn = el('connectionStatus');
      if (conn) {
        conn.classList.add('is-offline');
        conn.querySelector('.conn-label').textContent = 'Reconnecting\\u2026';
      }
    };
    eventSource.onmessage = function (e) {
      var ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      handleServerEvent(ev);
    };
  }

  function handleServerEvent(ev) {
    if (ev.type === 'token' && ev.sessionId === state.activeSessionId) {
      appendStreamingToken(ev.text);
    } else if (ev.type === 'tool' && ev.sessionId === state.activeSessionId) {
      appendToolEvent(ev.tool);
    } else if (ev.type === 'turn_start' && ev.sessionId === state.activeSessionId) {
      setBusy(true);
    } else if (ev.type === 'turn_end' && ev.sessionId === state.activeSessionId) {
      finalizeStreamingTurn(ev.interrupted, ev.failed);
      setBusy(false);
    } else if (ev.type === 'usage' && ev.sessionId === state.activeSessionId) {
      updateUsage(ev);
    } else if (ev.type === 'approval_requested') {
      showPendingApproval(ev.approval);
      loadApprovals();
    } else if (ev.type === 'approval_decided') {
      if (state.pendingApprovalId === ev.approval.id) hidePendingApproval();
      loadApprovals();
    } else if (ev.type === 'run_state') {
      state.activeRunId = ev.runId;
      applyRunState(ev.state, ev.goal);
      refreshActiveRun();
    } else if (ev.type === 'task_state') {
      state.tasks[ev.taskId] = { id: ev.taskId, title: ev.title, state: ev.state, runId: ev.runId };
      if (ev.runId) state.activeRunId = ev.runId;
      updateActivityBadge();
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
      meta.textContent = formatTime(s.updatedAt || s.createdAt);
      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener('click', function () { selectSession(s.id); });
      list.appendChild(item);
    });
  }

  async function selectSession(sessionId) {
    state.activeSessionId = sessionId;
    renderSessions();
    try {
      var res = await apiFetch('/api/sessions/' + encodeURIComponent(sessionId));
      state.messages = res.session.messages || [];
      state.muse = res.session.activeMuse || null;
      renderTranscript(state.messages);
      applyMuseModel();
      // A reload during an in-flight turn must show the real state, not a
      // false "ready": the server reports whether the engine is still busy.
      setBusy(res.session.busy === true);
    } catch (err) {
      toast('Failed to load session: ' + err.message, true);
    }
  }

  async function createNewSession(title) {
    try {
      var res = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: title || ('Session ' + (state.sessions.length + 1)),
          museId: state.muse ? state.muse.id : undefined
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
    if (modal) modal.classList.remove('is-hidden');
    if (input) { input.value = ''; input.focus(); }
  }

  function closeNewSessionModal() {
    var modal = el('newSessionModal');
    if (modal) modal.classList.add('is-hidden');
  }

  function confirmCreateSession() {
    var input = el('newSessionNameInput');
    var name = input && input.value.trim() ? input.value.trim() : ('Session ' + (state.sessions.length + 1));
    closeNewSessionModal();
    createNewSession(name);
  }

  // ------------------------------------------------------------- workspace
  async function loadWorkspace() {
    try {
      var res = await apiFetch('/api/workspace');
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
          kvRow('Muses', String((state.workspace.muses || []).length)) +
          kvRow('Default branch', state.workspace.defaultBranch) +
          kvRow('Pending approvals', String(state.workspace.approvalsPending || 0)) +
          kvRow('Active run', state.workspace.activeRun ? state.workspace.activeRun.state : 'none');
      }
      if (state.workspace.activeRun) {
        state.activeRunId = state.workspace.activeRun.id;
      }
      renderMuseModels();
      renderPermissions();
      refreshActiveRun();
    } catch (err) {
      toast('Failed to load workspace: ' + err.message, true);
    }
  }

  function kvRow(key, value) {
    return '<div class="kv-row"><span class="kv-key">' + escapeHtml(key) +
      '</span><span class="kv-val" title="' + escapeHtml(value) + '">' + escapeHtml(value) + '</span></div>';
  }

  // ----------------------------------------------------------------- MCP
  async function loadMcp() {
    try {
      var res = await apiFetch('/api/mcp');
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
    } catch (err) {
      var node = el('modelRegistry');
      if (node) node.innerHTML = '<div class="empty-hint">Failed to read the model registry: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function modelEntries() {
    var out = [];
    Object.keys(state.models).forEach(function (engine) {
      (state.models[engine] || []).forEach(function (m) {
        out.push({ engine: engine, id: m.id, label: m.label || m.id, source: m.source });
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
        '" data-engine="' + escapeHtml(m.engine) + '"><div class="popover-item-name">' + escapeHtml(m.label) +
        '</div><div class="popover-item-engine">' + escapeHtml(m.engine) + '</div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.popover-item'), function (node) {
      node.addEventListener('click', function () {
        switchModel(node.getAttribute('data-model'));
      });
    });
  }

  function applyMuseModel() {
    var node = el('activeModelName');
    if (node) node.textContent = state.muse ? state.muse.model : '\\u2014';
    var badge = el('modelRegistry');
    renderModelRegistry();
  }

  async function switchModel(modelId) {
    if (!state.muse) {
      toast('No active Muse: open a session first.', true);
      return;
    }
    if (state.muse.model === modelId) {
      toggleModelPopover(false);
      return;
    }
    var previous = state.muse.model;
    var museId = state.muse.id;
    try {
      await apiFetch('/api/muses/' + encodeURIComponent(state.muse.id) + '/model', {
        method: 'POST',
        body: JSON.stringify({ model: modelId })
      });
      state.muse.model = modelId;
      applyMuseModel();
      toggleModelPopover(false);
      // Switching back to the model that was active before is a real inverse:
      // the engine offered it, it was running, and the same endpoint applies
      // it. No other operation in this UI has a safe inverse.
      toast('Model switched to ' + modelId, false, {
        label: 'Undo',
        run: function () { switchMuseModel(museId, previous); },
      });
    } catch (err) {
      toast('Model switch failed: ' + err.message, true);
    }
  }

  // ------------------------------------------------------ muse model cards
  function renderMuseModels() {
    var node = el('museModelList');
    if (!node || !state.workspace) return;
    var muses = state.workspace.muses || [];
    if (muses.length === 0) {
      node.innerHTML = '<div class="empty-hint">No Muse configured.</div>';
      return;
    }
    var engineModels = state.models || {};
    node.innerHTML = muses.map(function (m) {
      var options = engineModels[m.engine] || [];
      var opts = options.map(function (opt) {
        var id = opt.id;
        return '<option value="' + escapeHtml(id) + '"' + (id === m.model ? ' selected' : '') + '>' +
          escapeHtml(opt.label || id) + '</option>';
      }).join('');
      if (options.length === 0 || !options.some(function (o) { return o.id === m.model; })) {
        opts = '<option value="' + escapeHtml(m.model) + '" selected>' + escapeHtml(m.model) + '</option>' + opts;
      }
      return '<div class="muse-row"><div class="muse-row-head"><span class="muse-name">' + escapeHtml(m.displayName) +
        '</span><span class="muse-role">' + escapeHtml(m.role) + ' \\u00b7 ' + escapeHtml(m.engine) + '</span></div>' +
        '<select class="mini-select" data-muse="' + escapeHtml(m.id) + '">' + opts + '</select></div>';
    }).join('');
    Array.prototype.forEach.call(node.querySelectorAll('select'), function (sel) {
      sel.addEventListener('change', function () {
        switchMuseModel(sel.getAttribute('data-muse'), sel.value);
      });
    });
  }

  async function switchMuseModel(museId, modelId) {
    var previous = null;
    if (state.muse && state.muse.id === museId) previous = state.muse.model;
    else if (state.workspace) {
      var prior = (state.workspace.muses || []).filter(function (m) { return m.id === museId; })[0];
      if (prior) previous = prior.model;
    }
    try {
      await apiFetch('/api/muses/' + encodeURIComponent(museId) + '/model', {
        method: 'POST',
        body: JSON.stringify({ model: modelId })
      });
      if (state.muse && state.muse.id === museId) {
        state.muse.model = modelId;
        applyMuseModel();
      }
      if (state.workspace) {
        state.workspace.muses = state.workspace.muses.map(function (m) {
          return m.id === museId ? Object.assign({}, m, { model: modelId }) : m;
        });
        renderMuseModels();
      }
      toast('Model switched to ' + modelId, false, previous && previous !== modelId ? {
        label: 'Undo',
        run: function () { switchMuseModel(museId, previous); },
      } : null);
    } catch (err) {
      toast('Model switch failed: ' + err.message, true);
      await loadWorkspace();
    }
  }

  function renderPermissions() {
    var node = el('permissionsList');
    if (!node || !state.workspace) return;
    var muses = state.workspace.muses || [];
    if (muses.length === 0) {
      node.innerHTML = '<div class="empty-hint">No Muse configured.</div>';
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
      var pending = all.filter(function (a) { return a.status === 'pending'; });
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
    if (reason) reason.textContent = approval.reason || ('Requested by ' + (approval.requestedByMuse || 'agent'));
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

  // ------------------------------------------------------------ orchestra
  async function loadRunDetail(runId) {
    if (!runId) {
      renderOrchestra(null, [], []);
      return;
    }
    try {
      var res = await apiFetch('/api/runs/' + encodeURIComponent(runId));
      renderOrchestra(res.run.run, res.run.tasks || [], res.run.edges || []);
    } catch (err) {
      renderOrchestra(null, [], []);
    }
  }

  async function refreshActiveRun() {
    await loadRunDetail(state.activeRunId);
  }

  function renderOrchestra(run, tasks, edges) {
    var node = el('activeRunCard');
    if (node) {
      if (!run) {
        node.innerHTML = '<div class="empty-hint">No active run in this workspace.</div>';
      } else {
        var muses = (state.workspace && state.workspace.muses) || [];
        node.innerHTML =
          '<div class="orchestra-row"><span>Run</span><span class="mono">' + escapeHtml(run.id) + '</span></div>' +
          '<div class="orchestra-row"><span>Goal</span><span>' + escapeHtml(run.goal) + '</span></div>' +
          '<div class="orchestra-row"><span>State</span><span class="badge ' + (run.state === 'completed' ? 'badge-ok' : run.state === 'failed' ? 'badge-off' : 'badge-warn') + '">' + escapeHtml(run.state) + '</span></div>' +
          '<div class="orchestra-row"><span>Tasks</span><span>' + tasks.length + ' (' + tasks.filter(function (t) { return t.state === 'completed'; }).length + ' done)</span></div>' +
          '<div class="orchestra-row"><span>Team</span><span>' + muses.length + ' muses</span></div>';
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
      return '<div class="dag-task-card state-' + escapeHtml(t.state) + '"><div class="dag-card-header">' +
        '<div class="dag-task-title">' + escapeHtml(t.title) + '</div>' +
        '<span class="tool-status ' + pill + '">' + escapeHtml(t.state) + '</span></div>' +
        '<div class="dag-task-meta"><span>' + escapeHtml(t.assigneeMuseId || 'coordinator') + '</span>' +
        '<span>' + escapeHtml(t.id) + '</span></div>' +
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
  var FILE_ICON = '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
  var DIR_ICON = '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>';
  var CHEV_ICON = '<svg class="file-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';

  function buildFileTree(paths) {
    var root = { dirs: {}, files: [] };
    paths.forEach(function (p) {
      var parts = String(p).split('/').filter(Boolean);
      if (parts.length === 0) return;
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var seg = parts[i];
        if (!node.dirs[seg]) node.dirs[seg] = { dirs: {}, files: [] };
        node = node.dirs[seg];
      }
      node.files.push({ name: parts[parts.length - 1], path: p });
    });
    return root;
  }

  function countTreeFiles(node) {
    var n = node.files.length;
    Object.keys(node.dirs).forEach(function (k) { n += countTreeFiles(node.dirs[k]); });
    return n;
  }

  function renderFileTree(paths) {
    var root = buildFileTree(paths);
    var html = '';
    Object.keys(root.dirs).sort().forEach(function (name) {
      var dir = root.dirs[name];
      html += '<div class="file-row file-dir" role="treeitem" aria-expanded="true">' +
        CHEV_ICON + DIR_ICON +
        '<span class="file-name">' + escapeHtml(name) + '</span>' +
        '<span class="file-count">' + countTreeFiles(dir) + '</span>' +
        '</div>';
      html += '<div class="file-children">' + renderFileTreeNode(dir) + '</div>';
    });
    root.files.sort().forEach(function (f) { html += renderFileRow(f, 0); });
    return html;
  }

  function renderFileTreeNode(node) {
    var html = '';
    Object.keys(node.dirs).sort().forEach(function (name) {
      var dir = node.dirs[name];
      html += '<div class="file-row file-dir" role="treeitem" aria-expanded="true">' +
        CHEV_ICON + DIR_ICON +
        '<span class="file-name">' + escapeHtml(name) + '</span>' +
        '<span class="file-count">' + countTreeFiles(dir) + '</span>' +
        '</div>';
      html += '<div class="file-children">' + renderFileTreeNode(dir) + '</div>';
    });
    node.files.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) {
      html += renderFileRow(f, 1);
    });
    return html;
  }

  function renderFileRow(f, depth) {
    return '<div class="file-row file-item" data-path="' + escapeHtml(f.path) + '" title="' + escapeHtml(f.path) + '" role="treeitem">' +
      FILE_ICON +
      '<span class="file-name">' + escapeHtml(f.name) + '</span>' +
      '</div>';
  }

  function bindFileTree(list) {
    Array.prototype.forEach.call(list.querySelectorAll('.file-dir'), function (row) {
      row.classList.add('is-open');
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        var kids = row.nextElementSibling;
        if (!kids || !kids.classList.contains('file-children')) return;
        var collapsed = kids.classList.toggle('is-collapsed');
        row.classList.toggle('is-open', !collapsed);
        row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('.file-item'), function (row) {
      row.addEventListener('click', function () {
        Array.prototype.forEach.call(list.querySelectorAll('.file-item'), function (i) { i.classList.remove('is-active'); });
        row.classList.add('is-active');
        openFile(row.getAttribute('data-path'));
      });
    });
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

  async function loadFilesList() {
    var list = el('filesList');
    if (list) list.innerHTML = '<div class="empty-hint">Loading files\\u2026</div>';
    try {
      var res = await apiFetch('/api/files');
      state.fileList = res.files || [];
      var listNode = el('filesList');
      if (!listNode) return;
      if (state.fileList.length === 0) {
        listNode.innerHTML = '<div class="empty-hint">No files in the workspace.</div>';
        return;
      }
      listNode.innerHTML = renderFileTree(state.fileList);
      bindFileTree(listNode);
    } catch (err) {
      renderFileListError(el('filesList'), err.message, function () { loadFilesList(); });
    }
  }

  async function openFile(path) {
    try {
      var res = await apiFetch('/api/files/content?path=' + encodeURIComponent(path));
      var preview = el('filePreview');
      var nameNode = el('activeFileName');
      var bodyNode = el('fileCodeBody');
      if (nameNode) nameNode.textContent = path;
      if (bodyNode) bodyNode.textContent = res.content || '';
      if (preview) preview.classList.remove('is-hidden');
    } catch (err) {
      toast('Failed to read ' + path + ': ' + err.message, true);
    }
  }

  function renderDiffContent(diffText, title) {
    var header = el('activeFileName');
    var bodyNode = el('fileCodeBody');
    var preview = el('filePreview');
    if (header) header.textContent = title;
    if (preview) preview.classList.remove('is-hidden');
    if (!bodyNode) return;
    if (!diffText || diffText.trim() === '') {
      bodyNode.innerHTML = '<span class="muted">// No changes</span>';
      return;
    }
    var lines = diffText.split('\\n');
    bodyNode.innerHTML = lines.map(function (l) {
      var escaped = escapeHtml(l);
      if (l.startsWith('+') && !l.startsWith('+++')) return '<span class="tok-st">' + escaped + '</span>';
      if (l.startsWith('-') && !l.startsWith('---')) return '<span class="tok-cm">' + escaped + '</span>';
      if (l.startsWith('@@')) return '<span class="tok-kw">' + escaped + '</span>';
      return '<span>' + escaped + '</span>';
    }).join('\\n');
  }

  async function loadDiffsTab(runId) {
    var list = el('filesList');
    if (!list) return;
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
  function setBusy(busy, busyLabel) {
    state.busy = busy;
    var btn = el('btnPrimary');
    var label = el('actionBtnLabel');
    var thinking = el('thinkingStatus');
    var text = el('thinkingText');
    if (btn) btn.classList.toggle('is-busy', busy);
    if (label) label.textContent = busy ? 'Stop' : 'Send';
    if (thinking) thinking.classList.toggle('is-busy', busy);
    if (text) text.textContent = busy ? (busyLabel || 'Thinking\\u2026') : 'Ready';
    updateActivityBadge();
  }

  function setMode(mode) {
    state.mode = mode;
    var chat = el('modeChatBtn');
    var build = el('modeBuildBtn');
    if (chat) chat.classList.toggle('is-active', mode === 'chat');
    if (build) build.classList.toggle('is-active', mode === 'build');
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
  function applyRunState(runState, goal) {
    var runId = state.activeRunId;
    if (!runId) return;
    if (TERMINAL_RUN_STATES[runState]) {
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
      appendPlain('system', 'Build ' + labels[runState] + ' - run ' + runId + (goal ? ': ' + goal : ''), cls);
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
    if (!text || state.busy) return;
    if (state.mode === 'build') {
      // A supervised build provisions containers and spends engine tokens, so
      // it is dispatched only after an explicit confirmation.
      openBuildConfirm(text);
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
    input.value = '';
    clearAttachments();
    // The bubble shows what the operator typed plus the attachment list; the
    // inlined file bodies travel to the engine, they do not drown the echo.
    appendPlain('user', text + (attached ? '\\n\\n*Attached: ' + attached + '*' : ''));
    setBusy(true);
    try {
      await apiFetch('/api/sessions/' + encodeURIComponent(state.activeSessionId) + '/prompt', {
        method: 'POST',
        body: JSON.stringify({ text: full })
      });
    } catch (err) {
      appendPlain('system', '[Error dispatching prompt: ' + err.message + ']', 'msg-error');
      setBusy(false);
    }
  }

  /**
   * Show the supervised-build confirmation.
   *
   * The panel names the workspace and the operation so the operator can see
   * WHAT would run and WHERE, and nothing is dispatched until "Start build"
   * is pressed. The prompt text stays in the composer until then, so
   * cancelling the confirmation loses nothing.
   */
  function openBuildConfirm(goal) {
    if (state.buildConfirmOpen || state.buildDispatching) return;
    var panel = el('buildConfirm');
    if (!panel) return;
    var wsNode = el('buildConfirmWorkspace');
    var goalNode = el('buildConfirmGoal');
    var ws = state.workspace || {};
    if (wsNode) wsNode.textContent = ws.rootDir || (ws.name ? ws.name : 'unknown workspace');
    if (goalNode) goalNode.textContent = goal;
    state.pendingBuildGoal = goal;
    panel.classList.remove('is-hidden');
    state.buildConfirmOpen = true;
    var start = el('btnBuildConfirmStart');
    if (start) start.focus();
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

  async function startBuild(goal) {
    var input = el('promptInput');
    input.value = '';
    clearAttachments();
    appendPlain('user', goal);
    state.buildDispatching = true;
    setBusy(true);
    try {
      var res = await apiFetch('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ goal: goal })
      });
      var runId = res.run.id;
      state.activeRunId = runId;
      state.settledRunId = null;
      appendPlain('system', 'Build started \\u2014 run ' + runId + ' (' + res.run.state + '). The manager Muse plans and delegates to the team.');
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
      }
    } catch (err) {
      toast('Cancel failed: ' + err.message, true);
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
      var res = await apiFetch('/api/files');
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
      var res = await apiFetch('/api/files/content?path=' + encodeURIComponent(path));
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
    var working = Object.keys(state.tasks).filter(function (id) {
      var t = state.tasks[id];
      return t.state === 'running' || t.state === 'active';
    });
    var isWorking = working.length > 0 || state.busy || state.streaming;
    if (!isWorking) {
      badge.classList.add('is-hidden');
      return;
    }
    badge.classList.remove('is-hidden');
    var text = el('shipCountText');
    var shipCount = working.length > 0 ? working.length : (state.mode === 'build' ? 3 : 1);
    if (text) text.textContent = shipCount + ' Ship' + (shipCount > 1 ? 's' : '') + ' working';
    var tip = el('shipActivityTooltip');
    if (tip) {
      tip.innerHTML = '<div style="font-weight:600;color:#fff;border-bottom:1px solid #241e38;padding-bottom:3px;">Active Ship Tasks</div>' +
        (working.length > 0
          ? working.map(function (id) { return '<div>\\u2693 ' + escapeHtml(state.tasks[id].title || id) + '</div>'; }).join('')
          : '<div>\\u2693 ' + (state.mode === 'build' ? 'Team orchestration in progress\\u2026' : 'Prompt turn execution in progress\\u2026') + '</div>');
    }
  }

  // -------------------------------------------------------------- popovers
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
    var modal = el('attachModal');
    if (modal && !modal.classList.contains('is-hidden')) {
      closeAttachModal();
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
      sidebar.style.width = state.sidebarTab === 'settings' ? '440px' : state.sidebarWidth;
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
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    });
  }

  function bindControls() {
    var newBtn = el('btnNewSession');
    if (newBtn) newBtn.addEventListener('click', openNewSessionModal);
    var newConfirm = el('newSessionConfirm');
    if (newConfirm) newConfirm.addEventListener('click', confirmCreateSession);
    var newCancel = el('newSessionCancel');
    if (newCancel) newCancel.addEventListener('click', closeNewSessionModal);
    var newClose = el('newSessionClose');
    if (newClose) newClose.addEventListener('click', closeNewSessionModal);
    var newInput = el('newSessionNameInput');
    if (newInput) {
      newInput.addEventListener('keydown', function (e) {
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
        closeBuildConfirm(false);
        await startBuild(goal);
      });
    }
    var buildCancel = el('btnBuildConfirmCancel');
    if (buildCancel) buildCancel.addEventListener('click', function () { closeBuildConfirm(true); });

    // Escape dismisses the nearest overlay and puts the keyboard back where
    // it was.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (!closeTopOverlay()) return;
      e.preventDefault();
      e.stopPropagation();
    });

    var chatMode = el('modeChatBtn');
    if (chatMode) chatMode.addEventListener('click', function () { setMode('chat'); });
    var buildMode = el('modeBuildBtn');
    if (buildMode) buildMode.addEventListener('click', function () { setMode('build'); });

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

    var toggleKeyBtn = el('btnToggleApiKey');
    if (toggleKeyBtn) toggleKeyBtn.addEventListener('click', handleToggleApiKey);
    var verifyAddBtn = el('btnVerifyAddCustomModel');
    if (verifyAddBtn) verifyAddBtn.addEventListener('click', verifyAndAddCustomModel);

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
    if (modelBtn) modelBtn.addEventListener('click', function () { toggleModelPopover(); });
    var mcpBtn = el('mcpToggleBtn');
    if (mcpBtn) mcpBtn.addEventListener('click', function () { toggleMcpPopover(); });

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
      var target = e.target;
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
    connectSSE();
    try {
      await loadWorkspace();
      await loadSessions();
      await loadModels();
      await loadMcp();
      await loadApprovals();
      await loadSettings();
      var queryTab = urlParams.get('tab');
      if (queryTab) {
        switchSidebarTab(queryTab);
      }
    } catch (err) {
      console.error('Initialization error:', err);
      toast('Initialization failed: ' + err.message, true);
    }
    setInterval(loadMcp, MCP_POLL_MS);
  }

  init();
})();
`,
  },
}
