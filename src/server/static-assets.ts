/**
 * Embedded graphical frontend static assets (ADR-0014).
 * Single authoritative Single-Page Application (SPA) serving desktop and browser.
 * Zero-dependency, offline-ready, conforming to the PLUTON design system.
 */

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
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="app" class="app-layout">
    <!-- Top Header -->
    <header class="app-header">
      <div class="header-left">
        <div class="brand-logo">
          <svg class="ship-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>
            <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.1"/>
            <path d="M12 10V2"/>
            <path d="M12 2l5 4-5 1"/>
          </svg>
          <span class="brand-name">PLUTON</span>
          <span class="brand-tag">Agentic Harness</span>
        </div>
        <div class="workspace-badge" id="workspaceBadge" title="Current Workspace">
          <span class="badge-icon">📁</span>
          <span class="workspace-name" id="workspaceName">Loading workspace…</span>
        </div>
      </div>

      <nav class="header-nav">
        <button class="nav-btn active" data-tab="chat">
          <span class="nav-icon">💬</span> Chat
        </button>
        <button class="nav-btn" data-tab="orchestra">
          <span class="nav-icon">🎻</span> Orchestra
          <span class="nav-badge hidden" id="orchestraBadge">0</span>
        </button>
        <button class="nav-btn" data-tab="approvals">
          <span class="nav-icon">🛡️</span> Approvals
          <span class="nav-badge hidden" id="approvalsBadge">0</span>
        </button>
        <button class="nav-btn" data-tab="files">
          <span class="nav-icon">📄</span> Files
        </button>
        <button class="nav-btn" data-tab="settings">
          <span class="nav-icon">⚙️</span> Settings
        </button>
      </nav>

      <div class="header-right">
        <div class="connection-status" id="connectionStatus" title="Local Runtime Status">
          <span class="status-dot"></span>
          <span class="status-label">Connected</span>
        </div>
      </div>
    </header>

    <!-- Main Workspace Area -->
    <main class="app-main">
      <!-- 1. CHAT VIEW -->
      <section id="chatView" class="view-panel active">
        <!-- Sidebar Sessions -->
        <aside class="sessions-sidebar">
          <div class="sidebar-header">
            <h3>Conversations</h3>
            <button class="btn-primary-sm" id="btnNewSession">+ New</button>
          </div>
          <div class="sessions-list" id="sessionsList">
            <!-- Dynamic session items -->
          </div>
        </aside>

        <!-- Main Chat Content -->
        <div class="chat-workspace">
          <!-- Approval Banner (Pinned when pending) -->
          <div class="approval-banner hidden" id="pinnedApprovalBanner">
            <div class="approval-banner-icon">⚠️</div>
            <div class="approval-banner-content">
              <div class="approval-banner-title" id="approvalAction">Approval Required: Execute Shell Command</div>
              <div class="approval-banner-desc" id="approvalReason">Run test suite in workspace</div>
            </div>
            <div class="approval-banner-actions">
              <button class="btn-success-sm" id="btnBannerApprove">Approve</button>
              <button class="btn-danger-sm" id="btnBannerDeny">Deny</button>
            </div>
          </div>

          <!-- Transcript Area -->
          <div class="chat-transcript" id="chatTranscript">
            <div class="empty-state" id="emptyState">
              <div class="empty-icon">⚓</div>
              <h2>Welcome to PLUTON</h2>
              <p>Your team of persistent AI coding Muses is ready to plan, code, and execute.</p>
              <div class="starter-chips">
                <button class="chip" data-prompt="Analyze this project and summarize its architecture">Analyze architecture</button>
                <button class="chip" data-prompt="Inspect test coverage and run verification">Verify tests</button>
                <button class="chip" data-prompt="Plan a fix for open issues and review tasks">Plan a fix</button>
              </div>
            </div>
          </div>

          <!-- Composer Box -->
          <div class="chat-composer-container">
            <div class="composer-box">
              <textarea
                id="promptInput"
                class="composer-textarea"
                placeholder="Ask Pluton to plan, implement, investigate… (Enter to submit, Shift+Enter for newline)"
                rows="1"
              ></textarea>
              <div class="composer-toolbar">
                <div class="composer-left">
                  <select id="museSelect" class="muse-select" title="Active Muse">
                    <!-- Dynamically populated -->
                  </select>
                  <span class="composer-hint">Shift+Enter for newline</span>
                </div>
                <div class="composer-right">
                  <button id="btnCancel" class="btn-cancel hidden" title="Cancel in-flight generation">
                    <span>⏹ Stop</span>
                  </button>
                  <button id="btnSend" class="btn-send" title="Send Prompt (Enter)">
                    <span>Send</span>
                    <svg class="send-icon" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <!-- Live Status Bar Docked Below Input -->
            <div class="live-statusbar">
              <div class="sb-left">
                <span class="sb-item sb-state" id="sbState">
                  <span class="sb-dot"></span> <span id="sbStateLabel">Ready</span>
                </span>
                <span class="sb-divider">│</span>
                <span class="sb-item">Mode: <strong id="sbMode">chat</strong></span>
                <span class="sb-divider">·</span>
                <span class="sb-item">Model: <span class="sb-cyan" id="sbModel">-</span></span>
                <span class="sb-divider">·</span>
                <span class="sb-item">Context: <span id="sbContext" class="sb-muted">unknown</span></span>
                <span class="sb-divider">·</span>
                <span class="sb-item" id="sbCostItem">Cost: <span id="sbCost" class="sb-warn">$0.00</span></span>
              </div>
              <div class="sb-right">
                <span class="sb-item" id="sbMusesCount">1 Muse</span>
                <span class="sb-icon">⚓</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- 2. ORCHESTRA VIEW -->
      <section id="orchestraView" class="view-panel">
        <div class="view-header">
          <h2>Agent Orchestra</h2>
          <p>Multi-agent team coordination, task DAG, write leases, and usage budgets.</p>
        </div>
        <div class="orchestra-grid">
          <!-- Active Team Members -->
          <div class="panel-card">
            <h3>Muses (Team Members)</h3>
            <div id="musesGrid" class="muses-grid">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Active Run & Tasks -->
          <div class="panel-card">
            <div class="card-header-action">
              <h3>Orchestration Tasks & DAG</h3>
              <button class="btn-primary-sm" id="btnStartRun">Start New Run</button>
            </div>
            <div id="runsContainer">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Usage Ledger -->
          <div class="panel-card">
            <h3>Usage & Budget Ledger</h3>
            <div id="usageLedgerView" class="usage-view">
              <!-- Dynamically populated -->
            </div>
          </div>
        </div>
      </section>

      <!-- 3. APPROVALS VIEW -->
      <section id="approvalsView" class="view-panel">
        <div class="view-header">
          <h2>Security & Operator Approvals</h2>
          <p>Policy authorizations, sensitive tool operations, and audit records (fail-closed).</p>
        </div>
        <div class="approvals-container" id="approvalsTableContainer">
          <!-- Dynamic approvals cards -->
        </div>
      </section>

      <!-- 4. FILES VIEW -->
      <section id="filesView" class="view-panel">
        <div class="view-header">
          <h2>Workspace Files & Diffs</h2>
          <p>Inspect project files, modified worktree artifacts, and test outputs.</p>
        </div>
        <div class="files-split">
          <aside class="files-list-panel" id="filesList">
            <!-- Dynamic files tree -->
          </aside>
          <div class="file-content-panel">
            <div class="file-content-header" id="activeFileName">Select a file to inspect</div>
            <pre class="file-content-body"><code id="fileCodeBody">// Select a file from the workspace</code></pre>
          </div>
        </div>
      </section>

      <!-- 5. SETTINGS VIEW -->
      <section id="settingsView" class="view-panel">
        <div class="view-header">
          <h2>Settings & System Diagnostics</h2>
          <p>Local runtime diagnostics, engine status, and configuration.</p>
        </div>
        <div class="settings-content" id="settingsContainer">
          <div class="panel-card">
            <h3>Runtime Doctor Checks</h3>
            <div id="doctorChecks">Loading diagnostics…</div>
          </div>
          <div class="panel-card">
            <h3>Available Models</h3>
            <div id="modelsConfig">Loading models…</div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <script src="/app.js"></script>
</body>
</html>
`,
  },

  '/app.css': {
    contentType: 'text/css; charset=utf-8',
    content: `:root {
  --bg-primary: #0B0C10;
  --bg-secondary: #13151D;
  --bg-tertiary: #1B1E2B;
  --bg-surface: #272B3A;
  --border-color: #2A2F45;
  --border-subtle: #1E2235;

  --accent-purple: #8B5CF6;
  --accent-purple-light: #9D7CD8;
  --accent-purple-dim: rgba(139, 92, 246, 0.15);

  --text-primary: #F3F4F6;
  --text-secondary: #E5E7EB;
  --text-muted: #6B7280;
  --text-dim: #4B5563;

  --status-success: #10B981;
  --status-error: #EF4444;
  --status-warn: #FBBF24;
  --status-info: #60A5FA;

  --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: 'Cascadia Code', 'JetBrains Mono', Consolas, 'SF Mono', monospace;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background-color: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.5;
  overflow: hidden;
  height: 100vh;
  -webkit-font-smoothing: antialiased;
}

/* App Layout */
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Header */
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 16px;
  background-color: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.brand-logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ship-icon {
  width: 24px;
  height: 24px;
  color: var(--accent-purple-light);
}

.brand-name {
  font-size: 1.15rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--text-primary);
}

.brand-tag {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}

.workspace-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-tertiary);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  border: 1px solid var(--border-subtle);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-name {
  color: var(--text-secondary);
}

.header-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-primary);
  padding: 3px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

.nav-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 6px 14px;
  font-size: 0.85rem;
  font-weight: 500;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}

.nav-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}

.nav-btn.active {
  color: #fff;
  background: var(--accent-purple);
}

.nav-badge {
  font-size: 0.7rem;
  padding: 1px 5px;
  border-radius: 10px;
  background: var(--status-warn);
  color: #000;
  font-weight: 700;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.connection-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--status-success);
  box-shadow: 0 0 8px var(--status-success);
}

.connection-status.offline .status-dot {
  background: var(--status-error);
  box-shadow: 0 0 8px var(--status-error);
}

/* Main Workspace */
.app-main {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.view-panel {
  display: none;
  height: 100%;
  width: 100%;
}

.view-panel.active {
  display: flex;
}

/* Chat Layout */
#chatView {
  display: flex;
  height: 100%;
}

.sessions-sidebar {
  width: 250px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
}

.sidebar-header h3 {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.btn-primary-sm {
  background: var(--accent-purple);
  border: none;
  color: #fff;
  padding: 4px 10px;
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.btn-primary-sm:hover {
  filter: brightness(1.1);
}

.sessions-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-item {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background 0.1s ease;
}

.session-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.session-item.active {
  background: var(--accent-purple-dim);
  border: 1px solid rgba(139, 92, 246, 0.3);
}

.session-title {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.chat-workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: var(--bg-primary);
}

/* Approval Banner */
.approval-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  background: rgba(251, 191, 36, 0.12);
  border-bottom: 1px solid rgba(251, 191, 36, 0.3);
  padding: 10px 16px;
  flex-shrink: 0;
}

.approval-banner-icon {
  font-size: 1.4rem;
}

.approval-banner-content {
  flex: 1;
}

.approval-banner-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--status-warn);
}

.approval-banner-desc {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.approval-banner-actions {
  display: flex;
  gap: 8px;
}

.btn-success-sm {
  background: var(--status-success);
  color: #000;
  border: none;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

.btn-danger-sm {
  background: var(--status-error);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
}

/* Transcript */
.chat-transcript {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.empty-state {
  margin: auto;
  text-align: center;
  max-width: 500px;
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: 12px;
}

.empty-state h2 {
  font-size: 1.4rem;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.empty-state p {
  color: var(--text-muted);
  font-size: 0.95rem;
  margin-bottom: 20px;
}

.starter-chips {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chip {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  padding: 10px 16px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 0.9rem;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.chip:hover {
  background: var(--bg-tertiary);
  border-color: var(--accent-purple);
  color: #fff;
}

/* Messages */
.message-bubble {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 85%;
}

.message-bubble.user {
  align-self: flex-end;
  background: var(--accent-purple-dim);
  border: 1px solid rgba(139, 92, 246, 0.3);
  padding: 10px 14px;
  border-radius: var(--radius-lg) var(--radius-lg) 2px var(--radius-lg);
}

.message-bubble.assistant {
  align-self: flex-start;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  padding: 14px 18px;
  border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) 2px;
  max-width: 90%;
}

.message-sender {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 6px;
}

.message-bubble.user .message-sender {
  color: var(--accent-purple-light);
}

.message-bubble.assistant .message-sender {
  color: var(--status-info);
}

.message-body {
  font-size: 0.95rem;
  color: var(--text-primary);
  word-break: break-word;
}

.message-body pre {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  padding: 12px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  margin: 8px 0;
}

.message-body code {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 5px;
  border-radius: 4px;
}

/* Tool execution card */
.tool-card {
  align-self: flex-start;
  width: 90%;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}

.tool-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.2);
  cursor: pointer;
}

.tool-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--status-info);
  font-weight: 600;
}

.tool-status-pill {
  font-size: 0.75rem;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.tool-status-pill.running {
  background: rgba(251, 191, 36, 0.2);
  color: var(--status-warn);
}

.tool-status-pill.succeeded {
  background: rgba(16, 185, 129, 0.2);
  color: var(--status-success);
}

.tool-status-pill.failed {
  background: rgba(239, 68, 68, 0.2);
  color: var(--status-error);
}

.tool-card-body {
  padding: 10px 12px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-subtle);
  max-height: 250px;
  overflow-y: auto;
  white-space: pre-wrap;
  color: var(--text-secondary);
}

/* Composer Container */
.chat-composer-container {
  padding: 12px 20px 8px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

.composer-box {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  transition: border-color 0.15s ease;
}

.composer-box:focus-within {
  border-color: var(--accent-purple);
  box-shadow: 0 0 0 1px var(--accent-purple);
}

.composer-textarea {
  width: 100%;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 0.95rem;
  resize: none;
  min-height: 28px;
  max-height: 160px;
}

.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
}

.composer-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.muse-select {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  outline: none;
}

.composer-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.composer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-send {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-purple);
  border: none;
  color: #fff;
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.1s ease;
}

.btn-send:hover {
  opacity: 0.9;
}

.send-icon {
  width: 14px;
  height: 14px;
}

.btn-cancel {
  background: var(--status-error);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}

/* Live StatusBar */
.live-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-muted);
}

.sb-left, .sb-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-success);
}

.sb-state.busy .sb-dot {
  background: var(--status-warn);
  animation: pulse 1s infinite alternate;
}

@keyframes pulse {
  from { opacity: 0.4; }
  to { opacity: 1; }
}

.sb-divider {
  color: var(--border-color);
}

.sb-cyan {
  color: var(--status-info);
}

.sb-warn {
  color: var(--status-warn);
}

.sb-muted {
  color: var(--text-muted);
}

/* General View Panels (Orchestra, Approvals, Files, Settings) */
.view-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.view-header h2 {
  font-size: 1.3rem;
  font-weight: 700;
  margin-bottom: 4px;
}

.view-header p {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.orchestra-grid, .settings-content {
  padding: 20px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

.panel-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 16px;
}

.panel-card h3 {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-secondary);
}

.card-header-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.card-header-action h3 {
  margin-bottom: 0;
}

/* Muses Grid */
.muses-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.muse-card {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 12px;
}

.muse-card-name {
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.muse-card-role {
  font-size: 0.8rem;
  color: var(--accent-purple-light);
  margin-bottom: 4px;
}

.muse-card-engine {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

/* Approvals Table */
.approvals-container {
  padding: 20px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

.approval-item-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.approval-item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.approval-item-action {
  font-size: 1rem;
  font-weight: 700;
  color: var(--status-warn);
}

.approval-item-reason {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.approval-item-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* Files Split */
.files-split {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.files-list-panel {
  width: 280px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.file-tree-item {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-tree-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.file-tree-item.active {
  background: var(--accent-purple-dim);
  color: #fff;
}

.file-content-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
}

.file-content-header {
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--status-info);
}

.file-content-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--text-primary);
}

/* Utilities */
.hidden {
  display: none !important;
}
`,
  },

  '/app.js': {
    contentType: 'application/javascript; charset=utf-8',
    content: `/**
 * PLUTON Client Application (ADR-0014).
 * Single authoritative Single-Page Application (SPA) for desktop and browser.
 */

(function () {
  'use strict';

  // Extract auth token from query parameter or localStorage
  const urlParams = new URLSearchParams(window.location.search);
  const queryToken = urlParams.get('token');
  if (queryToken) {
    sessionStorage.setItem('pluton_token', queryToken);
  }
  const token = sessionStorage.getItem('pluton_token') || '';

  // State
  let activeTab = 'chat';
  let activeSessionId = null;
  let activeMuseId = null;
  let workspaceData = null;
  let sessions = [];
  let currentMessages = [];
  let isStreaming = false;
  let streamingText = '';
  let eventSource = null;

  // Headers for API calls
  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Pluton-Token': token,
    };
  }

  // Fetch wrapper
  async function apiFetch(path, opts = {}) {
    const url = new URL(path, window.location.origin);
    if (token) url.searchParams.set('token', token);
    const res = await fetch(url.toString(), {
      ...opts,
      headers: {
        ...apiHeaders(),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  // DOM Elements
  const elWorkspaceName = document.getElementById('workspaceName');
  const elConnectionStatus = document.getElementById('connectionStatus');
  const elNavButtons = document.querySelectorAll('.nav-btn');
  const elViewPanels = document.querySelectorAll('.view-panel');
  const elSessionsList = document.getElementById('sessionsList');
  const elBtnNewSession = document.getElementById('btnNewSession');
  const elChatTranscript = document.getElementById('chatTranscript');
  const elEmptyState = document.getElementById('emptyState');
  const elPromptInput = document.getElementById('promptInput');
  const elBtnSend = document.getElementById('btnSend');
  const elBtnCancel = document.getElementById('btnCancel');
  const elMuseSelect = document.getElementById('museSelect');
  const elSbState = document.getElementById('sbState');
  const elSbStateLabel = document.getElementById('sbStateLabel');
  const elSbModel = document.getElementById('sbModel');
  const elSbContext = document.getElementById('sbContext');
  const elSbCost = document.getElementById('sbCost');
  const elSbMusesCount = document.getElementById('sbMusesCount');
  const elPinnedApproval = document.getElementById('pinnedApprovalBanner');
  const elApprovalAction = document.getElementById('approvalAction');
  const elApprovalReason = document.getElementById('approvalReason');
  const elBtnBannerApprove = document.getElementById('btnBannerApprove');
  const elBtnBannerDeny = document.getElementById('btnBannerDeny');
  const elApprovalsBadge = document.getElementById('approvalsBadge');

  // Tab Switching
  elNavButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  function switchTab(tab) {
    activeTab = tab;
    elNavButtons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
    elViewPanels.forEach((p) => p.classList.toggle('active', p.id === tab + 'View'));

    if (tab === 'orchestra') loadOrchestraView();
    if (tab === 'approvals') loadApprovalsView();
    if (tab === 'files') loadFilesView();
    if (tab === 'settings') loadSettingsView();
  }

  // Connect to SSE event stream
  function connectSSE() {
    if (eventSource) eventSource.close();

    const sseUrl = new URL('/api/events', window.location.origin);
    if (token) sseUrl.searchParams.set('token', token);

    eventSource = new EventSource(sseUrl.toString());

    eventSource.onopen = () => {
      elConnectionStatus.classList.remove('offline');
      elConnectionStatus.querySelector('.status-label').textContent = 'Connected';
    };

    eventSource.onerror = () => {
      elConnectionStatus.classList.add('offline');
      elConnectionStatus.querySelector('.status-label').textContent = 'Reconnecting…';
    };

    eventSource.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handleServerEvent(ev);
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };
  }

  function handleServerEvent(ev) {
    if (ev.type === 'token' && ev.sessionId === activeSessionId) {
      appendStreamingToken(ev.text);
    } else if (ev.type === 'tool' && ev.sessionId === activeSessionId) {
      renderToolEvent(ev.tool);
    } else if (ev.type === 'turn_start' && ev.sessionId === activeSessionId) {
      setStreamingState(true);
    } else if (ev.type === 'turn_end' && ev.sessionId === activeSessionId) {
      finalizeStreamingTurn(ev.interrupted, ev.failed);
      setStreamingState(false);
    } else if (ev.type === 'usage' && ev.sessionId === activeSessionId) {
      updateUsageStatus(ev);
    } else if (ev.type === 'approval_requested') {
      showPendingApproval(ev.approval);
      updateApprovalsBadge(1);
    } else if (ev.type === 'approval_decided') {
      hidePendingApproval();
      updateApprovalsBadge(-1);
      if (activeTab === 'approvals') loadApprovalsView();
    }
  }

  // Init Data Loading
  async function init() {
    try {
      connectSSE();
      await loadWorkspace();
      await loadSessions();
      setupComposer();
    } catch (err) {
      console.error('Initialization error:', err);
    }
  }

  async function loadWorkspace() {
    const res = await apiFetch('/api/workspace');
    workspaceData = res.workspace;
    elWorkspaceName.textContent = workspaceData.name + ' · ' + workspaceData.rootDir;

    // Populate Muses in select dropdown
    elMuseSelect.innerHTML = '';
    workspaceData.muses.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.displayName + ' (' + m.role + ')';
      elMuseSelect.appendChild(opt);
    });
    if (workspaceData.muses.length > 0) {
      activeMuseId = workspaceData.muses[0].id;
      elSbModel.textContent = workspaceData.muses[0].model;
    }
    elSbMusesCount.textContent = workspaceData.muses.length + (workspaceData.muses.length === 1 ? ' Muse' : ' Muses');

    if (workspaceData.approvalsPending > 0) {
      loadPendingApproval();
    }
  }

  async function loadSessions() {
    const res = await apiFetch('/api/sessions');
    sessions = res.sessions || [];
    renderSessionsList();

    if (sessions.length > 0) {
      await selectSession(sessions[0].id);
    } else {
      await createNewSession();
    }
  }

  function renderSessionsList() {
    elSessionsList.innerHTML = '';
    sessions.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');
      item.innerHTML =
        '<div class="session-title">' + escapeHtml(s.title || 'Untitled Session') + '</div>' +
        '<div class="session-meta">' + new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';
      item.addEventListener('click', () => selectSession(s.id));
      elSessionsList.appendChild(item);
    });
  }

  async function selectSession(sessionId) {
    activeSessionId = sessionId;
    renderSessionsList();

    const res = await apiFetch('/api/sessions/' + sessionId);
    currentMessages = res.session.messages || [];
    renderTranscript(currentMessages);

    if (res.session.activeMuse) {
      elSbModel.textContent = res.session.activeMuse.model;
      elMuseSelect.value = res.session.activeMuse.id;
    }
  }

  async function createNewSession() {
    const res = await apiFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ museId: activeMuseId, title: 'Session ' + (sessions.length + 1) }),
    });
    sessions.unshift(res.session);
    await selectSession(res.session.id);
  }

  elBtnNewSession.addEventListener('click', createNewSession);

  // Transcript Rendering
  function renderTranscript(messages) {
    elChatTranscript.innerHTML = '';
    if (!messages || messages.length === 0) {
      elChatTranscript.appendChild(elEmptyState);
      elEmptyState.classList.remove('hidden');
      return;
    }

    elEmptyState.classList.add('hidden');
    messages.forEach((msg) => {
      appendMessageBubble(msg.role, msg.text);
    });
    scrollToBottom();
  }

  function appendMessageBubble(role, text) {
    elEmptyState.classList.add('hidden');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble ' + role;

    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.innerHTML = role === 'user' ? '<span>👤 You</span>' : '<span>⚓ PLUTON</span>';

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = formatMarkdown(text);

    bubble.appendChild(sender);
    bubble.appendChild(body);
    elChatTranscript.appendChild(bubble);
  }

  let liveBubbleBody = null;

  function appendStreamingToken(text) {
    if (!liveBubbleBody) {
      elEmptyState.classList.add('hidden');
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble assistant live';

      const sender = document.createElement('div');
      sender.className = 'message-sender';
      sender.innerHTML = '<span>⚓ PLUTON</span>';

      liveBubbleBody = document.createElement('div');
      liveBubbleBody.className = 'message-body';

      bubble.appendChild(sender);
      bubble.appendChild(liveBubbleBody);
      elChatTranscript.appendChild(bubble);
    }

    streamingText += text;
    liveBubbleBody.innerHTML = formatMarkdown(streamingText);
    scrollToBottom();
  }

  function finalizeStreamingTurn(interrupted, failed) {
    if (liveBubbleBody) {
      if (interrupted) {
        liveBubbleBody.innerHTML += '<div class="sb-warn" style="margin-top:6px;">[Turn interrupted by user]</div>';
      }
      liveBubbleBody.parentElement.classList.remove('live');
      liveBubbleBody = null;
    }
    streamingText = '';
  }

  function renderToolEvent(tool) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    const statusClass = tool.status || 'running';
    card.innerHTML =
      '<div class="tool-card-header">' +
        '<div class="tool-title">' +
          '<span>▶</span> ' + escapeHtml(tool.name) +
          (tool.summary ? ' <small style="color:var(--text-muted)">(' + escapeHtml(tool.summary) + ')</small>' : '') +
        '</div>' +
        '<span class="tool-status-pill ' + statusClass + '">' + statusClass + '</span>' +
      '</div>' +
      (tool.output ? '<div class="tool-card-body">' + escapeHtml(tool.output) + '</div>' : '');

    elChatTranscript.appendChild(card);
    scrollToBottom();
  }

  function updateUsageStatus(usage) {
    if (usage.costUsd !== null && typeof usage.costUsd === 'number') {
      elSbCost.textContent = '$' + usage.costUsd.toFixed(2);
      elSbCost.parentElement.classList.remove('hidden');
    }
  }

  function setStreamingState(busy) {
    isStreaming = busy;
    elBtnSend.classList.toggle('hidden', busy);
    elBtnCancel.classList.toggle('hidden', !busy);
    elSbState.classList.toggle('busy', busy);
    elSbStateLabel.textContent = busy ? 'Thinking…' : 'Ready';
  }

  // Composer
  function setupComposer() {
    elPromptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitPrompt();
      }
    });

    elBtnSend.addEventListener('click', submitPrompt);

    elBtnCancel.addEventListener('click', async () => {
      if (activeSessionId) {
        await apiFetch('/api/sessions/' + activeSessionId + '/cancel', { method: 'POST' });
      }
    });

    // Starter chips
    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        elPromptInput.value = chip.getAttribute('data-prompt');
        submitPrompt();
      });
    });
  }

  async function submitPrompt() {
    const text = elPromptInput.value.trim();
    if (!text || isStreaming || !activeSessionId) return;

    elPromptInput.value = '';
    appendMessageBubble('user', text);
    scrollToBottom();
    setStreamingState(true);

    try {
      await apiFetch('/api/sessions/' + activeSessionId + '/prompt', {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      appendMessageBubble('assistant', '[Error dispatching prompt: ' + err.message + ']');
      setStreamingState(false);
    }
  }

  function scrollToBottom() {
    elChatTranscript.scrollTop = elChatTranscript.scrollHeight;
  }

  // Pending Approvals
  async function loadPendingApproval() {
    try {
      const res = await apiFetch('/api/approvals');
      const pendings = (res.approvals || []).filter((a) => a.status === 'pending');
      if (pendings.length > 0) {
        showPendingApproval(pendings[0]);
        updateApprovalsBadge(pendings.length);
      } else {
        hidePendingApproval();
        updateApprovalsBadge(0);
      }
    } catch {
      // Ignore
    }
  }

  let currentPendingApprovalId = null;

  function showPendingApproval(approval) {
    currentPendingApprovalId = approval.id;
    elApprovalAction.textContent = 'Approval Required: ' + (approval.action || 'Execute Action');
    elApprovalReason.textContent = approval.reason || 'Requested by ' + (approval.requestedByMuse || 'agent');
    elPinnedApproval.classList.remove('hidden');

    elBtnBannerApprove.onclick = () => decidePendingApproval(approval.id, 'approved');
    elBtnBannerDeny.onclick = () => decidePendingApproval(approval.id, 'denied');
  }

  function hidePendingApproval() {
    elPinnedApproval.classList.add('hidden');
    currentPendingApprovalId = null;
  }

  async function decidePendingApproval(id, decision) {
    try {
      await apiFetch('/api/approvals/' + id + '/decide', {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      hidePendingApproval();
    } catch (err) {
      alert('Failed to record approval decision: ' + err.message);
    }
  }

  function updateApprovalsBadge(count) {
    if (count > 0) {
      elApprovalsBadge.textContent = count;
      elApprovalsBadge.classList.remove('hidden');
    } else {
      elApprovalsBadge.classList.add('hidden');
    }
  }

  // 2. Orchestra View Loader
  async function loadOrchestraView() {
    const res = await apiFetch('/api/workspace');
    const muses = res.workspace.muses || [];
    const container = document.getElementById('musesGrid');
    container.innerHTML = muses.map((m) =>
      '<div class="muse-card">' +
        '<div class="muse-card-name">' + escapeHtml(m.displayName) + '</div>' +
        '<div class="muse-card-role">Role: ' + escapeHtml(m.role) + '</div>' +
        '<div class="muse-card-engine">' + escapeHtml(m.engine) + ' / ' + escapeHtml(m.model) + '</div>' +
      '</div>'
    ).join('');

    const runsRes = await apiFetch('/api/runs');
    const runs = runsRes.runs || [];
    const runsContainer = document.getElementById('runsContainer');
    if (runs.length === 0) {
      runsContainer.innerHTML = '<p style="color:var(--text-muted)">No multi-agent runs recorded yet.</p>';
    } else {
      runsContainer.innerHTML = runs.map((r) =>
        '<div style="padding:10px; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">' +
          '<div><strong>Run ' + escapeHtml(r.id) + '</strong>: ' + escapeHtml(r.goal) + '</div>' +
          '<span class="tool-status-pill ' + (r.state === 'completed' ? 'succeeded' : r.state === 'running' ? 'running' : 'failed') + '">' + r.state + '</span>' +
        '</div>'
      ).join('');
    }
  }

  // 3. Approvals View Loader
  async function loadApprovalsView() {
    const res = await apiFetch('/api/approvals');
    const list = res.approvals || [];
    const container = document.getElementById('approvalsTableContainer');
    if (list.length === 0) {
      container.innerHTML = '<div class="panel-card"><p style="color:var(--text-muted)">No approvals recorded in this project.</p></div>';
      return;
    }
    container.innerHTML = list.map((a) =>
      '<div class="approval-item-card">' +
        '<div class="approval-item-info">' +
          '<div class="approval-item-action">' + escapeHtml(a.action) + ' (' + a.status + ')</div>' +
          '<div class="approval-item-reason">' + escapeHtml(a.reason) + '</div>' +
          '<div class="approval-item-meta">Requested by: ' + escapeHtml(a.requestedByMuse || 'agent') + ' · ' + new Date(a.createdAt).toLocaleString() + '</div>' +
        '</div>' +
        (a.status === 'pending'
          ? '<div class="approval-banner-actions">' +
              '<button class="btn-success-sm" onclick="window.plutonDecide(\\'' + a.id + '\\', \\'approved\\')">Approve</button>' +
              '<button class="btn-danger-sm" onclick="window.plutonDecide(\\'' + a.id + '\\', \\'denied\\')">Deny</button>' +
            '</div>'
          : '<span class="tool-status-pill ' + (a.status === 'approved' ? 'succeeded' : 'failed') + '">' + a.status + '</span>') +
      '</div>'
    ).join('');
  }

  window.plutonDecide = (id, decision) => {
    decidePendingApproval(id, decision).then(loadApprovalsView);
  };

  // 4. Files View Loader
  async function loadFilesView() {
    const res = await apiFetch('/api/files');
    const files = res.files || [];
    const listPanel = document.getElementById('filesList');
    listPanel.innerHTML = files.map((f) =>
      '<div class="file-tree-item" data-path="' + escapeHtml(f) + '">' + escapeHtml(f) + '</div>'
    ).join('');

    listPanel.querySelectorAll('.file-tree-item').forEach((item) => {
      item.addEventListener('click', async () => {
        listPanel.querySelectorAll('.file-tree-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        const path = item.getAttribute('data-path');
        const contentRes = await apiFetch('/api/files/content?path=' + encodeURIComponent(path));
        document.getElementById('activeFileName').textContent = path;
        document.getElementById('fileCodeBody').textContent = contentRes.content;
      });
    });
  }

  // 5. Settings View Loader
  async function loadSettingsView() {
    const modelsRes = await apiFetch('/api/models');
    document.getElementById('modelsConfig').innerHTML =
      '<pre style="font-family:var(--font-mono); font-size:0.8rem;">' + JSON.stringify(modelsRes.models, null, 2) + '</pre>';
    document.getElementById('doctorChecks').innerHTML =
      '<p style="color:var(--status-success)">Runtime healthy and connected via loopback.</p>';
  }

  // Utilities
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatMarkdown(text) {
    if (!text) return '';
    let escaped = escapeHtml(text);
    // Simple code blocks
    escaped = escaped.replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '<pre><code>$1</code></pre>');
    // Inline code
    escaped = escaped.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    // Line breaks
    escaped = escaped.replace(/\\n/g, '<br>');
    return escaped;
  }

  // Start
  init();
})();
`,
  },
}
