# ADR-0015 — Desktop Delivery and Packaging Strategy

- Status: Accepted (2026-10-18)
- Deciders: Core Architecture Team
- References: ADR-0001 (Language Runtime), ADR-0010 (Windows/WSL2 Boundary), ADR-0014 (Shared Desktop & Browser Architecture)

## Context

Pluton's primary user experience is a dedicated graphical application workspace combining OpenCode and Claude Code's project-opening workflow with the visual orchestration, diff inspection, and multi-agent coordination of Codex and DeepSeek.

The platform requires:
1. Seamless Windows installation and launch from Windows PowerShell (`pluton`, `pluton .`, `pluton <path>`).
2. A dedicated top-level application window without browser chrome (URL bar, navigation buttons, tab strip).
3. 100% reuse of the graphical single-page application frontend and authoritative local runtime.
4. Fast installation without forcing developers to download a 200MB+ Electron binary or install complex native build toolchains during `npm install -g pluton-harness`.
5. High security: loopback-only binding, timing-safe authentication, origin validation, and strict capability isolation.

We must evaluate whether the current Edge/Chrome `--app` launcher meets production requirements and determine the long-term standalone desktop packaging path (Electron vs Tauri vs Webview2 Sidecar).

## Comparison of Delivery Architectures

| Dimension | Option A: Native Chromium `--app` Window (Current) | Option B: Electron Standalone Wrapper | Option C: Tauri v2 / WebView2 Sidecar |
| :--- | :--- | :--- | :--- |
| **Windows Launch Experience** | Instantaneous. Pre-installed Edge/Chrome launch with `--app=URL --window-size=1280,840`. Native window frame, taskbar grouping, Aero snap. | Native window with custom window frame and tray icon. | Native window with OS WebView2, custom frame and tray icon. |
| **Installation via npm** | Lightweight (`< 2MB` total package). Zero native build dependencies; installs in seconds. | Prohibitive (`> 200MB`). Bundles full Chromium runtime; slow install; platform-specific binary bindings. | Moderate. Requires compiling Rust binaries or downloading prebuilt platform sidecar binaries. |
| **Frontend Reuse** | 100% reuse. Connects to loopback HTTP/SSE server with token auth. | 100% reuse. Points `BrowserWindow` to loopback URL. | 100% reuse. Points WebView to loopback URL. |
| **Runtime Isolation** | Strong. Webview runs in sandboxed renderer; cannot access arbitrary Node/OS APIs except via Pluton REST/SSE endpoints. | Risky unless context isolation and nodeIntegration=false are strictly guarded. | Strong. Capability-based IPC and sandboxed web context. |
| **Resource Consumption** | Minimal incremental memory. Shares OS Edge/Chromium renderer subsystem. | High. Dedicated Electron Chromium instance (~150MB+ idle RAM). | Low (~30-50MB idle RAM using shared WebView2). |
| **Maintenance & CI** | Zero binary toolchains. Standard TypeScript build. | High. Chromium security patches, platform build matrix (`x64`, `arm64`, macOS notarization). | Medium. Rust toolchain (`cargo`, `tauri-cli`), cross-platform compilation. |

## Decision

We adopt a **two-tier desktop delivery strategy**:

1. **Tier 1 (Authoritative Primary Delivery): App-Mode Window Launcher**
   - Retained as the default and authoritative desktop interface for the npm package distribution (`pluton`, `pluton .`, `npx pluton`).
   - Automatically selects Microsoft Edge on Windows (`msedge.exe --app=URL`) or Google Chrome/Chromium across macOS and Linux, falling back gracefully to the system browser.
   - Zero installation friction, zero bloated binary downloads, and zero maintenance burden for npm users.
   - Enhanced with window title binding (`document.title`), keyboard accelerators, and connection health indicators.

2. **Tier 2 (Future Standalone Installer Distribution): Tauri v2 WebView2 Wrapper**
   - For standalone Windows/macOS/Linux application bundles (e.g. `.msi`, `.exe`, `.dmg` distributed outside npm on GitHub Releases or Windows Package Manager `winget`), Tauri v2 is selected over Electron due to its 15x smaller footprint (~10MB vs ~200MB) and native WebView2 integration on Windows 10/11.
   - The standalone wrapper acts strictly as a native window shell loading the local Pluton server; it does NOT introduce a second UI or shadow runtime.

Under no circumstances will Pluton introduce a separate or independent UI codebase for desktop vs web.

## Consequences

### Positive
- `npm i -g pluton-harness` remains instantaneous and lightweight across Windows, Linux, and macOS.
- Developers get a dedicated graphical application window immediately upon typing `pluton` in PowerShell.
- All frontend features (Task DAG, Approvals Auto-Continue, Worktree Diff Inspector, SSE transcript) work identically in desktop app mode and web browser mode.
- Security boundary is preserved: renderer has zero direct access to filesystem or shell outside Pluton's authenticated API.

### Negative
- Advanced desktop features such as native OS system tray icon and custom titlebar window buttons require the Tier 2 standalone wrapper.
