# Command Center

`main` is the single-user desktop board for Windows and Linux. One person, one computer. There is no login. Settings and AI caption data stay on this computer.

[`multi-user`](https://github.com/nlaero/CommandCenter/tree/multi-user) is the future server version, branched from `main`. A server there can run on this computer or on another machine. Shared caption memory belongs on that branch. `main` keeps caption fixes on this computer.

Tauri 2 shell, React/TypeScript UI, config on disk. First launch is an empty board. You add sources from Settings. Live so far: weather (conditions + radar/satellite + local NWS alerts), USGS earthquakes, crime/incident open data, and Broadcastify Feed Owner (personal feed status + archives). Mounted source windows publish into the right-side alerts pane.

## Audio rule

Anything that plays audio:

1. Starts **muted** (user unmutes).
2. Supports closed captions (on-device transcription preferred for personal archives).

Broadcastify Feed Owner already follows this (muted players + Settings captions / panel CC). Transcription uses Tiny English from Settings → Local AI when it is installed, and a short placeholder until then. Crime/incident optional `audioUrl` starts muted; captions for that path are TODO. Do not ship new audio playback without both mute-default and CC.

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
| Location | yes | GPS, network location, another device location service, or an address. The source cannot be saved until Command Center confirms the place. |
| Display scopes | yes | `local`, `regional`, `nationwide`, or combinations |
| Units | yes | Imperial or Metric |
| Show radar | no | Default on |
| Show satellite | no | Default on |
| Open-Meteo API key | no | Secret `weather.optional_key` |

**In the app:** Settings → Source catalog → Weather → Configure. Pick GPS, network location, or another source on this device, or type an address, and wait until the form says the location was found. Then scopes and units. Save, or Save & add to board. Panel shows conditions, the confirmed place, a short hourly strip, and a map per selected scope. Radar / Satellite chips toggle layers.

Add more Weather sources if you want separate panels per scope instead of a combo.

## Location

Weather and ADS-B Exchange take a place in source settings. The choices are GPS, network location, other location services on this computer, or an address you type.

GPS asks the device for a high-accuracy satellite fix. Network location uses a Wi-Fi or cell reading when the operating system has one, and otherwise this computer's public IP address. Other device sources are the OS location service (GeoClue on Linux, or the browser's location service). An address is looked up through Photon, then Nominatim, then Open-Meteo. If several places match, pick one.

Command Center will not save the source until that lookup returns a real place. The form then shows the name, the coordinates, and which input produced them. Older sources that already have latitude and longitude still open; those coordinates count as already found.

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

The form opens on **Penn Hills / Plum Police Dispatch** (feed `47291`, account `nlaero`). Pick "Another feed I own" to type a different feed id. The password is the Broadcastify account password and stays in the OS keyring.

`a=feed` returns the mount and relay. The panel builds a listen URL from those (`http://{relay}{mount}`, or https when the relay port is 443) and plays it muted. Feed status stays on the panel; archive clips can still show in the alerts pane.

| Setting | Required | Notes |
|---------|----------|--------|
| Feed | yes | Penn Hills / Plum, or another feed you own |
| Feed ID | if other | Numeric id from feed management / listen URL. Penn Hills is 47291 |
| Archive day | no | `YYYY-MM-DD`; blank lists available dates |
| Include archives | no | Default on |
| Captions / transcription | no | Default on; panel CC for archive and live audio |
| Username | yes | Secret `broadcastify.username` (filled in for this account) |
| Password | yes | Secret `broadcastify.password` (keyring only) |

Players start muted. Keep personal archive audio on-device — no cloud ASR upload.

With captions enabled, the panel shows CC and a captions pane. Transcribe local uses Tiny English from Settings → Local AI when it is installed, and a short placeholder until then. Audio stays on this computer.

**In the app:** Settings → Source catalog → Broadcastify (Feed Owner) → Configure. Confirm the feed, enter the password, optional archive day. Save & add to board. The window is titled Penn Hills / Plum Police Dispatch. It shows online/offline, listeners, and archives. Change day in the toolbar; use CC + Transcribe local on a clip when captions are on.

Live Owner API calls need the Tauri app. The browser Vite mock previews this feed without calling the API (CORS, and the password never leaves the desktop keyring).

## Timed panel rotation

Optional: cycle any combination of saved sources in one panel on a timer.

1. Configure at least two sources under Settings → Source catalog.
2. Settings → Panel rotation.
3. Turn on timed rotation.
4. Set title + interval (15s / 30s / 1m / 5m, or custom 5–3600s), check any mix of sources, Add rotating panel to board. They cycle in the order you check them.

Toolbar shows slot, active source, countdown, pause/prev/next. Config lives on the panel (`rotation.enabled`, `intervalSec`, `sourceIds`). Single-source panels are unchanged.

## Shell behavior

- Empty board on first launch
- Settings → Source catalog: weather, USGS earthquakes, ADS-B, cameras, ham, crime/incident, Broadcastify Feed Owner, plus file / HTTP / SQLite / system-metrics stubs
- Configure → Save or Save & add to board
- Settings → Panel rotation for any mix of configured sources in one panel
- Alerts pane on the right. It opens over the panels when alerts show up, and hides after the time in Settings → Alerts pane (default 1 minute; Off leaves it up). Pin keeps it open and shrinks the panels so they sit beside it. Clear alerts dismisses the current list for this session. New alerts still come in.
- Settings → Display sets the window size (1280×720 through 4K, this screen, or a custom size). Saved on this computer.
- Edit layout (toolbar or `Ctrl/Cmd+E`): 48-column fine grid; persists on drag/resize stop
- Board switcher in the chrome (+ for another empty board)
- Help → Check for updates… (also the toolbar button, and Settings → Updates) asks GitHub if this copy is behind a published release. Nothing is downloaded until you choose it.

Other catalog entries stay stubs until their adapters land.

## On this computer

On `main`, the board opens without an account. Boards, layout, sources, and caption fixes are stored in the config folder on this computer. Source passwords and API keys stay in the OS keyring.

The client for the future server version is still in this tree (`src/lib/auth.ts`, `src-tauri/src/auth.rs`, and the sync modules). `AUTH_IN_APP` in `src/lib/authFeature.ts` and `src-tauri/src/config.rs` is off, so `main` does not sign in, install a server, or sync. That work continues on `multi-user`.

## Local AI

Settings → Local AI downloads Tiny English onto this computer (about 75 MB, plus the speech runtime). Audio is transcribed here. On `main`, caption fixes — what was heard, and what it should say — stay in `ai-memory.json` next to the config. Sharing that list across computers is part of `multi-user`, not this branch. Removing the model leaves the local file in place.

## Build installers

```bash
npm run tauri:build
```

Output under `src-tauri/target/release/bundle/`. Flatpak / `.deb` later — not in this shell.

The Windows setup `.exe` is built in GitHub Actions (`.github/workflows/release-windows.yml`). A pull request runs the build and uploads the installer as a build artifact. It does not publish a release. Pushing a `v*` tag publishes that installer on the GitHub release for the tag. The setup installs Command Center.

## Updates

On launch, Command Center asks GitHub whether [nlaero/CommandCenter](https://github.com/nlaero/CommandCenter/releases) has a release newer than what you are running. A release counts when its version is higher. `v0.1.0-test.1` is older than 0.1.0, so it does not nag. A prerelease that is actually newer still shows up, and the panel says so. If a stable release and a newer prerelease are both published, the install button follows the stable one.

Help → Check for updates… runs that check again. The toolbar button and Settings → Updates open the same panel. If the release has a Windows setup exe, Download and install saves it and starts it. Finish that setup to replace the app. On other systems the panel links the release instead of starting a Windows installer.

Checking does not publish a release. Installers stay unpublished until asked.

## Tests

```bash
npm run test:rust
npm run build
```

## Future multi-user server

The [`multi-user`](https://github.com/nlaero/CommandCenter/tree/multi-user) branch is that version of this repo. [`nlaero/command-center-auth`](https://github.com/nlaero/command-center-auth) is its server, on this computer or on another machine. Shared caption memory belongs with that version. Neither is part of `main`.

The Rust tests for the parked client still use an in-process fake on `127.0.0.1`. To run that client against a server you started yourself:

```bash
AUTH_TEST_URL=http://127.0.0.1:8080 cargo test --manifest-path src-tauri/Cargo.toml --lib manual_local_auth_server -- --ignored --nocapture
```

That test refuses anything that is not loopback, including the tailnet address.

## Browser mock (`npm run dev`)

Vite in a normal browser with localStorage mocks. Useful for UI work only — no Tauri window, no OS app-data config, no portable override. Use `npm run tauri:dev` for the real app. The board opens the same way it does in the desktop app.
