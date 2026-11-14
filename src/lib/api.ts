import { withAuth } from "./auth";
import { AUTH_IN_APP } from "./authFeature";
import { PENN_HILLS_FEED, isPennHillsPreset } from "./broadcastifyPreset";
import { isMissingParam, readCoords } from "./location";
import { fetchUsgsInBrowser } from "./usgs";
import { xClientIdError } from "./xFollow";
import type {
  AppState,
  ConfigPaths,
  FeedStatus,
  GridItem,
  HourlyPoint,
  Incident,
  LoadResult,
  MapTile,
  Panel,
  ScopeView,
  SourceConfig,
  SourcePayload,
  ValidationResult,
  WeatherAlert,
  WeatherConditions,
  WeatherPayload,
  XAccount,
  XPost,
} from "../types";

const BROWSER_KEY = "command-center.app-state.v1";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

function defaultState(): AppState {
  return {
    version: 1,
    activeBoardId: "home",
    layout: { cols: 48, rowHeight: 12, margin: [4, 4] },
    boards: [{ id: "home", title: "Home", panels: [] }],
    sources: {},
    editMode: false,
    auth: {
      enabled: AUTH_IN_APP,
      baseUrl: "",
      allowInsecureHttp: false,
      caFile: null,
      tlsPinSha256: null,
    },
  };
}

function defaultPaths(): ConfigPaths {
  return {
    root: "(browser localStorage)",
    configFile: "(browser localStorage)",
    layoutsDir: "(browser localStorage)",
    overrideActive: false,
    overrideSource: null,
  };
}

function readBrowser(): AppState {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    if (!raw) return defaultState();
    return withAuth(JSON.parse(raw) as AppState);
  } catch {
    return defaultState();
  }
}

function writeBrowser(state: AppState): void {
  localStorage.setItem(BROWSER_KEY, JSON.stringify(state));
}

export function writeBrowserState(state: AppState): void {
  writeBrowser(withAuth(state));
}

function queuePublish(state: AppState): void {
  if (!state.auth?.enabled || isTauri()) return;
  void import("./sync")
    .then((mod) => mod.publishBoard(withAuth(state)))
    .catch(() => undefined);
}

export async function loadAppState(): Promise<LoadResult> {
  if (!isTauri()) {
    const existing = localStorage.getItem(BROWSER_KEY);
    const state = existing ? readBrowser() : defaultState();
    if (!existing) writeBrowser(state);
    return { state, paths: defaultPaths(), created: !existing };
  }
  const result = await invoke<LoadResult>("load_app_state");
  return { ...result, state: withAuth(result.state) };
}

export async function getConfigPaths(): Promise<ConfigPaths> {
  if (!isTauri()) return defaultPaths();
  return invoke<ConfigPaths>("get_config_paths");
}

export async function saveAppState(state: AppState): Promise<ConfigPaths> {
  if (!isTauri()) {
    writeBrowser(state);
    return defaultPaths();
  }
  return invoke<ConfigPaths>("save_app_state", { state });
}

export async function saveBoardLayout(
  boardId: string,
  items: GridItem[],
): Promise<void> {
  if (!isTauri()) {
    const state = readBrowser();
    const board = state.boards.find((b) => b.id === boardId);
    if (board) {
      for (const item of items) {
        const panel = board.panels.find((p) => p.id === item.i);
        if (panel) panel.layout = item;
      }
      writeBrowser(state);
      queuePublish(state);
    }
    return;
  }
  await invoke("save_board_layout", { args: { boardId, items } });
}

const BROWSER_SECRETS_KEY = "command-center.secrets.v1";

function readBrowserSecrets(): Record<string, string> {
  try {
    const raw = localStorage.getItem(BROWSER_SECRETS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeBrowserSecrets(secrets: Record<string, string>): void {
  localStorage.setItem(BROWSER_SECRETS_KEY, JSON.stringify(secrets));
}

export function browserSecretValues(): Record<string, string> {
  return readBrowserSecrets();
}

export async function upsertSource(
  id: string,
  source: SourceConfig,
  secrets: Record<string, string> = {},
): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    state.sources[id] = source;
    writeBrowser(state);
    if (Object.keys(secrets).length) {
      writeBrowserSecrets({ ...readBrowserSecrets(), ...secrets });
    }
    queuePublish(state);
    return state;
  }
  return withAuth(await invoke<AppState>("upsert_source", { args: { id, source, secrets } }));
}

export async function storeSecrets(secrets: Record<string, string>): Promise<void> {
  if (!isTauri()) {
    writeBrowserSecrets({ ...readBrowserSecrets(), ...secrets });
    return;
  }
  await invoke("store_secrets", { args: { secrets } });
}

const PRESET_ENDPOINTS: Record<string, { url: string; attribution: string }> = {
  chicago: {
    url: "https://data.cityofchicago.org/resource/ijzp-q8t2.json?$order=date DESC&$where=latitude IS NOT NULL",
    attribution: "City of Chicago Open Data — Crimes 2001 to Present",
  },
  seattle: {
    url: "https://data.seattle.gov/resource/tazs-3rd5.json?$order=offense_date DESC&$where=latitude IS NOT NULL",
    attribution: "City of Seattle Open Data — SPD Crime Data",
  },
};

function browserNormalizeIncidents(body: unknown): Incident[] {
  const asObj = body as Record<string, unknown> | unknown[];
  const rows: unknown[] = Array.isArray(asObj)
    ? asObj
    : Array.isArray((asObj as { features?: unknown }).features)
      ? ((asObj as { features: unknown[] }).features)
      : Array.isArray((asObj as { incidents?: unknown }).incidents)
        ? ((asObj as { incidents: unknown[] }).incidents)
        : [];

  return rows
    .map((row, index) => {
      const r = row as Record<string, unknown>;
      const props =
        r.properties && typeof r.properties === "object"
          ? (r.properties as Record<string, unknown>)
          : r;
      const str = (...keys: string[]) => {
        for (const k of keys) {
          const v = props[k];
          if (typeof v === "string" && v.trim()) return v;
          if (typeof v === "number") return String(v);
        }
        return undefined;
      };
      const num = (...keys: string[]) => {
        for (const k of keys) {
          const v = props[k];
          if (typeof v === "number") return v;
          if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
        }
        return undefined;
      };
      let lat = num("lat", "latitude", "y");
      let lon = num("lon", "lng", "longitude", "x");
      const coords = (r.geometry as { coordinates?: number[] } | undefined)?.coordinates;
      if ((lat == null || lon == null) && Array.isArray(coords) && coords.length >= 2) {
        lon = coords[0];
        lat = coords[1];
      }
      const category =
        str(
          "primary_type",
          "offense_sub_category",
          "nibrs_offense_code_description",
          "offense_category",
          "category",
          "type",
        ) ?? undefined;
      const description =
        str("description", "nibrs_offense_code_description", "summary") ?? undefined;
      const title =
        str("title", "name") ??
        (category && description ? `${category} — ${description}` : undefined) ??
        description ??
        category ??
        str("offense_sub_category") ??
        `Incident ${index + 1}`;
      const severityText = [category, description, title].filter(Boolean).join(" ").toUpperCase();
      const severity: Incident["severity"] =
        /HOMICIDE|MURDER|SHOOTING|ROBBERY|ASSAULT|WEAPON|RAPE|KIDNAP|SEX OFFENSE/.test(
        severityText,
      )
        ? "alert"
        : /BURGLARY|THEFT|MOTOR VEHICLE|ARSON|BATTERY|PROPERTY|CRIMINAL DAMAGE/.test(severityText)
          ? "warn"
          : "info";
      return {
        id: str("id", "case_number", "offense_id", "report_number") ?? `row-${index}`,
        title,
        category,
        description,
        occurredAt: str(
          "occurred_at",
          "occurredAt",
          "date",
          "offense_date",
          "report_date_time",
          "datetime",
        ),
        address: str("address", "block", "block_address", "location_description", "neighborhood"),
        lat,
        lon,
        audioUrl: str("audio_url", "audioUrl", "audio"),
        detailUrl: str("detail_url", "detailUrl", "url", "link"),
        severity,
      } satisfies Incident;
    })
    .sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")));
}

async function browserFetchIncident(source: SourceConfig): Promise<SourcePayload> {
  const provider = String(source.params.provider ?? "custom");
  const preset = PRESET_ENDPOINTS[provider];
  let endpoint =
    preset?.url ??
    (typeof source.params.endpoint === "string" ? source.params.endpoint : "");
  if (!endpoint) throw new Error("endpoint required for custom provider");
  const limit = Number(source.params.limit ?? 50) || 50;
  if (!endpoint.includes("$limit=") && !endpoint.includes("limit=")) {
    endpoint += `${endpoint.includes("?") ? "&" : "?"}$limit=${limit}`;
  }
  const secrets = readBrowserSecrets();
  const headers: Record<string, string> = {};
  const token = secrets["socrata.app_token"];
  if (token?.trim()) headers["X-App-Token"] = token.trim();
  const res = await fetch(endpoint, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching incidents`);
  const body = await res.json();
  const incidents = browserNormalizeIncidents(body).slice(0, limit);
  return {
    sourceId: "browser",
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution:
      (typeof source.params.attribution === "string" && source.params.attribution) ||
      preset?.attribution ||
      "Open data",
    note: "Browser mock fetch (CORS-dependent). Prefer npm run tauri:dev for production path.",
    incidents,
  };
}

const WMO: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Rain",
  71: "Snow",
  73: "Snow",
  75: "Snow",
  80: "Rain showers",
  81: "Rain showers",
  82: "Rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with hail",
};

function wmoDescription(code: number): string {
  return WMO[code] ?? "Unknown";
}

function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

function parseScopes(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,+| ]+/)) {
    const p = part.trim().toLowerCase();
    if ((p === "local" || p === "regional" || p === "nationwide") && !out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (Math.min(85.0511, Math.max(-85.0511, lat)) * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x, y };
}

function browserProxyUrl(
  kind: "rainviewer-tiles" | "goes",
  absoluteHttpsUrl: string,
): string {
  // Rewrite absolute provider URLs through Vite middleware for the browser mock only.
  if (kind === "goes") {
    return absoluteHttpsUrl.replace(
      "https://cdn.star.nesdis.noaa.gov",
      "/proxy/goes",
    );
  }
  return absoluteHttpsUrl.replace(
    "https://tilecache.rainviewer.com",
    "/proxy/rainviewer-tiles",
  );
}

/** Esri Dark Gray. Path is `{z}/{y}/{x}`. CARTO's keyless tiles now ask for an API key. */
const ESRI_DARK =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile";

const GOES_CONUS =
  "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/CONUS/GEOCOLOR/latest.jpg";
const GOES_FULL_DISK =
  "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/latest.jpg";

function buildScope(
  id: string,
  lat: number,
  lon: number,
  radarHost: string,
  radarPath: string | null,
  showSatellite: boolean,
): ScopeView {
  // RainViewer free personal API max zoom is 7 (2026 transition).
  const meta =
    id === "regional"
      ? { label: "Regional", zoom: 5, grid: 3, sat: GOES_CONUS }
      : id === "nationwide"
        ? { label: "Nationwide", zoom: 3, grid: 3, sat: GOES_FULL_DISK }
        : { label: "Local", zoom: 7, grid: 3, sat: GOES_CONUS };
  const { x: cx, y: cy } = latLonToTile(lat, lon, meta.zoom);
  const half = Math.floor(meta.grid / 2);
  const n = 2 ** meta.zoom;
  const tiles: MapTile[] = [];
  const host = radarHost.replace(/\/$/, "");
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      const x = (((cx + dx) % n) + n) % n;
      const baseUrl = `${ESRI_DARK}/${meta.zoom}/${y}/${x}`;
      tiles.push({
        x,
        y,
        z: meta.zoom,
        baseUrl,
        radarUrl: radarPath
          ? browserProxyUrl(
              "rainviewer-tiles",
              `${host}${radarPath}/256/${meta.zoom}/${x}/${y}/2/1_1.png`,
            )
          : undefined,
      });
    }
  }
  return {
    id,
    label: meta.label,
    zoom: meta.zoom,
    centerLat: lat,
    centerLon: lon,
    tiles,
    gridSize: meta.grid,
    satelliteImageUrl: showSatellite
      ? browserProxyUrl("goes", meta.sat)
      : undefined,
  };
}

async function browserFetchWeather(source: SourceConfig): Promise<SourcePayload> {
  const coords = readCoords(source.params, "lat", "lon");
  if (!coords) {
    throw new Error("latitude and longitude are required");
  }
  const { lat, lon } = coords;
  const units = String(source.params.units ?? "imperial");
  const scopes = parseScopes(String(source.params.scopes ?? "local"));
  if (!scopes.length) throw new Error("at least one scope is required");
  const showRadar = source.params.showRadar !== false;
  const showSatellite = source.params.showSatellite !== false;

  const omUrl =
    `/proxy/open-meteo/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,` +
    `wind_speed_10m,wind_direction_10m,surface_pressure` +
    `&hourly=temperature_2m,weather_code&forecast_hours=12&timezone=auto&wind_speed_unit=kmh`;
  const omRes = await fetch(omUrl);
  if (!omRes.ok) throw new Error(`HTTP ${omRes.status} fetching Open-Meteo`);
  const om = (await omRes.json()) as {
    current?: Record<string, number | string>;
    hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] };
  };
  const cur = om.current ?? {};
  const tempC = Number(cur.temperature_2m ?? 0);
  const feelsC = Number(cur.apparent_temperature ?? tempC);
  const code = Number(cur.weather_code ?? 0);
  const windKmh = Number(cur.wind_speed_10m ?? 0);
  const conditions: WeatherConditions = {
    tempC,
    tempF: cToF(tempC),
    feelsLikeC: feelsC,
    feelsLikeF: cToF(feelsC),
    humidity: Number(cur.relative_humidity_2m ?? 0),
    windKmh,
    windMph: windKmh * 0.621371,
    windDir: cur.wind_direction_10m != null ? Number(cur.wind_direction_10m) : undefined,
    pressureHpa: cur.surface_pressure != null ? Number(cur.surface_pressure) : undefined,
    weatherCode: code,
    description: wmoDescription(code),
    lat,
    lon,
    observedAt: typeof cur.time === "string" ? cur.time : undefined,
  };
  const hourly: HourlyPoint[] = [];
  const times = om.hourly?.time ?? [];
  for (let i = 0; i < Math.min(12, times.length); i++) {
    const tC = om.hourly?.temperature_2m?.[i] ?? 0;
    const c = om.hourly?.weather_code?.[i] ?? 0;
    hourly.push({
      time: times[i],
      tempC: tC,
      tempF: cToF(tC),
      weatherCode: c,
      description: wmoDescription(c),
    });
  }

  let radarPath: string | null = null;
  let radarHost = "https://tilecache.rainviewer.com";
  let radarTime: number | undefined;
  if (showRadar) {
    try {
      const mapsRes = await fetch("/proxy/rainviewer-api/public/weather-maps.json");
      if (mapsRes.ok) {
        const maps = (await mapsRes.json()) as {
          host?: string;
          radar?: { past?: { time: number; path: string }[] };
        };
        if (maps.host) radarHost = maps.host;
        const radarFrames = maps.radar?.past ?? [];
        if (radarFrames.length) {
          const last = radarFrames[radarFrames.length - 1];
          radarTime = last.time;
          radarPath = last.path;
        }
      }
    } catch {
      // conditions still useful
    }
  }

  const satelliteImageUrl = showSatellite
    ? browserProxyUrl("goes", GOES_CONUS)
    : undefined;

  const alerts = await browserFetchNwsAlerts(lat, lon);

  const weather: WeatherPayload = {
    units,
    conditions,
    hourly,
    scopes: scopes.map((id) =>
      buildScope(id, lat, lon, radarHost, radarPath, showSatellite),
    ),
    layers: { showRadar, showSatellite, radarTime, satelliteImageUrl },
    alerts,
  };

  return {
    sourceId: "browser",
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution:
      "Open-Meteo · RainViewer radar · NOAA GOES / NESDIS satellite · NWS alerts · Esri basemap",
    note: "Browser mock fetch via Vite proxy. Prefer npm run tauri:dev for the native path.",
    incidents: [],
    weather,
  };
}

async function browserFetchNwsAlerts(lat: number, lon: number): Promise<WeatherAlert[]> {
  try {
    const res = await fetch(`/proxy/nws/alerts/active?point=${lat},${lon}`);
    if (!res.ok) return [];
    const body = (await res.json()) as {
      features?: Array<{
        id?: string;
        properties?: Record<string, string | null | undefined>;
      }>;
    };
    const out: WeatherAlert[] = [];
    for (const feature of body.features ?? []) {
      const props = feature.properties ?? {};
      const id = String(props.id ?? feature.id ?? "").trim();
      if (!id) continue;
      out.push({
        id,
        event: String(props.event ?? "Weather alert"),
        headline: props.headline ?? undefined,
        description: props.description ?? undefined,
        severity: String(props.severity ?? "Unknown"),
        urgency: props.urgency ?? undefined,
        area: props.areaDesc ?? undefined,
        onset: props.onset ?? undefined,
        ends: props.ends ?? props.expires ?? undefined,
        expires: props.expires ?? undefined,
        sender: props.senderName ?? undefined,
        detailUrl: props["@id"] ?? props.id ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchSourcePayload(
  sourceId: string,
  source?: SourceConfig,
  overrides: Record<string, unknown> = {},
): Promise<SourcePayload> {
  if (!isTauri()) {
    const state = readBrowser();
    const src = source ?? state.sources[sourceId];
    if (!src) throw new Error(`source not found: ${sourceId}`);
    if (src.type === "incident.opendata") {
      const payload = await browserFetchIncident(src);
      return { ...payload, sourceId };
    }
    if (src.type === "broadcastify.owner") {
      const payload = browserFetchBroadcastify(src, overrides);
      return { ...payload, sourceId };
    }
    if (src.type === "broadcastify.calls") {
      const payload = browserFetchCalls(src);
      return { ...payload, sourceId };
    }
    if (src.type === "weather.openmeteo") {
      const payload = await browserFetchWeather(src);
      return { ...payload, sourceId };
    }
    if (src.type === "usgs.earthquake") {
      return fetchUsgsInBrowser(sourceId, src);
    }
    if (src.type === "x.follow") {
      const payload = browserFetchX(src);
      return { ...payload, sourceId };
    }
    throw new Error(`live fetch not implemented for source type: ${src.type}`);
  }
  return invoke<SourcePayload>("fetch_source_payload", {
    args: { sourceId, overrides },
  });
}

/** Browser preview — fixture clips only. The desktop app calls the Calls API. */
function browserFetchCalls(source: SourceConfig): SourcePayload {
  const secrets = readBrowserSecrets();
  const signing = secrets["broadcastify.calls.secret"]?.trim();
  if (!signing) {
    throw new Error(
      "Broadcastify Calls signing secret is required. It stays in the OS keyring. The browser preview cannot call the Calls API — use the desktop app for live clips.",
    );
  }
  const label =
    typeof source.params.label === "string" && source.params.label.trim()
      ? source.params.label.trim()
      : "Broadcastify Calls";
  const selectorId = String(source.params.selectorId ?? "").trim() || "preview";
  const now = Date.now();
  const clip = (offsetMin: number, title: string, file: string): Incident => {
    const when = new Date(now - offsetMin * 60_000).toISOString();
    return {
      id: `preview-${selectorId}-${offsetMin}`,
      title,
      category: "call",
      description: "Browser preview clip. The desktop app loads the clip URL from the Calls API.",
      occurredAt: when,
      address: label,
      audioUrl: file,
      severity: "info",
    };
  };
  return {
    sourceId: "browser",
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution: "Broadcastify Calls",
    note: "Browser preview. Live clips come from the Calls API in the desktop app. Playback starts muted. A live playlist is not played.",
    incidents: [
      clip(2, "Preview clip · newer", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"),
      clip(9, "Preview clip · earlier", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3"),
    ],
  };
}

const PREVIEW_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Browser preview. Live posts need the desktop app, which keeps the X tokens in the OS keyring. */
function browserFetchX(source: SourceConfig): SourcePayload {
  const secrets = readBrowserSecrets();
  if (secrets["x.session.access_token"] !== "browser-preview") {
    throw new Error("Sign in to X to load posts from accounts you follow.");
  }
  const now = Date.now();
  const post = (
    minutesAgo: number,
    id: string,
    handle: string,
    name: string,
    text: string,
    media: XPost["media"] = [],
  ): XPost => ({
    id,
    text,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    authorName: name,
    authorHandle: handle,
    url: `https://x.com/${handle}/status/${id}`,
    media,
  });
  const posts = [
    post(1, "1001", "river", "River Gauge", "A new post from an account you follow."),
    post(4, "1002", "field", "Field Audio", "Clip from the follow feed. Playback starts muted.", [
      {
        kind: "audio",
        url: PREVIEW_WAV,
        alt: "Preview clip. Playback starts muted.",
      },
    ]),
    post(9, "1003", "ada", "Ada Lovelace", "Notes from the timeline, newest first."),
    post(15, "1004", "north", "North Desk", "Another post further down the list."),
    post(22, "1005", "south", "South Desk", "Scroll the list for older posts from accounts you follow."),
    post(31, "1006", "east", "East Desk", "The desktop app loads this from the X follow timeline."),
    post(40, "1007", "west", "West Desk", "Sample row so the panel can scroll."),
    post(55, "1008", "harbor", "Harbor Light", "Oldest sample post in this preview."),
  ];
  const label = typeof source.params.label === "string" ? source.params.label.trim() : "";
  return {
    sourceId: "browser",
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution: "X",
    note: label
      ? `${label}. Browser preview. The desktop app signs in to X and keeps the token in the OS keyring. Video and audio start muted.`
      : "Browser preview. The desktop app signs in to X and keeps the token in the OS keyring. Video and audio start muted.",
    incidents: [],
    xFeed: {
      username: secrets["x.session.username"] || "preview",
      posts: posts.slice(0, Math.max(5, Math.min(100, Number(source.params.limit) || 20))),
    },
  };
}

export async function xAccount(): Promise<XAccount> {
  if (!isTauri()) return browserXAccount();
  return invoke<XAccount>("x_account");
}

export async function xBeginSignIn(sourceId: string): Promise<{ authorizeUrl: string }> {
  if (!isTauri()) {
    const state = readBrowser();
    const source = state.sources[sourceId];
    const clientId = String(source?.params.clientId ?? "");
    const problem = xClientIdError(clientId);
    if (problem) throw new Error(problem);
    writeBrowserSecrets({
      ...readBrowserSecrets(),
      "x.session.access_token": "browser-preview",
      "x.session.username": "preview",
      "x.session.name": "Preview account",
    });
    return { authorizeUrl: "" };
  }
  return invoke<{ authorizeUrl: string }>("x_begin_sign_in", { sourceId });
}

export async function xPollSignIn(): Promise<XAccount | null> {
  if (!isTauri()) return browserXAccount();
  return invoke<XAccount | null>("x_poll_sign_in");
}

export async function xSignOut(): Promise<XAccount> {
  if (!isTauri()) {
    const secrets = { ...readBrowserSecrets() };
    delete secrets["x.session.access_token"];
    delete secrets["x.session.username"];
    delete secrets["x.session.name"];
    writeBrowserSecrets(secrets);
    return { signedIn: false, username: null, name: null };
  }
  return invoke<XAccount>("x_sign_out");
}

function browserXAccount(): XAccount {
  const secrets = readBrowserSecrets();
  if (secrets["x.session.access_token"] !== "browser-preview") {
    return { signedIn: false, username: null, name: null };
  }
  return {
    signedIn: true,
    username: secrets["x.session.username"] || "preview",
    name: secrets["x.session.name"] || "Preview account",
  };
}

/** Browser UI mock — fixture only (Owner API is not CORS-friendly). Prefer tauri:dev. */
function browserFetchBroadcastify(
  source: SourceConfig,
  overrides: Record<string, unknown>,
): SourcePayload {
  const secrets = readBrowserSecrets();
  const user = secrets["broadcastify.username"]?.trim();
  const pass = secrets["broadcastify.password"]?.trim();
  if (!user || !pass) {
    throw new Error(
      "Broadcastify username/password required (stored as secrets; never in config). Browser mock cannot call the Owner API — use npm run tauri:dev for live fetch.",
    );
  }
  const personal = isPennHillsPreset(source.params);
  const feedId = personal
    ? PENN_HILLS_FEED.feedId
    : String(source.params.feedId ?? "0");
  const dayRaw = overrides.archiveDay ?? source.params.archiveDay;
  const day =
    typeof dayRaw === "string" && dayRaw.trim() ? dayRaw.trim() : undefined;

  const feed: FeedStatus = personal
    ? {
        feedId,
        online: false,
        descr: PENN_HILLS_FEED.name,
        genre: PENN_HILLS_FEED.genre,
        county: PENN_HILLS_FEED.county,
        state: PENN_HILLS_FEED.state,
        lat: PENN_HILLS_FEED.lat,
        lon: PENN_HILLS_FEED.lon,
      }
    : {
        feedId,
        online: true,
        listeners: 3,
        descr: `Demo feed ${feedId}`,
        genre: "Public Safety",
        bitrate: 16,
        county: "Demo",
        state: "XX",
        lat: 30.27,
        lon: -97.74,
        relay: "relay.broadcastify.com",
        mount: "/demo",
        streamUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
      };

  const status: Incident = {
    id: `feed-status-${feedId}`,
    title: `${feed.online ? "Online" : "Offline"} · ${feed.descr}`,
    category: "feed-status",
    description: personal
      ? `${PENN_HILLS_FEED.detail}. Browser preview — the desktop app polls the Feed Owner API.`
      : "3 listeners · 16 kbps",
    occurredAt: new Date().toISOString(),
    address: personal
      ? `${PENN_HILLS_FEED.county}, ${PENN_HILLS_FEED.state}`
      : "Demo, XX",
    lat: feed.lat,
    lon: feed.lon,
    audioUrl: feed.streamUrl,
    detailUrl: `https://www.broadcastify.com/listen/feed/${feedId}`,
    severity: feed.online ? "info" : "alert",
  };

  let incidents: Incident[] = [status];
  if (source.params.includeArchives !== false) {
    if (!day) {
      const today = new Date();
      for (let i = 0; i < 3; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const iso = d.toISOString().slice(0, 10);
        incidents.push({
          id: `archive-day-${iso}`,
          title: `Archives · ${iso}`,
          category: "archive-day",
          description: personal
            ? "Browser preview date. Clip URLs load from the Feed Owner API in the desktop app."
            : "Browser fixture date — pick day to load demo clips.",
          occurredAt: `${iso}T00:00:00Z`,
          severity: i === 0 ? "warn" : "info",
        });
      }
    } else if (!personal) {
      incidents = [
        status,
        {
          id: `archive-${day}-a`,
          title: `Archive ${day}T10:00:00 – ${day}T10:30:00`,
          category: "archive",
          description: `Ends ${day}T10:30:00`,
          occurredAt: `${day}T10:00:00Z`,
          address: day,
          audioUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
          detailUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
          severity: "info",
        },
        {
          id: `archive-${day}-b`,
          title: `Archive ${day}T09:30:00 – ${day}T10:00:00`,
          category: "archive",
          description: `Ends ${day}T10:00:00`,
          occurredAt: `${day}T09:30:00Z`,
          address: day,
          audioUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
          detailUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
          severity: "info",
        },
      ];
    }
  }

  return {
    sourceId: "browser",
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution: personal
      ? `Broadcastify Feed Owner · ${PENN_HILLS_FEED.name} · feed ${feedId}`
      : `Broadcastify Feed Owner · feed ${feedId}`,
    note: personal
      ? "Browser preview. Live status, relay audio, and archive files come from the Feed Owner API in the desktop app. Archives are personal-use only."
      : "Browser fixture (CORS). Prefer npm run tauri:dev for live Owner API. Archives personal-use only.",
    incidents,
    feed,
  };
}

function assertPanelSourcesReady(
  state: AppState,
  panel: Panel,
): void {
  const rotationIds =
    panel.rotation?.enabled ? panel.rotation.sourceIds : [];
  const required = [panel.source, ...rotationIds.filter((id) => id !== panel.source)];

  if (panel.rotation?.enabled) {
    if (panel.rotation.sourceIds.length < 2) {
      throw new Error("rotating panel needs at least two configured sources");
    }
    if (panel.rotation.intervalSec < 5 || panel.rotation.intervalSec > 3600) {
      throw new Error("rotation interval must be between 5 and 3600 seconds");
    }
  }

  for (const sourceId of required) {
    const source = state.sources[sourceId];
    if (!source || source.draft) {
      throw new Error(
        `source ${sourceId} must be saved and valid before adding to board`,
      );
    }
    if (!source.enabled) {
      throw new Error(`source ${sourceId} is disabled`);
    }
  }
}

export async function addPanelToBoard(
  boardId: string,
  panel: Panel,
): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    const board = state.boards.find((b) => b.id === boardId);
    if (!board) throw new Error(`board not found: ${boardId}`);
    assertPanelSourcesReady(state, panel);
    board.panels.push(panel);
    writeBrowser(state);
    queuePublish(state);
    return state;
  }
  return withAuth(await invoke<AppState>("add_panel_to_board", { args: { boardId, panel } }));
}

export async function createBoard(title: string): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    const id = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `board-${Date.now()}`;
    if (state.boards.some((b) => b.id === id)) {
      throw new Error(`board id already exists: ${id}`);
    }
    state.boards.push({ id, title, panels: [] });
    state.activeBoardId = id;
    writeBrowser(state);
    queuePublish(state);
    return state;
  }
  return withAuth(await invoke<AppState>("create_board", { title }));
}

export async function setActiveBoard(boardId: string): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    if (!state.boards.some((b) => b.id === boardId)) {
      throw new Error(`board not found: ${boardId}`);
    }
    state.activeBoardId = boardId;
    writeBrowser(state);
    queuePublish(state);
    return state;
  }
  return withAuth(await invoke<AppState>("set_active_board", { boardId }));
}

export async function setEditMode(enabled: boolean): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    state.editMode = enabled;
    writeBrowser(state);
    return state;
  }
  return withAuth(await invoke<AppState>("set_edit_mode", { enabled }));
}

export async function validateSourceFields(
  required: string[],
  params: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<ValidationResult> {
  if (!isTauri()) {
    const missing: string[] = [];
    for (const key of required) {
      if (key.startsWith("secret:")) {
        const name = key.slice("secret:".length);
        if (!secrets[name]?.trim()) missing.push(key);
      } else if (isMissingParam(params[key])) {
        missing.push(key);
      }
    }
    return {
      ok: missing.length === 0,
      missing,
      message:
        missing.length === 0
          ? "ok"
          : `missing required fields: ${missing.join(", ")}`,
    };
  }
  return invoke<ValidationResult>("validate_source_fields", {
    required,
    params,
    secrets,
  });
}

export function newId(prefix: string): string {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}`;
}
