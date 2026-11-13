# Command Center

**Standalone native desktop app** for Windows and Linux (Tauri 2 shell + React/TypeScript UI). Not a browser or hosted web app — the product runs as a local OS application with config on disk.

Phase A: empty board on first launch, fine-grid layout with persistence, multi-board model, Settings catalog, and the first **live** product source — crime / incident open data.

## Requirements

### Both platforms

- [Node.js](https://nodejs.org/) 20+ and npm (build tooling only)
- [Rust](https://rustup.rs/) stable (1.77+)

### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://microsoft.com/edge/webview2/) (usually preinstalled on Windows 10/11)

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

- `config.yaml` — boards, sources, layout settings (secret **refs** only)
- `layouts/<board-id>.json` — fine-grid panel positions
- `secrets.local.json` — fallback secret store if OS keyring is unavailable (do not commit)
- `*.bak` — last-good backups before overwrite

## Crime / incident source (live)

**Provider:** municipal open data via documented Socrata SODA APIs or a custom GeoJSON/JSON endpoint.  
**Not used:** CrimeRadar / Squawster scraping (ToS blocks automated access). Licensed CrimeRadar Business / Incident Source APIs can be added later behind feature flags.

| Setting | Required | Notes |
|---------|----------|--------|
| Provider | yes | `chicago`, `seattle`, or `custom` |
| Custom endpoint URL | if custom | HTTPS GeoJSON FeatureCollection, JSON array, or `{ incidents: [] }` |
| Max incidents | yes | Newest first (default 50) |
| Attribution | yes | Shown in the panel footer |
| Socrata App Token | no | Secret `socrata.app_token` — OS keyring preferred; improves rate limits |

### Configure in the app

1. Open **Settings → Source catalog → Crime / incident (open data) → Configure**
2. Pick a provider (Chicago / Seattle presets fill attribution). For Custom, paste the open-data URL.
3. Optionally paste a Socrata App Token (stored in keyring / local secrets fallback — never in `config.yaml`).
4. **Save source** or **Save & add to board** (required fields must validate first).
5. The panel shows a **live feed** (newest first). New IDs flash as in-panel alerts; click an item for detail. If a feed row includes `audioUrl` / `audio`, an audio player appears in the detail pane.

### Example custom payload fields

Normalized when present: `title`, `category`, `description`, `occurredAt`/`date`, `address`, `lat`/`lon`, `audioUrl`, `detailUrl`.

Chicago preset: `https://data.cityofchicago.org/resource/ijzp-q8t2.json`  
Seattle preset: `https://data.seattle.gov/resource/tazs-3rd5.json`

Open-data portals often lag hours–days vs live CAD/scanner apps — the panel labels the feed accordingly.

## MVP shell behavior

- First launch: **empty board** (no default widgets)
- **Settings → Source catalog**: weather, ADS-B, cameras, ham, **crime/incident (live open data)**, plus foundation adapters (file, HTTP, SQLite, system metrics)
- Configure required fields → **Save** or **Save & add to board**
- **Edit layout** (toolbar or `Ctrl/Cmd+E`): drag/resize on a fine 48-column grid; layout persists on drag/resize stop
- Board switcher in the chrome (+ to create another empty board)

Other product sources remain stubs until their adapters are wired; crime/incident open data is the first live feed.

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

## auth-server (separate service)

Username/password login is served by **auth-server** (not part of the Tauri process).

**Repo:** [`nlaero/command-center-auth`](https://github.com/nlaero/command-center-auth)

Fedora on a Raspberry Pi is a **test host only** — the service name is always `auth-server`. Source API secrets (Broadcastify, etc.) stay on the desktop keyring and are not sent to auth-server.

## Contributor note: browser UI mock (not the product)

`npm run dev` starts Vite in a normal browser with **localStorage mock persistence** and a CORS-dependent browser fetch for the incident source. It is a **demo / UI iteration aid only** — no Tauri window, no OS app-data config, no portable override. Do not treat it as a supported runtime or substitute for `npm run tauri:dev`.
