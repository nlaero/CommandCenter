# Command Center

**Standalone native desktop app** for Windows and Linux (Tauri 2 shell + React/TypeScript UI). Not a browser or hosted web app — the product runs as a local OS application with config on disk.

Phase A MVP shell: empty board on first launch, fine-grid layout with persistence, multi-board model, and a Settings catalog for product + foundation source types (integrations stubbed).

## Requirements

### Both platforms

- [Node.js](https://nodejs.org/) 20+ and npm (build tooling only)
- [Rust](https://rustup.rs/) stable (1.77+)

### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled on Windows 10/11)

### Linux

Install Tauri prerequisites (Debian/Ubuntu example):

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

See [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Fedora, Arch, and others.

## Run the desktop app (supported)

```bash
git clone <repo-url> CommandCenter
cd CommandCenter
npm install
npm run tauri:dev
```

This launches the **native Tauri window** (WebView2 on Windows / WebKitGTK on Linux) with real Rust-backed config under the OS app-data path.

### Portable config

```bash
# Linux / macOS
COMMAND_CENTER_HOME=/path/to/board-pack npm run tauri:dev

# Windows PowerShell
$env:COMMAND_CENTER_HOME = "D:\board-pack"
npm run tauri:dev
```

## Config location

| Mode | Path |
|------|------|
| Default (Windows) | `%AppData%\command-center\` |
| Default (Linux) | `~/.config/command-center/` |
| Portable override | Set `COMMAND_CENTER_HOME` to any writable folder |

Files written there:

- `config.yaml` — boards, sources, layout settings
- `layouts/<board-id>.json` — fine-grid panel positions
- `*.bak` — last-good backups before overwrite

## MVP shell behavior

- First launch: **empty board** (no default widgets)
- **Settings → Source catalog**: weather, ADS-B, cameras, ham, crime/incident (open data), plus foundation adapters (file, HTTP, SQLite, system metrics)
- Configure required fields → **Save** or **Save & add to board**
- **Edit layout** (toolbar or `Ctrl/Cmd+E`): drag/resize on a fine 48-column grid; layout persists on drag/resize stop
- Board switcher in the chrome (+ to create another empty board)

Live API/camera pipelines are stubs in Phase A; config, layout, and add-to-board flows are real.

## Build desktop installers

```bash
npm run tauri:build
```

Artifacts land under `src-tauri/target/release/bundle/` (platform-dependent). Flatpak / `.deb` packaging is planned for a later phase — not part of this MVP shell.

## Tests

```bash
npm run test:rust
npm run build
```

## Contributor note: browser UI mock (not the product)

`npm run dev` starts Vite in a normal browser with **localStorage mock persistence**. It is a **demo / UI iteration aid only** — no Tauri window, no OS app-data config, no portable override. Do not treat it as a supported runtime or substitute for `npm run tauri:dev`.
