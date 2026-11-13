# Command Center

Local-first personal ops dashboard (Tauri 2 + React + TypeScript). Phase A MVP shell: empty board on first launch, fine-grid layout with persistence, multi-board model, and a Settings catalog for product + foundation source types (integrations stubbed).

## Requirements

### Both platforms

- [Node.js](https://nodejs.org/) 20+ and npm
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

## Run (development)

```bash
git clone <repo-url> CommandCenter
cd CommandCenter
npm install
npm run tauri:dev
```

Frontend-only (browser mock persistence via `localStorage`, no Rust config dir):

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default `http://localhost:1420`).

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

Example portable run:

```bash
# Linux / macOS
COMMAND_CENTER_HOME=/path/to/board-pack npm run tauri:dev

# Windows PowerShell
$env:COMMAND_CENTER_HOME = "D:\board-pack"
npm run tauri:dev
```

## MVP shell behavior

- First launch: **empty board** (no default widgets)
- **Settings → Source catalog**: weather, ADS-B, cameras, ham, crime/incident (open data), plus foundation adapters (file, HTTP, SQLite, system metrics)
- Configure required fields → **Save** or **Save & add to board**
- **Edit layout** (toolbar or `Ctrl/Cmd+E`): drag/resize on a fine 48-column grid; layout persists on drag/resize stop
- Board switcher in the chrome (+ to create another empty board)

Live API/camera pipelines are stubs in Phase A; config, layout, and add-to-board flows are real.

## Build

```bash
npm run tauri:build
```

Artifacts land under `src-tauri/target/release/bundle/` (platform-dependent). Flatpak / `.deb` packaging is planned for a later phase — not part of this MVP shell.

## Tests

```bash
npm run test:rust
npm run build
```
