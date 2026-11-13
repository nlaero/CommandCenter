# Command Center

**Standalone native desktop app** for Windows and Linux (Tauri 2 shell + React/TypeScript UI). Not a browser or hosted web app — the product runs as a local OS application with config on disk.

Phase A: empty board on first launch, fine-grid layout with persistence, multi-board model, Settings catalog, and live product sources — crime / incident open data plus **Broadcastify Feed Owner** (personal feed status + archives).

## Global product rule: audio sources

Any source that plays audio must:

1. **Start muted by default** when a clip/player opens (user unmutes explicitly).
2. **Support closed captioning** (local/on-device transcription preferred for personal-use archives).

**Applied now:** Broadcastify Feed Owner (muted players + Settings captions toggle / panel CC + local stub ASR).  
**Other audio sources:** follow the same rule when wired (crime/incident optional `audioUrl` already starts muted; captions still TODO for that path). Future scanner / Calls / camera-with-audio panels must ship mute-default + CC — do not merge audio playback without both.

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

## Broadcastify Feed Owner (live, personal)

**API:** [Feed Owner API v0.9](https://support.broadcastify.com/hc/en-us/articles/204172369-Feed-Owner-API-v0-9-Documentation) — `https://api.broadcastify.com/owner/` with `a=feed` / `a=archives`, `feedId`, `u`, `p`, `type=json`.

**Scope:** Nathan’s **own** uploaded feed only. **Not** the $2500 Catalog API and **not** Calls. Archive listings/URLs are **personal use only** (no commercial use or redistribution).

| Setting | Required | Notes |
|---------|----------|--------|
| Feed ID | yes | From your feed management / listen URL |
| Archive day | no | `YYYY-MM-DD`; blank lists available dates |
| Include archives | no | Default on |
| Captions / transcription | no | Default off. Panel CC UI for archive audio |
| Username | yes | Secret `broadcastify.username` — OS keyring |
| Password | yes | Secret `broadcastify.password` — OS keyring only (never `config.yaml`) |

### Audio + captions (local / on-device preferred)

Per the [global audio rule](#global-product-rule-audio-sources): archive players **start muted**; unmute via the Muted control or native player. Personal-use archive audio should stay on-device — **no cloud ASR upload**.

When **Captions / transcription** is enabled (default on for new Broadcastify sources), the panel shows a **CC** toggle and captions pane.

**Current path (stub first):** `transcribe_audio_local` (Tauri) / browser twin returns structured offline stub segments so the UI can ship before a model is bundled.

**Next:** wire on-device Whisper (whisper.cpp) or similar behind `transcribeArchiveLocal` — same Settings toggle and panel UI; no Catalog/Calls scope change.

### Configure in the app

1. **Settings → Source catalog → Broadcastify (Feed Owner) → Configure**
2. Enter feed ID; paste username/password (keyring / `secrets.local.json` fallback).
3. Optionally set an archive day and enable **Captions / transcription**, then **Save** or **Save & add to board**.
4. Panel shows live online/offline + listeners; archive dates or clips (with audio when a day is selected). Day can also be changed in the panel toolbar. With captions on, use **CC** + **Transcribe local** on a clip.

Live Owner API calls run in the **Tauri** app. The browser Vite mock only serves a fixture (CORS).

## MVP shell behavior

- First launch: **empty board** (no default widgets)
- **Settings → Source catalog**: weather, ADS-B, cameras, ham, **crime/incident**, **Broadcastify Feed Owner**, plus foundation adapters (file, HTTP, SQLite, system metrics)
- Configure required fields → **Save** or **Save & add to board**
- **Edit layout** (toolbar or `Ctrl/Cmd+E`): drag/resize on a fine 48-column grid; layout persists on drag/resize stop
- Board switcher in the chrome (+ to create another empty board)

Other product sources remain stubs until their adapters are wired.

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

`npm run dev` starts Vite in a normal browser with **localStorage mock persistence** and a CORS-dependent browser fetch for the incident source. It is a **demo / UI iteration aid only** — no Tauri window, no OS app-data config, no portable override. Do not treat it as a supported runtime or substitute for `npm run tauri:dev`.
