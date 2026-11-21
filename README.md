# Command Center

`main` is the single-user desktop board for Windows and Linux. One person, one computer. There is no login. Settings and AI caption data stay on this computer.

[`multi-user`](https://github.com/nlaero/CommandCenter/tree/multi-user) is the future server version, branched from `main`. A server there can run on this computer or on another machine. Shared caption memory belongs on that branch. `main` keeps caption fixes on this computer.

Tauri 2 shell, React/TypeScript UI, config on disk. First launch is an empty board. You add panels from Settings. Live so far: weather (conditions + radar/satellite + local NWS alerts), NOAA space weather and aurora, traffic and road conditions for the region around a confirmed place, USGS earthquakes, news RSS, crime/incident open data, Broadcastify Feed Owner (personal feed status + archives), Broadcastify Calls, public cameras (search and recommendations), a private camera link, pasted image / video / HLS links, YouTube Live, a web scanner stream, X following (posts from accounts you follow), nearby public-safety alerts from online streams and audio inputs, and local audio captions from a jack or Bluetooth input. The same board also lists river stage, storm outlooks and reports, GOES-East lightning, a public agency feed you paste, transit alerts, flight restrictions, NRC event notices, the nearest EPA radiation station, Coast Guard spill calls, WHO disease notices, internet outages for the state, and home alarms on this network. Mounted source windows publish into the right-side alerts pane. X posts stay in their own panel. Headlines stay in the news panel.

Settings lists the panels already on the board. Each row can adjust that panel or delete it. New panel opens a grouped list of every source. After you pick one, you can make that panel rolling and add more sources, each with its own settings. A live picture or a live audio feed stays a single panel: the form warns and leaves it off the rotation. Weather stays a single panel too. The weather panel itself chooses which maps to show, how many are on screen, and whether those maps rotate.

## Audio rule

Anything that plays audio:

1. Starts **muted** (user unmutes).
2. Supports closed captions. They show on their own while the sound is muted. CC is a separate control that keeps them up after you turn the sound on.

Broadcastify Feed Owner plays muted. Captions for the live feed show on their own, including while the sound is off and before the player has produced sound. Unmute plays the relay. CC keeps them up after you turn the sound on. Earlier lines stay in a scrolling list, and a wrong line can be corrected on this computer. Nearby public safety does too: playback starts muted, captions follow the clip, and the alert keeps the transcript. An X post with video or audio starts muted, and captions show while the sound is off. An audio input there can be a Feed Owner source already on this computer, which reads that panel's caption history instead of the microphone. Transcription uses Tiny English from Settings → Local AI when it is installed, and a short placeholder until then. Crime/incident optional `audioUrl` starts muted; captions for that path are TODO. Public cameras, a private camera, pasted camera links, and YouTube Live start muted. A refreshing still image has no audio, so it is not transcribed and it has no caption line. HLS and video files use captions already in the stream (WebVTT or CEA-708). If there are none, Tiny English transcribes the audio on this computer, and the line stays empty when there is no speech. YouTube uses its own captions; that audio is not downloaded. Web scanner is its own window: a direct audio stream, muted until you turn sound on, with captions written on this computer while the sound is muted. It is not the Feed Owner panel and it does not feed nearby alerts. A jack or Bluetooth input starts muted and rolls captions from Tiny English on this computer. Scroll that list and it stays put until you jump to the latest line. A correction stays on this computer and is used the next time those words appear. Do not ship new audio playback without both mute-default and CC.

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
| Maps | yes | Local, regional, and nationwide. The panel chooses which of those to show, how many are on screen, and whether they rotate inside this panel. |
| Units | yes | Imperial or Metric |
| Show radar | no | Default on |
| Show satellite | no | Default on |
| Open-Meteo API key | no | Secret `weather.optional_key` |

**In the app:** Settings → Panels → Weather. Pick GPS, network location, or another source on this device, or type an address, and wait until the form says the location was found. Check the maps, set how many are on screen, and turn on rotation if you want the panel to step through them. Then units. Add panel. The window shows conditions, the confirmed place, a short hourly strip, and the maps you chose. Radar / Satellite chips toggle layers. Weather is not part of a rolling panel.

## Location

Weather, traffic, and ADS-B Exchange take a place in source settings. The choices are GPS, network location, other location services on this computer, or an address you type.

GPS asks the device for a high-accuracy satellite fix. Network location uses a Wi-Fi or cell reading when the operating system has one, and otherwise this computer's public IP address. Other device sources are the OS location service (GeoClue on Linux, or the browser's location service). An address is looked up through Photon, then Nominatim, then Open-Meteo. If several places match, pick one.

Command Center will not save the source until that lookup returns a real place. The form then shows the name, the coordinates, and which input produced them. Older sources that already have latitude and longitude still open; those coordinates count as already found.

## Traffic / road conditions

One source, centered on the same confirmed place as weather. Distance defaults to 80 miles and can be set from 5 to 200. The map frames that circle, and monitoring uses the same distance. Selecting a row highlights it. The Region control puts the map back on that circle. A Cameras list and the camera marks on the map open PennDOT stills inside the same distance.

A row that can change travel time (a closure, crash, lane restriction, meaningful delay, or an icy, snow-covered, or impassable road) also shows in the alerts pane while the window is on the board. Clear and wet road reports stay off the list. The map still draws when a feed is missing.

| Region | Feed | Auth |
|--------|------|------|
| Pennsylvania | PennDOT RCRS live incidents and winter conditions (`gisdata.penndot.pa.gov`) | Free username and password, secrets `penndot.username` and `penndot.password` |
| Pennsylvania cameras | 511PA stills (`www.511pa.com/map/Cctv/…`) | None. The still list does not use the incident username. |
| Maryland | CHART event and closure JSON (`chartexp1.sha.maryland.gov`) | None |
| Iowa | [511ia](https://511ia.org/) ArcGIS events and road conditions | None |
| British Columbia | [DriveBC Open511](https://api.open511.gov.bc.ca/events) | None. Open Government License - BC |
| Maine, New Hampshire, Vermont | New England Compass incident XML (`nec-por.ne-compass.com`) | None |

The app asks a feed only when that circle meets the feed's coverage. A place with no free feed still shows the map, and the note says so. Credentials stay in the OS keyring. The basemap is Esri Dark Gray. Ohio's OHGO key is not on this source right now.

**In the app:** Settings → Panels → Traffic / road conditions. Confirm a place the same way as weather. Set the distance. Save the PennDOT username and password only if this region reaches Pennsylvania and you want live incidents. Add panel. Open a camera from the Cameras list or from a mark on the map.

## PennDOT cameras

A second source, separate from traffic. Same confirmed place and the same kind of distance. It shows 511PA stills only, and it does not ask for a PennDOT key. Choose how many cameras are on screen at once, from 1 to 8. Turn on rotation and the view steps through the cameras inside that distance, keeping that many on screen. A still has no sound and no captions. The source stays in its own panel.

**In the app:** Settings → Panels → PennDOT cameras. Confirm a place, set the distance, set how many cameras show, and turn rotation on if you want it. Add panel.

## USGS earthquakes

[USGS GeoJSON summary feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). No key. The same feed includes earthquakes, tsunami flags (`properties.tsunami`), and other event types (blasts, landslides, eruptions, “other event”).

USGS updates these about once a minute and sends `Cache-Control: max-age=60` plus `Last-Modified`. The panel waits out that cache (and `Age` / `Retry-After`) and will not poll faster than once a minute. Repeat requests send `If-Modified-Since` and keep the previous body on 304.

| Setting | Required | Notes |
|---------|----------|--------|
| Feed | yes | Past hour through significant month. Past day includes non-quake types. |
| Max events | yes | Newest first (default 50, max 300) |
| Alerts magnitude | yes | Default 4.5. Also sends tsunami flags, PAGER yellow+, landslides, and volcanic eruptions to the alerts pane |
| Pan map to new events | no | Default on. Clicking a row always pans |

**In the app:** Settings → Panels → USGS earthquakes. Pick a feed. Add panel. The map opens on the newest event. Later polls move it to each new earthquake, tsunami flag, or other event. Drag to look around; +/- zooms. Basemap is Esri Dark Gray (CARTO's keyless raster tiles now ask for an API key). Credit Esri / OSM on the map; USGS stays in the footer.

While that window is on the board, notable rows (tsunami flag, PAGER yellow or higher, magnitude at or above the threshold, landslides, volcanic eruptions) show in the right-side alerts pane. Taking the window off the board removes them. Click a row in the pane for the USGS detail link.

## Space weather and aurora

[NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov/). No key. The panel waits at least 5 minutes between polls.

| Product | Path |
|---------|------|
| Alerts | `/products/alerts.json` |
| R, S, and G scales | `/products/noaa-scales.json` |
| Planetary Kp | `/products/noaa-planetary-k-index.json` |
| Estimated Kp | `/json/planetary_k_index_1m.json` |
| 10.7 cm flux | `/json/f107_cm_flux.json` |
| GOES X-ray | `/json/goes/primary/xrays-6-hour.json` |
| Aurora | `/json/ovation_aurora_latest.json` |

| Setting | Required | Notes |
|---------|----------|--------|
| Location | yes | Same choices as weather. The aurora chance is the OVATION point nearest that place. |
| Aurora map | yes | Auto, northern, or southern hemisphere |
| Show aurora map | no | Default on. The chance number stays when the map is off |

**Ham pairing.** Ham propagation / solar (`ham.swpc`) is already in the catalog. When that source is saved, this panel reads its bands and marks each one quiet, fair, poor, or aurora from the current G and R scales. That is storm impact. The ham source itself stays as it is.

While this window is on the board, a current G, S, or R of 1 or higher goes to the alerts pane, along with watches, warnings, and K-index alerts of 5 or higher from the last 72 hours (or still inside their valid-until time). Taking the window off the board removes them.

**In the app:** Settings → Panels → Space weather / aurora. Confirm a place. Add panel.

## News

Free RSS. No key. You pick the national outlets. Local outlets come from the same confirmed place as weather: up to three catalog feeds inside their radius, nearest first. If none cover that place, the local feed is a Google News search for the place name. Google publishes that search RSS for a personal reader.

Each feed is polled on its own schedule. The wait is the shortest hint the feed states — RSS `ttl`, the syndication update period, or the remaining `Cache-Control` max-age — and never shorter than a minute. A few-second CDN max-age does not override a longer ttl. If the feed states nothing, the panel waits 15 minutes. `Retry-After` can only make the wait longer. Refresh does not skip the wait. Repeat requests send `If-None-Match` and `If-Modified-Since` and keep the previous body on 304.

Headlines stay in the news panel. They are not copied to the alerts pane.

| Setting | Required | Notes |
|---------|----------|--------|
| Location | yes | Same confirmation as weather. Local outlets follow this place. |
| National outlets | yes | At least one |
| Max stories | yes | Newest first (default 40, max 100) |

**In the app:** Settings → Panels → News. Confirm the place, check the national outlets, and save. The window title uses the city. New stories flash in the list. Click a row for the summary and the story link.

## Crime / incident

Municipal open data via Socrata SODA or a custom GeoJSON/JSON URL. Not CrimeRadar / Squawster scraping (ToS). Licensed CrimeRadar APIs can come later behind flags.

| Setting | Required | Notes |
|---------|----------|--------|
| Provider | yes | `chicago`, `seattle`, or `custom` |
| Custom URL | if custom | HTTPS GeoJSON FeatureCollection, JSON array, or `{ incidents: [] }` |
| Max incidents | yes | Newest first (default 50) |
| Attribution | yes | Panel footer |
| Socrata App Token | no | Secret `socrata.app_token` — keyring preferred |

**In the app:** Settings → Panels → Crime / incident. Pick a provider (Chicago / Seattle fill attribution). Optional Socrata token. Add panel. New IDs flash in-panel; click a row for detail. Rows with `audioUrl` / `audio` get a muted player in the detail pane.

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
| Captions / transcription | no | Default on. Live captions run while the feed plays, including muted. CC keeps them after unmute |
| Username | yes | Secret `broadcastify.username` (filled in for this account) |
| Password | yes | Secret `broadcastify.password` (keyring only) |

Players start muted. Keep personal archive audio on-device — no cloud ASR upload.

With captions enabled, the live row starts muted and transcribes while it plays. The newest line sits above a scrolling list of earlier lines. Scroll up and the list stays put until Latest. Fix caption writes the correction to the caption store on this computer, and later lines pick it up. The history keeps the relay listen URL with any password removed, so another source can use that audio. Archive clips still use Transcribe local: Tiny English when it is installed, and a short placeholder until then. Live captions do not invent that placeholder. If Tiny English is not installed, the live line says so. With Tiny English installed, this computer records one short window of the relay and transcribes it here. If that fails, the line shows the reason in plain text. Audio stays on this computer.

**In the app:** Settings → Panels → Broadcastify (Feed Owner). Confirm the feed, enter the password, optional archive day. Add panel. The window is titled Penn Hills / Plum Police Dispatch. The toolbar shows online/offline and listeners. The list shows the live row and archives. The right side keeps only the audio controls and the captions. The live row starts muted, captions start even if that player has not produced sound yet, and unmute plays the relay. If the audio element cannot play the relay, this computer decodes a short window and plays that. Change day in the toolbar; use CC + Transcribe local on a clip when captions are on.

Live Owner API calls need the Tauri app. The browser Vite mock previews this feed without calling the API (CORS, and the password never leaves the desktop keyring).

## Broadcastify Calls

[Calls Client API](https://support.broadcastify.com/hc/en-us/articles/50488286518427-Broadcastify-Calls-Client-API) — `GET https://api.bcfy.io/calls/v1/live/` with one selector: `sid`, `groups` (1–5), or `nodeId`.

This is a separate source from Feed Owner. It does not change that panel. The live request returns individual call clips (MP3 on `calls.broadcastify.com`). A continuous Calls playlist can wait.

Auth is an HS256 JWT. The header carries `kid`, and the payload carries `iss`, `iat`, and `exp`. Key ID and issuer are filled in for the approved Command Center app. The signing secret is secret `broadcastify.calls.secret` and stays in the OS keyring. It is not written to the board file.

| Setting | Required | Notes |
|---------|----------|--------|
| Label | no | Panel title |
| Listen by | yes | System, groups, or node |
| System, groups, or node | yes | Numeric system or node id, or `sid-talkgroup` / `c-frequency` groups |
| Max clips | yes | Newest shown (default 40). The API still bills for the page it returns |
| Key ID | yes | JWT `kid`, filled in |
| Issuer | yes | JWT `iss`, filled in |
| Signing secret | yes | Keyring only |

Players start muted. Unmute a clip to hear it. Each refresh is a metered read, so the panel does not poll faster than every 30 seconds.

**In the app:** Settings → Panels → Broadcastify Calls. Confirm the system, groups, or node. Enter the signing secret. Add panel. The window lists the clips the API returned.

Live Calls requests need the Tauri app. The browser preview shows two sample clips after the secret field is filled and does not call the API.

## Web scanner

A direct audio stream in its own panel. Icecast, Shoutcast, an MP3, AAC, or Ogg link, or an HLS playlist (`.m3u8`). Paste a stream you are allowed to play.

A Broadcastify listen page, relay, or Calls link is refused. Your uploaded feed stays in Feed Owner. Calls stays in that source. Nearby alerts do not read this window.

| Setting | Required | Notes |
|---------|----------|--------|
| Name | yes | Panel title |
| Stream | yes | http or https. No password in the link — it is saved in the board file |
| Captions | no | Default on. Written on this computer. Shown while the sound is muted. CC keeps them after you turn the sound on |

Playback starts muted. The mute control turns the sound on and off. While the sound is muted, a short window of the stream is transcribed here with Tiny English when that model is installed. The newest line stays up, and earlier lines stay in a scrolling list. Scroll up and the list stays put until Latest. A wrong line can be corrected on this computer. If Tiny English is not installed, the line says so. The line stays empty of invented words. Audio is not uploaded.

**In the app:** Settings → Panels → Web scanner. Name the stream, paste the link, Add panel.

The browser preview plays the link too. Captions still run on this computer when Tiny English is installed.

## X following

Posts from accounts you follow, newest first. Sign in from the panel. Command Center does not ship an access token. The access token and refresh token stay in the OS keyring (`x.session.access_token`, `x.session.refresh_token`). A client secret, if the X app has one, is `x.client_secret` in the keyring. The client ID is the app id from the [developer portal](https://developer.x.com/), not a token, and it is the only X value saved in the board file.

The X app callback URL has to be `http://127.0.0.1:8737/callback`. Sign-in asks for `tweet.read`, `users.read`, and `offline.access`. The panel calls `GET /2/users/:id/timelines/reverse_chronological`.

Video and audio start muted. Captions show while the sound is off. CC keeps them up after you turn the sound on. Spoken words are transcribed on this computer with Tiny English when that model is installed. A still image has no audio line.

| Setting | Required | Notes |
|---------|----------|--------|
| Label | no | Panel title |
| Client ID | yes | X app client ID. Not an access token |
| Client secret | no | Keyring only, for a confidential app |
| Max posts | yes | Newest first, 5–100 |

**In the app:** Settings → Panels → X. Enter the client ID. Add panel. Sign in on the panel. The list scrolls. Posts that show up after the first load are marked.

The browser preview signs in locally and shows sample posts. It does not call X, and it does not use a real token. Live posts need the desktop app.

## Nearby public safety

Online streams and audio inputs (a jack, Bluetooth, or the sound card). Each feed stores the county and state it covers. There is no zip code list. A short window is recorded on this computer and transcribed with Tiny English when that model is installed. Those captions are the input. The reader takes a dispatch type and a street from the words, then looks the street up in that county and state. If the point sits inside the radius around your confirmed location, it shows on this panel and in the alerts pane.

A unit ID (Engine 12, Medic 4) is not a person. While that unit is dispatched, responding, or on scene, a later caption that names it stays on the same incident. Cleared, available, or left the scene releases the unit, and its next dispatch or response starts a new incident. The same person may keep one unit every day or move to another; a different person may use that unit ID tomorrow. This Tiny English build cannot learn a voice: whisper.cpp b5454 (`whisper-cli`, `ggml-tiny.en`) writes words and timestamps only, with no speaker key and no voice embedding. Command Center does not run a separate local diarizer and does not upload audio to identify a speaker. The hook is the optional `speaker` field on a transcript segment. It is stored as a person key, never as a unit ID. What is missing is a local diarizer that fills that key per person on this computer.

An audio input can also be a Broadcastify Feed Owner source already added in Settings. That choice does not open the microphone. It reads caption windows from that panel while the panel is playing, and the incident can play the relay URL stored with those captions. The URL has no password. If the panel is closed, the feed line says to open it.

Click a call for the transcript and the audio. Each transmission shows the unit that was on the air, and the person only when a local voice key is known. Playback starts muted. Captions are on unless you turn them off. The browser preview does not record a microphone or an online URL. It runs the reader on a sample: Engine 12 responding and on scene are one incident, Engine 12 clears, and the next response is a second incident. The person stays "not learned." A Feed Owner audio input in that preview still reads the panel captions instead of the sample.

| Setting | Required | Notes |
|---------|----------|--------|
| Your location | yes | Same choices as weather: GPS, network, another device source, or an address. Confirmed before save. |
| Radius | yes | Miles from that place, 1–100. Farther calls stay on the panel and off the alerts pane. |
| Feeds | yes | Online URL or an audio input. Name, county, and state on each. Up to 8. |
| Captions | no | Default on. Uses Tiny English from Settings → Local AI. |

ffmpeg has to be on PATH for a real recording. The desktop app records the feed. Audio is not uploaded.

**In the app:** Settings → Panels → Nearby public safety. Find your location, set the radius, add each feed with its county and state. Add panel.

## Local audio

A jack or a Bluetooth input on this computer, such as a scanner on the line-in. This window is not the Broadcastify panel and it is not nearby alerts.

Playback starts muted. Unmute on the panel to hear the latest recorded window. Captions run while the sound is off. CC keeps them up after the sound is turned on.

Tiny English on this computer writes the lines. They roll in a list. Scroll that list and it stays where you left it until you jump to the latest line. Fix caption stores the correction on this computer. The next time those words show up, the line uses the fix.

ffmpeg has to be on PATH to record the input. Audio is not uploaded. The browser preview does not record. It rolls sample lines so the list can be tried, and it says so.

| Setting | Required | Notes |
|---------|----------|--------|
| Label | no | Panel title |
| Audio input | yes | A jack or Bluetooth device on this computer |
| Captions | no | Default on. Tiny English from Settings → Local AI |

**In the app:** Settings → Panels → Local audio. Pick the input. Add panel.

## Cameras and YouTube

Public cameras, a private camera, a pasted camera link, and YouTube Live all use the same panel. It plays an HLS playlist (`.m3u8`, including a master playlist), an MP4 or WebM file, a still image, or a YouTube link. The window shows the picture and the camera label. A public camera also shows the agency credit. It does not print the rest of the saved fields.

**Public cameras.** Search the cameras shipped with the app, or confirm a place and the nearest ones come first. A search for a city also checks the published catalog for New York City, Caltrans, or Maryland when that place matches. Picking a camera fills in the link, the label, and how often a still refreshes. Those are New York City DOT stills, Caltrans stills, and Maryland CHART playlists. PennDOT stills are the PennDOT cameras source, and they also open from Traffic. PennDOT video is not in this search.

**Private camera.** Pick a brand or system (Frigate, go2rtc, Blue Iris, Scrypted, Synology, UniFi Protect, Reolink, Hikvision / Amcrest / Dahua, Axis, or Ring / Nest / Arlo) and follow the steps, then paste the stream link. A UDP or RTSP address does not play in this panel. The camera system has to give you an HLS playlist, a video file, a still, or a YouTube link. The link is saved with the board on this computer, so leave a password out of it when you can. Ring, Nest, and Arlo do not hand over a stream link; use Scrypted or Home Assistant on this network and paste the local link that bridge shows.

**Camera link.** Paste a still, a video file, or an HLS playlist you are allowed to view. Same panel as the two sources above.

A still image refreshes on the source interval. It has no audio, so the panel does not generate captions and does not show a caption line.

YouTube Live is its own source, and a YouTube link pasted on a camera plays the same way. Paste a watch link, a youtu.be link, a `/live/…` link, or a channel live URL (`/@name/live` or `/channel/UC…/live`). Picture, label, muted until you turn sound on.

Captions are only for a source that has sound. HLS WebVTT or CEA-708 is used when the playlist already has it, and YouTube uses its own captions. An HLS stream or video file with no caption track is transcribed here with Tiny English from Settings → Local AI. Music and a repeated non-speech phrase are not shown; if the audio has no speech the caption line stays empty. The lines show while the panel is muted. Turn the sound on and they hide, unless CC is on. CC does not have to be pressed for the muted case. A still image never takes this path. YouTube audio is not downloaded for this. Preparing the audio for the local model uses ffmpeg when it is on the computer, and otherwise decodes AAC, MP3, and MP4 here. RTSP and USB cameras still need a native player.

## Rolling panels

A panel can switch between sources that scroll. In Settings → Panels, choose the first source, turn on Make this panel rolling, add the others, and set how long each one stays up (15s, 30s, 1m, 5m, or 5–3600 seconds). They cycle in the order you add them. The toolbar shows the slot, the active source, a countdown, and pause / previous / next. The panel stores `rotation.enabled`, `intervalSec`, and `sourceIds`.

A live feed does not scroll, so the form warns and refuses to put it on a rolling panel. Leave it as its own panel. Weather is the same: its maps, the count, and the rotation stay inside the weather panel.

## More lists on the board

These sit next to the sources above. Each one is its own panel, and each one can join a rolling panel.

- River stage from NOAA, inside a radius of the confirmed place, with the forecast crest.
- Storm Prediction Center outlooks and local storm reports. General thunderstorms stay on the list and stay off the alerts pane.
- GOES-East lightning. Flashes outside the radius are dropped. The panel credits NOAA.
- A public agency RSS or Atom URL you paste. There is no directory of agencies, and meeting calendars stay out.
- Transit alerts. A place in the Pittsburgh area fills in the PRT bus and rail feeds. Anywhere else, paste the agency's alerts URL.
- FAA temporary flight restrictions whose shapes fall inside the radius, plus a short list of shapeless notices in this state.
- NRC event notices. Beaver Valley is called out when it appears.
- The nearest EPA RadNet station. A reading is notable when it leaves that station's own recent range.
- Coast Guard National Response Center caller reports for nearby counties. These are calls, not confirmed spills, and they do not include a cleanup status.
- WHO disease outbreak notices, a short global list.
- Internet outages for this state from Georgia Tech IODA, with that credit on the panel. Shown on this computer.
- Home alarms from a Home Assistant hub or an MQTT broker already on this network. Smoke, gas, and carbon monoxide trip as alerts. Water, doors, and gates warn. The token stays in the OS keyring.

## Shell behavior

- Empty board on first launch
- Settings → Panels lists the panels on the board. Adjust or delete one there. New panel is grouped: weather, storms, lightning, space weather, and ham; rivers, quakes, spills, radiation, and nuclear notices; traffic, PennDOT cameras, and transit; ADS-B and flight restrictions; radio, scanners, and cameras; news, X, crime, agency feeds, disease notices, and internet outages; home alarms; and the file / HTTP / SQLite / system-metrics stubs
- Add panel saves that source onto the board. A source that no panel uses is dropped when you save or delete a panel
- A rolling panel cycles sources that scroll. Live feeds and weather stay single panels
- Alerts pane on the right. It opens over the panels when alerts show up, and hides after the time in Settings → Alerts pane (default 1 minute; Off leaves it up). Pin keeps it open and shrinks the panels so they sit beside it. Clear alerts dismisses the current list for this session. New alerts still come in.
- Settings → Display sets the window size (1280×720 through 4K, this screen, or a custom size) and which screens the board uses. More than one screen splits the board. Saved on this computer.
- Settings → Television sends the board to one TV, or splits it across more than one. The TV is display-only. Each picture has to be 3840×2160 or higher so a 58-inch or larger set stays sharp. Setup stays on the computer.
- Edit layout (toolbar or `Ctrl/Cmd+E`): 48-column fine grid; persists on drag/resize stop
- Board switcher in the chrome (+ for another empty board)
- Help → Check for updates… (also the toolbar button, and Settings → Updates) asks GitHub if this copy is behind a published release. Nothing is downloaded until you choose it.

File, HTTP, SQLite, and system metrics stay stubs.

## Screens

Settings → Display lists the screens on this computer. Check more than one and the board is divided across them, using where those screens sit. Two side by side split it left and right. Screens stacked on top of each other split it top and bottom.

This computer keeps the toolbar and settings. Check this screen when it should show its own part of the board. Leave it unchecked and the whole board stays here while the other screens show their parts. Those other screens have no settings and no layout editing.

Each screen is drawn at its own size. A 3840×2160 screen stays sharp on a 58-inch or larger television. A smaller screen is not stretched, and it will look soft on a 58-inch set until that display is set to 4K. Edit layout on the computer shows the whole board, so a source can be moved onto another screen.

## Television

The board can go on a television. Setup stays on the computer. The television shows the board and nothing else: no settings, no layout editing.

Settings → Television.

**Screen mirroring.** The television has to already be a display on this computer (HDMI, or a wireless display the system is using). Pick that screen and show the board. Command Center opens a borderless window on it, at that screen's own resolution, and does not stretch a smaller picture up.

**AirPlay.** Command Center looks for AirPlay receivers on the local network. Pick one and show the board. When that receiver is already connected as a display — its name shows up as a screen — the board opens there. If it is not a display yet, connect it from this computer (HDMI, or the system's own AirPlay display) and try again. Nothing is configured on the television.

A 58-inch or larger television stays sharp at 3840×2160 or higher. A 1080p output is refused until that display is set to 4K. Apple TV HD and earlier top out at 1080p, so they are listed and refused. Apple TV 4K (1st, 2nd, and 3rd generation) is 3840×2160. The board fills that screen. Text stays vector-sharp. It is not a scaled-up screenshot.

Pick one television and it shows the whole board. Pick more than one and the board splits across them, at each screen's own 3840×2160 or higher. The computer is not one of those screens. Setup stays here.

Check the picture opens a preview on this computer. That preview is not the television.

The desktop app does the AirPlay search and places the window. A browser preview can list screens the browser is allowed to see, and it can open the picture check.

## On this computer

On `main`, the board opens without an account. Boards, layout, sources, and caption fixes are stored in the config folder on this computer. Source passwords and API keys stay in the OS keyring.

The client for the future server version is still in this tree (`src/lib/auth.ts`, `src-tauri/src/auth.rs`, and the sync modules). `AUTH_IN_APP` in `src/lib/authFeature.ts` and `src-tauri/src/config.rs` is off, so `main` does not sign in, install a server, or sync. That work continues on `multi-user`.

## Local AI

The Windows setup includes Tiny English (`ggml-tiny.en.bin`) and the whisper.cpp speech runtime. A new install already has them in `%AppData%\command-center\ai\`. Settings → Local AI shows Tiny English as installed, and live captions do not ask for a download. Remove model deletes that copy. Settings can download it again. On Linux, Settings → Local AI downloads Tiny English onto this computer (about 75 MB, plus the speech runtime). Audio is transcribed here. On `main`, caption fixes — what was heard, and what it should say — stay in `ai-memory.json` next to the config. Sharing that list across computers is part of `multi-user`, not this branch.

## Build installers

```bash
npm run tauri:build
```

Output under `src-tauri/target/release/bundle/`. Flatpak / `.deb` later — not in this shell.

The Windows setup `.exe` is built in GitHub Actions (`.github/workflows/release-windows.yml`). The build downloads the pinned Tiny English model and packs it into the installer. A pull request runs the build and uploads the installer as a build artifact. It does not publish a release. Pushing a `v*` tag publishes that installer on the GitHub release for the tag. The setup installs Command Center and Tiny English.

To compile that installer on a Windows machine, stage the model first:

```bash
node scripts/fetch-tiny-en.mjs
npm run tauri:build -- --bundles nsis
```

## Updates

On launch, Command Center asks GitHub whether [nlaero/CommandCenter](https://github.com/nlaero/CommandCenter/releases) has a release newer than what you are running. A release counts when its version is higher. `v0.1.0-test.1` is older than 0.1.0, so it does not nag. A prerelease that is actually newer still shows up, and the panel says so. If a stable release and a newer prerelease are both published, the install button follows the stable one.

Help → Check for updates… runs that check again. The toolbar button and Settings → Updates open the same panel. If the release has a Windows setup exe, Download and install saves it and starts it. Finish that setup to replace the app. On other systems the panel links the release instead of starting a Windows installer.

Checking does not publish a release. Installers stay unpublished until asked.

## Tests

```bash
npm run test:rust
node --experimental-strip-types src/lib/weatherMaps.test.ts
node --experimental-strip-types src/lib/news.test.ts
node --experimental-strip-types src/lib/safety.test.ts
node --experimental-strip-types src/lib/spaceWeather.test.ts
node --experimental-strip-types src/lib/traffic.test.ts
node --experimental-strip-types src/lib/penndotCameras.test.ts
node --experimental-strip-types src/lib/feedCaptions.test.ts
node --experimental-strip-types src/lib/localAudio.test.ts
node --experimental-strip-types src/lib/formFields.test.ts
node --experimental-strip-types src/lib/webScanner.test.ts
node --experimental-strip-types src/lib/xFollow.test.ts
node --experimental-strip-types src/lib/publicCameras.test.ts
node --experimental-strip-types src/lib/privateCameras.test.ts
node --experimental-strip-types src/lib/streamMedia.test.ts
npm run build
node scripts/fetch-tiny-en.test.mjs
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
