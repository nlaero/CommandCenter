# Command Center

`main` is the single-user desktop board for Windows and Linux. One person, one computer. There is no login. Settings and AI caption data stay on this computer.

[`multi-user`](https://github.com/nlaero/CommandCenter/tree/multi-user) is the future server version, branched from `main`. A server there can run on this computer or on another machine. Shared caption memory belongs on that branch. `main` keeps caption fixes on this computer.

Tauri 2 shell, React/TypeScript UI, config on disk. First launch is an empty board. You add sources from Settings. Live so far: weather (conditions + radar/satellite + local NWS alerts), USGS earthquakes, crime/incident open data, Broadcastify Feed Owner (personal feed status + archives), public camera links (image, video file, or HLS), YouTube Live, and nearby public-safety alerts from online streams and audio inputs. Mounted source windows publish into the right-side alerts pane.

## Audio rule

Anything that plays audio:

1. Starts **muted** (user unmutes).
2. Supports closed captions. They show on their own while the sound is muted. CC is a separate control that keeps them up after you turn the sound on.

Broadcastify Feed Owner already follows this (muted players + Settings captions / panel CC). Nearby public safety does too: playback starts muted, captions follow the clip, and the alert keeps the transcript. Transcription uses Tiny English from Settings → Local AI when it is installed, and a short placeholder until then. Crime/incident optional `audioUrl` starts muted; captions for that path are TODO. Public camera links and YouTube Live start muted. A refreshing still image has no audio, so it is not transcribed and it has no caption line. HLS and video files use captions already in the stream (WebVTT or CEA-708). If there are none, Tiny English transcribes the audio on this computer, and the line stays empty when there is no speech. YouTube uses its own captions; that audio is not downloaded. Do not ship new audio playback without both mute-default and CC.

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

## Nearby public safety

Online streams and audio inputs (a jack, Bluetooth, or the sound card). Each feed stores the county and state it covers. There is no zip code list. A short window is recorded on this computer and transcribed with Tiny English when that model is installed. Those captions are the input. The reader takes a dispatch type and a street from the words, then looks the street up in that county and state. If the point sits inside the radius around your confirmed location, it shows on this panel and in the alerts pane.

A unit ID (Engine 12, Medic 4) is not a person. While that unit is dispatched, responding, or on scene, a later caption that names it stays on the same incident. Cleared, available, or left the scene releases the unit, and its next dispatch or response starts a new incident. The same person may keep one unit every day or move to another; a different person may use that unit ID tomorrow. This Tiny English build cannot learn a voice: whisper.cpp b5454 (`whisper-cli`, `ggml-tiny.en`) writes words and timestamps only, with no speaker key and no voice embedding. Command Center does not run a separate local diarizer and does not upload audio to identify a speaker. The hook is the optional `speaker` field on a transcript segment. It is stored as a person key, never as a unit ID. What is missing is a local diarizer that fills that key per person on this computer.

Click a call for the transcript and the audio. Each transmission shows the unit that was on the air, and the person only when a local voice key is known. Playback starts muted. Captions are on unless you turn them off. The browser preview does not record. It runs the reader on a sample: Engine 12 responding and on scene are one incident, Engine 12 clears, and the next response is a second incident. The person stays "not learned."

| Setting | Required | Notes |
|---------|----------|--------|
| Your location | yes | Same choices as weather: GPS, network, another device source, or an address. Confirmed before save. |
| Radius | yes | Miles from that place, 1–100. Farther calls stay on the panel and off the alerts pane. |
| Feeds | yes | Online URL or an audio input. Name, county, and state on each. Up to 8. |
| Captions | no | Default on. Uses Tiny English from Settings → Local AI. |

ffmpeg has to be on PATH for a real recording. The desktop app records the feed. Audio is not uploaded.

**In the app:** Settings → Source catalog → Nearby public safety → Configure. Find your location, set the radius, add each feed with its county and state. Save & add to board.

## Cameras and YouTube

Public / HTTP camera plays the link in the panel. A still image refreshes on the source interval. It has no audio, so the panel does not generate captions and does not show a caption line. An MP4 or WebM file plays in the video element. An HLS playlist (`.m3u8`), including a master playlist, is decoded in the panel. The window shows the picture and the camera label. It does not print the saved fields.

YouTube Live is its own source. Paste a watch link, a youtu.be link, a `/live/…` link, or a channel live URL (`/@name/live` or `/channel/UC…/live`). Same panel: picture, label, muted until you turn sound on.

Captions are only for a source that has sound. HLS WebVTT or CEA-708 is used when the playlist already has it, and YouTube uses its own captions. An HLS stream or video file with no caption track is transcribed here with Tiny English from Settings → Local AI. Music and a repeated non-speech phrase are not shown; if the audio has no speech the caption line stays empty. The lines show while the panel is muted. Turn the sound on and they hide, unless CC is on. CC does not have to be pressed for the muted case. A still image never takes this path. YouTube audio is not downloaded for this. Preparing the audio for the local model uses ffmpeg when it is on the computer, and otherwise decodes AAC, MP3, and MP4 here. RTSP and USB cameras still need a native player.

## Timed panel rotation

Optional: cycle any combination of saved sources in one panel on a timer.

1. Configure at least two sources under Settings → Source catalog.
2. Settings → Panel rotation.
3. Turn on timed rotation.
4. Set title + interval (15s / 30s / 1m / 5m, or custom 5–3600s), check any mix of sources, Add rotating panel to board. They cycle in the order you check them.

Toolbar shows slot, active source, countdown, pause/prev/next. Config lives on the panel (`rotation.enabled`, `intervalSec`, `sourceIds`). Single-source panels are unchanged.

## Shell behavior

- Empty board on first launch
- Settings → Source catalog: weather, USGS earthquakes, ADS-B, cameras (HTTP image / HLS / file, plus YouTube Live), ham, crime/incident, Broadcastify Feed Owner, nearby public safety, plus file / HTTP / SQLite / system-metrics stubs
- Configure → Save or Save & add to board
- Settings → Panel rotation for any mix of configured sources in one panel
- Alerts pane on the right. It opens over the panels when alerts show up, and hides after the time in Settings → Alerts pane (default 1 minute; Off leaves it up). Pin keeps it open and shrinks the panels so they sit beside it. Clear alerts dismisses the current list for this session. New alerts still come in.
- Settings → Display sets the window size (1280×720 through 4K, this screen, or a custom size). Saved on this computer.
- Settings → Television sends the board to a TV with AirPlay or screen mirroring. The TV is display-only. The picture has to be 3840×2160 or higher so a 58-inch or larger set stays sharp.
- Edit layout (toolbar or `Ctrl/Cmd+E`): 48-column fine grid; persists on drag/resize stop
- Board switcher in the chrome (+ for another empty board)
- Help → Check for updates… (also the toolbar button, and Settings → Updates) asks GitHub if this copy is behind a published release. Nothing is downloaded until you choose it.

Other catalog entries stay stubs until their adapters land.

## Television

The board can go on a television. Setup stays on the computer. The television shows the board and nothing else: no settings, no layout editing.

Settings → Television.

**Screen mirroring.** The television has to already be a display on this computer (HDMI, or a wireless display the system is using). Pick that screen and show the board. Command Center opens a borderless window on it, at that screen's own resolution, and does not stretch a smaller picture up.

**AirPlay.** Command Center looks for AirPlay receivers on the local network. Pick one and show the board. When that receiver is already connected as a display — its name shows up as a screen — the board opens there. If it is not a display yet, connect it from this computer (HDMI, or the system's own AirPlay display) and try again. Nothing is configured on the television.

A 58-inch or larger television stays sharp at 3840×2160 or higher. A 1080p output is refused until that display is set to 4K. Apple TV HD and earlier top out at 1080p, so they are listed and refused. Apple TV 4K (1st, 2nd, and 3rd generation) is 3840×2160. The board fills that screen. Text stays vector-sharp. It is not a scaled-up screenshot.

Check the picture opens a preview on this computer. That preview is not the television.

The desktop app does the AirPlay search and places the window. A browser preview can list screens the browser is allowed to see, and it can open the picture check.

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
node --experimental-strip-types src/lib/safety.test.ts
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
