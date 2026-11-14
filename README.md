# Command Center

Native desktop board for Windows and Linux. Tauri 2 shell, React/TypeScript UI, config on disk.

First launch is an empty board. You add sources from Settings. Live so far: weather (conditions + radar/satellite + local NWS alerts), USGS earthquakes, crime/incident open data, and Broadcastify Feed Owner (personal feed status + archives). Mounted source windows publish into the right-side alerts pane.

## Audio rule

Anything that plays audio:

1. Starts **muted** (user unmutes).
2. Supports closed captions (on-device transcription preferred for personal archives).

Broadcastify Feed Owner already follows this (muted players + Settings captions / panel CC; local ASR is still a stub). Crime/incident optional `audioUrl` starts muted; captions for that path are TODO. Do not ship new audio playback without both mute-default and CC.

## Requirements

**All platforms**

- [Node.js](https://nodejs.org/) 20+ and npm
- [Rust](https://rustup.rs/) stable (1.77+)

**Windows**

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://microsoft.com/edge/webview2/) (usually already on Windows 10/11)

**Linux** (Debian/Ubuntu example)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```

Other distros: [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## Run

```bash
git clone https://github.com/nlaero/CommandCenter.git
cd CommandCenter
npm install
npm run tauri:dev
```

That opens the Tauri window (WebView2 / WebKitGTK) with Rust-backed config in the OS app-data path.

### Portable config

```bash
# Linux / macOS
COMMAND_CENTER_HOME=/path/to/board-pack npm run tauri:dev

# Windows PowerShell
$env:COMMAND_CENTER_HOME = "D:\board-pack"
npm run tauri:dev
```

## Config paths

| Mode | Path |
|------|------|
| Windows default | `%AppData%\command-center\` |
| Linux default | `~/.config/command-center/` |
| Portable | `COMMAND_CENTER_HOME` → any writable folder |

Files there:

- `config.yaml` — boards, sources, layout (secret **refs** only)
- `layouts/<board-id>.json` — fine-grid panel positions
- `secrets.local.json` — fallback if the OS keyring is missing (do not commit)
- `*.bak` — last-good copy before overwrite

## Weather

| Layer | Provider | Auth | Notes |
|-------|----------|------|-------|
| Conditions + hourly | [Open-Meteo](https://open-meteo.com/) | None for non-commercial | Attribution required. Commercial / high volume needs a plan + API key. |
| Radar tiles | [RainViewer](https://www.rainviewer.com/api.html) | None | Personal/educational; credit RainViewer. Max zoom 7 on the 2026 public API. |
| Satellite | [NOAA NESDIS GOES](https://www.star.nesdis.noaa.gov/goes/) GeoColor | None | CONUS / full-disk stills (RainViewer IR satellite ended 2026-01-01). |
| Basemap | Esri Dark Gray | None | Same keyless canvas as the quake map. CARTO's public raster tiles now ask for an API key. |

Optional Open-Meteo commercial key goes in the keyring / `secrets.local.json` as `weather.optional_key` — never in `config.yaml`.

| Setting | Required | Notes |
|---------|----------|--------|
| Lat / lon | yes | Center for all scopes |
| Display scopes | yes | `local`, `regional`, `nationwide`, or combinations |
| Units | yes | Imperial or Metric |
| Show radar | no | Default on |
| Show satellite | no | Default on |
| Open-Meteo API key | no | Secret `weather.optional_key` |

**In the app:** Settings → Source catalog → Weather → Configure. Enter lat/lon, scopes, units. Save, or Save & add to board. Panel shows conditions, a short hourly strip, and a map per selected scope. Radar / Satellite chips toggle layers.

Add more Weather sources if you want separate panels per scope instead of a combo.

## USGS earthquakes

[USGS GeoJSON summary feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). No key. The same feed includes earthquakes, tsunami flags (`properties.tsunami`), and other event types (blasts, landslides, eruptions, “other event”).

USGS updates these about once a minute and sends `Cache-Control: max-age=60` plus `Last-Modified`. The panel waits out that cache (and `Age` / `Retry-After`) and will not poll faster than once a minute. Repeat requests send `If-Modified-Since` and keep the previous body on 304.

| Setting | Required | Notes |
|---------|----------|--------|
| Feed | yes | Past hour through significant month. Past day includes non-quake types. |
| Max events | yes | Newest first (default 50, max 300) |
| Alerts magnitude | yes | Default 4.5. Also sends tsunami flags, PAGER yellow+, landslides, and volcanic eruptions to the alerts pane |
| Pan map to new events | no | Default on. Clicking a row always pans |

**In the app:** Settings → Source catalog → USGS earthquakes → Configure. Pick a feed. Save, or Save & add to board. The map opens on the newest event. Later polls move it to each new earthquake, tsunami flag, or other event. Drag to look around; +/- zooms. Basemap is Esri Dark Gray (CARTO's keyless raster tiles now ask for an API key). Credit Esri / OSM on the map; USGS stays in the footer.

While that window is on the board, notable rows (tsunami flag, PAGER yellow or higher, magnitude at or above the threshold, landslides, volcanic eruptions) show in the right-side alerts pane. Taking the window off the board removes them. Click a row in the pane for the USGS detail link.

## Crime / incident

Municipal open data via Socrata SODA or a custom GeoJSON/JSON URL. Not CrimeRadar / Squawster scraping (ToS). Licensed CrimeRadar APIs can come later behind flags.

| Setting | Required | Notes |
|---------|----------|--------|
| Provider | yes | `chicago`, `seattle`, or `custom` |
| Custom URL | if custom | HTTPS GeoJSON FeatureCollection, JSON array, or `{ incidents: [] }` |
| Max incidents | yes | Newest first (default 50) |
| Attribution | yes | Panel footer |
| Socrata App Token | no | Secret `socrata.app_token` — keyring preferred |

**In the app:** Settings → Source catalog → Crime / incident → Configure. Pick a provider (Chicago / Seattle fill attribution). Optional Socrata token. Save or Save & add to board. New IDs flash in-panel; click a row for detail. Rows with `audioUrl` / `audio` get a muted player in the detail pane.

Normalized fields when present: `title`, `category`, `description`, `occurredAt`/`date`, `address`, `lat`/`lon`, `audioUrl`, `detailUrl`.

- Chicago: `https://data.cityofchicago.org/resource/ijzp-q8t2.json`
- Seattle: `https://data.seattle.gov/resource/tazs-3rd5.json`

Open-data portals often lag hours–days vs live CAD; the panel labels the feed accordingly.

## Broadcastify Feed Owner

[Feed Owner API v0.9](https://support.broadcastify.com/hc/en-us/articles/204172369-Feed-Owner-API-v0-9-Documentation) — `https://api.broadcastify.com/owner/` with `a=feed` / `a=archives`, `feedId`, `u`, `p`, `type=json`.

Your own uploaded feed only. Not the Catalog API ($2500) and not Calls. Archives are personal use only.

| Setting | Required | Notes |
|---------|----------|--------|
| Feed ID | yes | From feed management / listen URL |
| Archive day | no | `YYYY-MM-DD`; blank lists available dates |
| Include archives | no | Default on |
| Captions / transcription | no | Default off; panel CC for archive audio |
| Username | yes | Secret `broadcastify.username` |
| Password | yes | Secret `broadcastify.password` (keyring only) |

Archive players start muted. Keep personal archive audio on-device — no cloud ASR upload.

With captions enabled, the panel shows CC and a captions pane. Today `transcribe_audio_local` returns stub segments so the UI can ship; next step is whisper.cpp (or similar) behind the same toggle.

**In the app:** Settings → Source catalog → Broadcastify (Feed Owner) → Configure. Feed ID + credentials, optional archive day and captions. Panel shows online/offline + listeners and archives. Change day in the toolbar; use CC + Transcribe local on a clip when captions are on.

Live Owner API calls need the Tauri app. The browser Vite mock serves a fixture (CORS).

## Timed panel rotation

Optional: cycle two or more saved sources in one panel on a timer.

1. Configure at least two sources under Settings → Source catalog.
2. Settings → Panel rotation.
3. Enable timed rotation.
4. Set title + interval (15s / 30s / 1m / 5m, or custom 5–3600s), pick sources, Add rotating panel to board.

Toolbar shows slot, active source, countdown, pause/prev/next. Config lives on the panel (`rotation.enabled`, `intervalSec`, `sourceIds`). Single-source panels are unchanged.

## Shell behavior

- Empty board on first launch
- Settings → Source catalog: weather, USGS earthquakes, ADS-B, cameras, ham, crime/incident, Broadcastify Feed Owner, plus file / HTTP / SQLite / system-metrics stubs
- Configure → Save or Save & add to board
- Settings → Panel rotation for multi-source panels
- Edit layout (toolbar or `Ctrl/Cmd+E`): 48-column fine grid; persists on drag/resize stop
- Board switcher in the chrome (+ for another empty board)

Other catalog entries stay stubs until their adapters land.

## Sign in

The board asks for an account before it opens. Older configs that had sign-in turned off are switched on the next time the app loads. There is no local-only mode.

Create the account on that same screen (Sign in / Create account). There is no separate admin signup. After it succeeds you land on the board; restarting the app uses the refresh token until you sign out or it expires.

The auth-server URL is a setting. It starts at `http://100.101.141.93:8080`. Change it if yours lives somewhere else. Plain HTTP is allowed for that tailnet address (Tailscale `100.64.0.0/10`). Use HTTPS for anything else. A lab checkbox can allow HTTP to localhost or a private LAN in debug builds; release builds still refuse that.

Access and refresh tokens go in the OS keyring (`auth.access_token`, `auth.refresh_token`). The password is not stored. Broadcastify and other source secrets stay in the keyring too and are not sent to auth-server.

Boards, layout, and source setup (including the names of secrets, not their values) are stored on auth-server for the signed-in account. Signing in on another computer replaces the local board with that copy. The auth-server URL stays on this computer. If auth-server is unreachable, the board you already have stays put. `GET /settings` and `PUT /settings` are the account document; a missing route leaves the local board alone.

Sign out from the toolbar. The username stays filled in on the sign-in screen.

## Build installers

```bash
npm run tauri:build
```

Output under `src-tauri/target/release/bundle/`. Flatpak / `.deb` later — not in this shell.

## Tests

```bash
npm run test:rust
npm run build
```

## auth-server

The account API lives in [`nlaero/command-center-auth`](https://github.com/nlaero/command-center-auth): register, login, refresh, logout, `/auth/me`, and the board document at `/settings`. The desktop app is only a client. A server that does not have `/settings` yet still signs in; it just cannot restore a board until that route is deployed.

`npm run test:rust` does not contact that server. It uses an in-process fake on `127.0.0.1`. To run the same client against a local auth-server you started yourself:

```bash
AUTH_TEST_URL=http://127.0.0.1:8080 cargo test --manifest-path src-tauri/Cargo.toml --lib manual_local_auth_server -- --ignored --nocapture
```

That test refuses anything that is not loopback, including the tailnet address.

## Browser mock (`npm run dev`)

Vite in a normal browser with localStorage mocks. Useful for UI work only — no Tauri window, no OS app-data config, no portable override. Use `npm run tauri:dev` for the real app.

To sign in from the browser mock, point it at a local auth-server (the page proxies `/proxy/auth` so the browser does not need CORS):

```bash
CC_AUTH_BASE=http://127.0.0.1:8080 npm run dev
```
