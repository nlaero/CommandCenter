import type {
  AppState,
  ConfigPaths,
  FeedStatus,
  GridItem,
  Incident,
  LoadResult,
  Panel,
  SourceConfig,
  SourcePayload,
  ValidationResult,
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
    return JSON.parse(raw) as AppState;
  } catch {
    return defaultState();
  }
}

function writeBrowser(state: AppState): void {
  localStorage.setItem(BROWSER_KEY, JSON.stringify(state));
}

export async function loadAppState(): Promise<LoadResult> {
  if (!isTauri()) {
    const existing = localStorage.getItem(BROWSER_KEY);
    const state = existing ? readBrowser() : defaultState();
    if (!existing) writeBrowser(state);
    return { state, paths: defaultPaths(), created: !existing };
  }
  return invoke<LoadResult>("load_app_state");
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
    return state;
  }
  return invoke<AppState>("upsert_source", { args: { id, source, secrets } });
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
        str("primary_type", "offense_category", "category", "type") ?? undefined;
      const description =
        str("description", "nibrs_offense_code_description", "summary") ?? undefined;
      const title =
        str("title", "name") ??
        (category && description ? `${category} — ${description}` : undefined) ??
        description ??
        category ??
        str("offense_sub_category") ??
        `Incident ${index + 1}`;
      const severityText = (category ?? title).toUpperCase();
      const severity: Incident["severity"] = /HOMICIDE|MURDER|SHOOTING|ROBBERY|ASSAULT|WEAPON|RAPE/.test(
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
    throw new Error(`live fetch not implemented for source type: ${src.type}`);
  }
  return invoke<SourcePayload>("fetch_source_payload", {
    args: { sourceId, overrides },
  });
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
  const feedId = String(source.params.feedId ?? "0");
  const dayRaw = overrides.archiveDay ?? source.params.archiveDay;
  const day =
    typeof dayRaw === "string" && dayRaw.trim() ? dayRaw.trim() : undefined;

  const feed: FeedStatus = {
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
  };

  const status: Incident = {
    id: `feed-status-${feedId}`,
    title: `Online · ${feed.descr}`,
    category: feed.genre,
    description: "3 listeners · 16 kbps",
    occurredAt: new Date().toISOString(),
    address: "Demo, XX",
    lat: feed.lat,
    lon: feed.lon,
    detailUrl: `https://www.broadcastify.com/listen/feed/${feedId}`,
    severity: "info",
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
          description: "Browser fixture date — pick day to load demo clips.",
          occurredAt: `${iso}T00:00:00Z`,
          severity: i === 0 ? "warn" : "info",
        });
      }
    } else {
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
    attribution: `Broadcastify Feed Owner · feed ${feedId}`,
    note: "Browser fixture (CORS). Prefer npm run tauri:dev for live Owner API. Archives personal-use only.",
    incidents,
    feed,
  };
}

export async function addPanelToBoard(
  boardId: string,
  panel: Panel,
): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    const board = state.boards.find((b) => b.id === boardId);
    if (!board) throw new Error(`board not found: ${boardId}`);
    if (!state.sources[panel.source] || state.sources[panel.source].draft) {
      throw new Error("source must be saved and valid before adding to board");
    }
    board.panels.push(panel);
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("add_panel_to_board", { args: { boardId, panel } });
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
    return state;
  }
  return invoke<AppState>("create_board", { title });
}

export async function setActiveBoard(boardId: string): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    if (!state.boards.some((b) => b.id === boardId)) {
      throw new Error(`board not found: ${boardId}`);
    }
    state.activeBoardId = boardId;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("set_active_board", { boardId });
}

export async function setEditMode(enabled: boolean): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    state.editMode = enabled;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("set_edit_mode", { enabled });
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
      } else {
        const v = params[key];
        const empty =
          v === undefined ||
          v === null ||
          (typeof v === "number" && Number.isNaN(v)) ||
          String(v).trim() === "";
        if (empty) missing.push(key);
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
