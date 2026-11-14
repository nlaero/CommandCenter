export type GridItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
};

/** Optional timed multi-source rotation inside one board panel (Settings opt-in). */
export type PanelRotation = {
  enabled: boolean;
  /** Seconds between source switches; clamped in UI (5–3600). */
  intervalSec: number;
  /** Ordered source ids to cycle; requires ≥2 when enabled. */
  sourceIds: string[];
};

export type Panel = {
  id: string;
  title: string;
  widget: string;
  /** Primary / fallback source binding (first rotation entry when rotating). */
  source: string;
  options: Record<string, unknown>;
  layout: GridItem;
  rotation?: PanelRotation;
};

export type Board = {
  id: string;
  title: string;
  panels: Panel[];
};

export type SourceConfig = {
  type: string;
  params: Record<string, unknown>;
  refresh?: string;
  secrets: string[];
  enabled: boolean;
  draft: boolean;
};

export type LayoutSettings = {
  cols: number;
  rowHeight: number;
  margin: [number, number];
};

/** Auth-server location and whether this computer requires a session. */
export type AuthSettings = {
  enabled: boolean;
  /** Origin only, no path. Default is the tailnet auth-server. */
  baseUrl: string;
  /** Extra HTTP for a named lab host (.local / .lan). Private LAN, loopback, and Tailscale do not need this. */
  allowInsecureHttp: boolean;
  caFile?: string | null;
  tlsPinSha256?: string | null;
};

export type AuthUser = {
  id: string;
  username: string;
};

export type AuthSession = {
  enabled: boolean;
  baseUrl: string;
  allowInsecureHttp: boolean;
  signedIn: boolean;
  offline: boolean;
  user?: AuthUser | null;
  suggestedUsername?: string | null;
  reachable?: boolean | null;
  statusMessage?: string | null;
};

export type AuthProbe = {
  reachable: boolean;
  message: string;
};

export type AppState = {
  version: number;
  activeBoardId: string;
  layout: LayoutSettings;
  boards: Board[];
  sources: Record<string, SourceConfig>;
  editMode: boolean;
  auth: AuthSettings;
};

export type ConfigPaths = {
  root: string;
  configFile: string;
  layoutsDir: string;
  overrideActive: boolean;
  overrideSource?: string | null;
};

export type LoadResult = {
  state: AppState;
  paths: ConfigPaths;
  created: boolean;
};

export type SyncResult = {
  state: AppState;
  restored: boolean;
  published: boolean;
  message?: string | null;
};

export type FieldKind =
  | "string"
  | "number"
  | "url"
  | "secret"
  | "boolean"
  | "select"
  | "checklist"
  | "location"
  | "feeds";

export type AdapterField = {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
  secret?: boolean;
  /** Unset booleans display and behave as checked. An explicit false stays off. */
  defaultChecked?: boolean;
  /** Param keys written when kind is `location`. Defaults are lat / lon. */
  latKey?: string;
  lonKey?: string;
};

export type AdapterDefinition = {
  typeId: string;
  category: "product" | "foundation";
  name: string;
  description: string;
  defaultWidget: string;
  defaultRefresh?: string;
  fields: AdapterField[];
  stubNote?: string;
};

export type ValidationResult = {
  ok: boolean;
  missing: string[];
  message: string;
};

export type IncidentSeverity = "info" | "warn" | "alert";

export type Incident = {
  id: string;
  title: string;
  category?: string;
  description?: string;
  occurredAt?: string;
  address?: string;
  lat?: number;
  lon?: number;
  audioUrl?: string;
  detailUrl?: string;
  severity?: IncidentSeverity;
  /** Words heard on an audio alert, when the source already has them. */
  transcript?: string;
};

export type FeedStatus = {
  feedId: string;
  online: boolean;
  listeners?: number;
  descr?: string;
  genre?: string;
  bitrate?: number;
  mount?: string;
  /** Relay hostname from the Feed Owner `Relays` array. */
  relay?: string;
  /** Listen URL built from relay host/port + mount. Personal feed only. */
  streamUrl?: string;
  lat?: number;
  lon?: number;
  county?: string;
  state?: string;
};

export type WeatherConditions = {
  tempC: number;
  tempF: number;
  feelsLikeC: number;
  feelsLikeF: number;
  humidity: number;
  windKmh: number;
  windMph: number;
  windDir?: number;
  pressureHpa?: number;
  weatherCode: number;
  description: string;
  lat: number;
  lon: number;
  observedAt?: string;
};

export type HourlyPoint = {
  time: string;
  tempC: number;
  tempF: number;
  weatherCode: number;
  description: string;
};

export type MapTile = {
  x: number;
  y: number;
  z: number;
  baseUrl: string;
  radarUrl?: string;
};

export type ScopeView = {
  id: string;
  label: string;
  zoom: number;
  centerLat: number;
  centerLon: number;
  tiles: MapTile[];
  gridSize: number;
  satelliteImageUrl?: string;
};

export type WeatherLayers = {
  showRadar: boolean;
  showSatellite: boolean;
  radarTime?: number;
  satelliteImageUrl?: string;
};

/** NWS active alert for the weather source home point (watches, warnings, advisories). */
export type WeatherAlert = {
  id: string;
  event: string;
  headline?: string;
  description?: string;
  /** NWS severity: Extreme | Severe | Moderate | Minor | Unknown */
  severity: string;
  urgency?: string;
  area?: string;
  onset?: string;
  ends?: string;
  expires?: string;
  sender?: string;
  detailUrl?: string;
};

export type WeatherPayload = {
  units: string;
  conditions: WeatherConditions;
  hourly: HourlyPoint[];
  scopes: ScopeView[];
  layers: WeatherLayers;
  /** Local NWS alerts for this source's lat/lon; empty when none. */
  alerts?: WeatherAlert[];
};

/** Shared board alerts feed item (published only by mounted source windows). */
export type BoardAlertSeverity = "info" | "warn" | "alert";

export type BoardAlert = {
  id: string;
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  title: string;
  /** Short list subtitle. */
  summary?: string;
  /** Full alert / incident text for the detail popup. */
  body?: string;
  severity: BoardAlertSeverity;
  category?: string;
  area?: string;
  address?: string;
  occurredAt?: string;
  endsAt?: string;
  detailUrl?: string;
  /** Incident / archive audio when the source provides it. */
  audioUrl?: string;
  /** Plain transcript or caption text when already available. */
  transcript?: string;
};

export type QuakeEvent = {
  id: string;
  title: string;
  mag?: number;
  magType?: string;
  place?: string;
  occurredAt?: string;
  updatedAt?: string;
  lat: number;
  lon: number;
  depthKm?: number;
  tsunami: boolean;
  /** PAGER alert: green, yellow, orange, red. */
  alert?: string;
  significance?: number;
  /** earthquake, landslide, explosion, volcanic eruption, … */
  eventType: string;
  status?: string;
  url?: string;
  felt?: number;
  mmi?: number;
  severity: IncidentSeverity;
  /** Tsunami, hazard type, PAGER yellow+, or magnitude at/above the source threshold. */
  notable: boolean;
};

export type QuakePayload = {
  feedId: string;
  feedUrl: string;
  feedTitle?: string;
  totalCount?: number;
  events: QuakeEvent[];
  /** Milliseconds until the next USGS request is allowed. */
  pollAfterMs: number;
  cacheMaxAgeSec: number;
  fromCache: boolean;
  notModified: boolean;
};

export type NewsStory = {
  id: string;
  title: string;
  outletId: string;
  outlet: string;
  scope: "national" | "local";
  summary?: string;
  url?: string;
  publishedAt?: string;
};

export type NewsFeedState = {
  id: string;
  name: string;
  scope: "national" | "local";
  /** Milliseconds until this feed may be requested again. */
  pollAfterMs: number;
  fromCache: boolean;
  notModified: boolean;
  error?: string;
  itemCount: number;
};

export type NewsPayload = {
  placeLabel?: string;
  stories: NewsStory[];
  feeds: NewsFeedState[];
  /** Soonest next request across the selected feeds. */
  pollAfterMs: number;
};

export type SourcePayload = {
  sourceId: string;
  typeId: string;
  fetchedAt: string;
  attribution?: string;
  note?: string;
  incidents: Incident[];
  feed?: FeedStatus;
  weather?: WeatherPayload;
  quake?: QuakePayload;
  news?: NewsPayload;
};
