import type { TrafficBounds, TrafficEvent, TrafficFeedReport, TrafficKind, TrafficPayload, TrafficSeverity } from "../types.ts";

/** Driving region around the confirmed place. The map frames this whole circle. */
export const REGION_MILES = 80;
export const MAX_TRAFFIC_EVENTS = 120;

const MILES_PER_DEG_LAT = 69.172;

export type TrafficFeedId = "penndot" | "ohgo" | "chart" | "iowa" | "open511" | "compass";

export type TrafficSecrets = {
  penndotUser?: string;
  penndotPassword?: string;
  ohgoKey?: string;
};

export type FeedBody = {
  json?: unknown;
  text?: string;
  error?: string;
};

export type TrafficBodies = {
  penndotEvents?: FeedBody;
  penndotWinter?: FeedBody;
  ohgoIncidents?: FeedBody;
  ohgoDelays?: FeedBody;
  chartEvents?: FeedBody;
  chartClosures?: FeedBody;
  iowaEvents?: FeedBody;
  iowaConditions?: FeedBody;
  open511?: FeedBody;
  compass?: FeedBody;
};

type Box = TrafficBounds;

const PENNDOT: Box = { south: 39.7, west: -80.58, north: 42.32, east: -74.65 };
const OHIO: Box = { south: 38.35, west: -84.85, north: 42.05, east: -80.45 };
const MARYLAND: Box = { south: 37.88, west: -79.52, north: 39.75, east: -74.98 };
const IOWA: Box = { south: 40.32, west: -96.7, north: 43.55, east: -90.05 };
const BRITISH_COLUMBIA: Box = { south: 48.2, west: -139.15, north: 60.1, east: -114 };
const MAINE: Box = { south: 42.97, west: -71.15, north: 47.5, east: -66.85 };
const NEW_HAMPSHIRE: Box = { south: 42.67, west: -72.6, north: 45.35, east: -70.55 };
const VERMONT: Box = { south: 42.7, west: -73.48, north: 45.05, east: -71.4 };

const FEED_NAME: Record<TrafficFeedId, string> = {
  penndot: "PennDOT 511",
  ohgo: "OHGO",
  chart: "Maryland CHART",
  iowa: "Iowa 511",
  open511: "DriveBC Open511",
  compass: "New England Compass",
};

const PENNDOT_NOTE =
  "Pennsylvania's free 511 feed needs the PennDOT username and password on this source before live incidents and winter road conditions can load.";
const OHGO_NOTE =
  "Ohio's free OHGO feed needs an API key on this source before live incidents and travel delays can load.";

type ParseResult = {
  events: TrafficEvent[];
  routineOmitted: number;
  unreadable: boolean;
};

export function regionBounds(lat: number, lon: number, miles = REGION_MILES): TrafficBounds {
  const dLat = miles / MILES_PER_DEG_LAT;
  const cos = Math.cos((lat * Math.PI) / 180);
  const milesPerDegLon = Math.max(1, MILES_PER_DEG_LAT * Math.abs(cos));
  const dLon = miles / milesPerDegLon;
  return {
    south: clamp(lat - dLat, -90, 90),
    north: clamp(lat + dLat, -90, 90),
    west: Math.max(-180, lon - dLon),
    east: Math.min(180, lon + dLon),
  };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 3958.7613;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function feedsFor(bounds: TrafficBounds): TrafficFeedId[] {
  const ids: TrafficFeedId[] = [];
  if (boxesIntersect(bounds, PENNDOT)) ids.push("penndot");
  if (boxesIntersect(bounds, OHIO)) ids.push("ohgo");
  if (boxesIntersect(bounds, MARYLAND)) ids.push("chart");
  if (boxesIntersect(bounds, IOWA)) ids.push("iowa");
  if (boxesIntersect(bounds, BRITISH_COLUMBIA)) ids.push("open511");
  if (
    boxesIntersect(bounds, MAINE) ||
    boxesIntersect(bounds, NEW_HAMPSHIRE) ||
    boxesIntersect(bounds, VERMONT)
  ) {
    ids.push("compass");
  }
  return ids;
}

export function compassNetworks(bounds: TrafficBounds): string[] {
  const networks: string[] = [];
  if (boxesIntersect(bounds, MAINE)) networks.push("Maine");
  if (boxesIntersect(bounds, NEW_HAMPSHIRE)) networks.push("NewHampshire");
  if (boxesIntersect(bounds, VERMONT)) networks.push("Vermont");
  return networks;
}

const TILE = 256;
const MAX_LAT = 85.05112878;

export function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const clamped = clamp(lat, -MAX_LAT, MAX_LAT);
  const sin = Math.sin((clamped * Math.PI) / 180);
  const scale = TILE * 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function unproject(x: number, y: number, zoom: number): { lat: number; lon: number } {
  const scale = TILE * 2 ** zoom;
  let lon = (x / scale) * 360 - 180;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clamp(lat, -MAX_LAT, MAX_LAT), lon };
}

/** Zoom that keeps the whole region box inside the map viewport. */
export function zoomToFit(
  bounds: TrafficBounds,
  width: number,
  height: number,
): { lat: number; lon: number; zoom: number } {
  const lat = (bounds.south + bounds.north) / 2;
  const lon = (bounds.west + bounds.east) / 2;
  const pad = 28;
  for (let zoom = 11; zoom >= 3; zoom -= 1) {
    const nw = project(bounds.north, bounds.west, zoom);
    const se = project(bounds.south, bounds.east, zoom);
    if (Math.abs(se.x - nw.x) <= width - pad * 2 && Math.abs(se.y - nw.y) <= height - pad * 2) {
      return { lat, lon, zoom };
    }
  }
  return { lat, lon, zoom: 3 };
}

export function collectTraffic(input: {
  lat: number;
  lon: number;
  label?: string;
  secrets?: TrafficSecrets;
  bodies?: TrafficBodies;
}): { traffic: TrafficPayload; attribution: string; note: string } {
  const bounds = regionBounds(input.lat, input.lon);
  const secrets = input.secrets ?? {};
  const bodies = input.bodies ?? {};
  const needed = feedsFor(bounds);
  const reports: TrafficFeedReport[] = [];
  const events: TrafficEvent[] = [];
  let routineOmitted = 0;
  const liveNames: string[] = [];

  for (const id of needed) {
    const name = FEED_NAME[id];
    if (id === "penndot" && !hasSecret(secrets.penndotUser, secrets.penndotPassword)) {
      reports.push({ id, name, status: "needs-credentials", detail: PENNDOT_NOTE });
      continue;
    }
    if (id === "ohgo" && !hasSecret(secrets.ohgoKey)) {
      reports.push({ id, name, status: "needs-credentials", detail: OHGO_NOTE });
      continue;
    }
    const parts = bodiesFor(id, bodies);
    const parsed = parts
      .filter((part) => part.json !== undefined || part.text !== undefined)
      .map((part) => parseFeed(id, part, input.lat, input.lon));
    const merged = mergeFeed(name, parts, parsed);
    reports.push({ id, name, status: merged.status, detail: merged.detail });
    if (merged.status === "live") liveNames.push(name);
    events.push(...merged.events);
    routineOmitted += merged.routineOmitted;
  }

  const limited = limitEvents(events);
  const traffic: TrafficPayload = {
    lat: input.lat,
    lon: input.lon,
    label: input.label?.trim() || undefined,
    radiusMi: REGION_MILES,
    bounds,
    feeds: reports,
    events: limited,
    routineOmitted,
  };
  const attribution = [...liveNames, "Esri basemap"].join(" · ");
  return { traffic, attribution, note: trafficNote(traffic) };
}

export async function fetchTrafficPayload(
  place: { lat: number; lon: number; label?: string },
  secrets: Record<string, string>,
  get: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<{ traffic: TrafficPayload; attribution: string; note: string }> {
  const bounds = regionBounds(place.lat, place.lon);
  const needed = new Set(feedsFor(bounds));
  const penndotUser = secrets["penndot.username"]?.trim() ?? "";
  const penndotPassword = secrets["penndot.password"]?.trim() ?? "";
  const ohgoKey = secrets["ohgo.api_key"]?.trim() ?? "";
  const bodies: TrafficBodies = {};

  const jobs: Array<Promise<void>> = [];
  if (needed.has("penndot") && penndotUser && penndotPassword) {
    const headers = { authorization: basicAuth(penndotUser, penndotPassword) };
    jobs.push(
      readJson(get, "/proxy/penndot/RCRS_Event_Data/api/RCRS/liveEvents", { headers }).then((body) => {
        bodies.penndotEvents = body;
      }),
    );
    jobs.push(
      readJson(get, "/proxy/penndot/RCRS_Event_Data/api/RCRS/winterConditions", { headers }).then((body) => {
        bodies.penndotWinter = body;
      }),
    );
  }
  if (needed.has("ohgo") && ohgoKey) {
    const headers = { authorization: `APIKEY ${ohgoKey}` };
    jobs.push(
      readJson(get, "/proxy/ohgo/api/v1/incidents", { headers }).then((body) => {
        bodies.ohgoIncidents = body;
      }),
    );
    jobs.push(
      readJson(get, "/proxy/ohgo/api/v1/travel-delays", { headers }).then((body) => {
        bodies.ohgoDelays = body;
      }),
    );
  }
  if (needed.has("chart")) {
    jobs.push(
      readJson(get, "/proxy/chart/CHARTExportClientService/getEventMapDataJSON.do").then((body) => {
        bodies.chartEvents = body;
      }),
    );
    jobs.push(
      readJson(get, "/proxy/chart/CHARTExportClientService/getActiveClosureMapDataJSON.do").then((body) => {
        bodies.chartClosures = body;
      }),
    );
  }
  if (needed.has("iowa")) {
    const query = iowaQuery(bounds);
    jobs.push(
      readJson(
        get,
        `/proxy/arcgis/8lRhdTsQyJpO52F1/arcgis/rest/services/CARS511_Iowa_View/FeatureServer/0/query?${query}`,
      ).then((body) => {
        bodies.iowaEvents = body;
      }),
    );
    jobs.push(
      readJson(
        get,
        `/proxy/arcgis/8lRhdTsQyJpO52F1/ArcGIS/rest/services/511_IA_Road_Conditions_View/FeatureServer/0/query?${query}`,
      ).then((body) => {
        bodies.iowaConditions = body;
      }),
    );
  }
  if (needed.has("open511")) {
    const bbox = `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
    jobs.push(
      readJson(get, `/proxy/open511/events?status=ACTIVE&limit=500&bbox=${bbox}`).then((body) => {
        bodies.open511 = body;
      }),
    );
  }
  if (needed.has("compass")) {
    jobs.push(
      (async () => {
        const chunks: string[] = [];
        let error: string | undefined;
        for (const network of compassNetworks(bounds)) {
          const part = await readText(
            get,
            `/proxy/compass/NEC.XmlDataPortal/api/c2c?networks=${network}&dataTypes=incidentData`,
          );
          if (part.text) chunks.push(part.text);
          if (part.error) error = part.error;
        }
        bodies.compass = chunks.length ? { text: chunks.join("\n"), error } : { error: error ?? "did not respond." };
      })(),
    );
  }
  await Promise.all(jobs);
  return collectTraffic({
    lat: place.lat,
    lon: place.lon,
    label: place.label,
    secrets: { penndotUser, penndotPassword, ohgoKey },
    bodies,
  });
}

function trafficNote(traffic: TrafficPayload): string {
  const parts = [
    `Map shows the whole ${REGION_MILES}-mile region around the confirmed place.`,
  ];
  for (const feed of traffic.feeds) {
    if (feed.detail && (feed.status === "needs-credentials" || feed.status === "error")) {
      parts.push(feed.detail);
    }
  }
  if (!traffic.feeds.some((feed) => feed.status === "live" || feed.status === "needs-credentials")) {
    parts.push("No free real-time incident feed covers this region.");
  }
  if (traffic.routineOmitted > 0) {
    parts.push("Clear and wet road reports are left off the list.");
  }
  return parts.join(" ");
}

function limitEvents(events: TrafficEvent[]): TrafficEvent[] {
  const ranked = [...events].sort(compareEvents);
  if (ranked.length <= MAX_TRAFFIC_EVENTS) return ranked;
  const important = ranked.filter((event) => event.affectsTravel);
  const rest = ranked.filter((event) => !event.affectsTravel);
  return [...important, ...rest].slice(0, MAX_TRAFFIC_EVENTS).sort(compareEvents);
}

function compareEvents(a: TrafficEvent, b: TrafficEvent): number {
  const rank = severityRank(a.severity) - severityRank(b.severity);
  if (rank) return rank;
  const title = a.title.localeCompare(b.title);
  if (title) return title;
  return a.id.localeCompare(b.id);
}

function severityRank(severity: TrafficSeverity): number {
  if (severity === "alert") return 0;
  if (severity === "warn") return 1;
  return 2;
}

function bodiesFor(id: TrafficFeedId, bodies: TrafficBodies): FeedBody[] {
  if (id === "penndot") return [bodies.penndotEvents, bodies.penndotWinter].filter(isBody);
  if (id === "ohgo") return [bodies.ohgoIncidents, bodies.ohgoDelays].filter(isBody);
  if (id === "chart") return [bodies.chartEvents, bodies.chartClosures].filter(isBody);
  if (id === "iowa") return [bodies.iowaEvents, bodies.iowaConditions].filter(isBody);
  if (id === "open511") return [bodies.open511].filter(isBody);
  return [bodies.compass].filter(isBody);
}

function isBody(value: FeedBody | undefined): value is FeedBody {
  return value !== undefined;
}

function mergeFeed(name: string, parts: FeedBody[], parsed: ParseResult[]): {
  status: TrafficFeedReport["status"];
  detail?: string;
  events: TrafficEvent[];
  routineOmitted: number;
} {
  const events = parsed.flatMap((part) => part.events);
  const routineOmitted = parsed.reduce((sum, part) => sum + part.routineOmitted, 0);
  const okBody = parts.some((part) => part.json !== undefined || part.text !== undefined);
  const httpError = parts.map((part) => part.error).find((item) => item);
  if (!okBody) {
    return {
      status: "error",
      detail: httpError ? `${name} ${httpError}` : `${name} did not respond.`,
      events: [],
      routineOmitted: 0,
    };
  }
  if (parsed.length > 0 && parsed.every((part) => part.unreadable) && events.length === 0) {
    return {
      status: "error",
      detail: `${name} returned data this app could not read.`,
      events: [],
      routineOmitted: 0,
    };
  }
  return {
    status: "live",
    detail: httpError ? `${name} ${httpError}` : undefined,
    events,
    routineOmitted,
  };
}

function parseFeed(id: TrafficFeedId, part: FeedBody, lat: number, lon: number): ParseResult {
  if (id === "penndot") return parsePenndot(part.json, lat, lon);
  if (id === "ohgo") return parseOhgo(part.json, lat, lon);
  if (id === "chart") return parseChart(part.json, lat, lon);
  if (id === "iowa") return parseIowa(part.json, lat, lon);
  if (id === "open511") return parseOpen511(part.json, lat, lon);
  return parseCompass(part.text ?? "", lat, lon);
}

function parsePenndot(body: unknown, lat: number, lon: number): ParseResult {
  const values = namedRows(body, ["Values", "values"]);
  if (!values) return unreadable();
  const events: TrafficEvent[] = [];
  let routineOmitted = 0;
  for (const row of values) {
    if (text(row.Condition) || text(row.ConditionID)) {
      const winter = winterEvent(row, lat, lon);
      if (winter === "routine") routineOmitted += 1;
      else if (winter) events.push(winter);
      continue;
    }
    const live = penndotEvent(row, lat, lon);
    if (live) events.push(live);
  }
  return { events, routineOmitted, unreadable: false };
}

function penndotEvent(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const reopened = text(row.ActualDateTimeOpened);
  const lane = (text(row.LaneStatus) ?? "").toLowerCase();
  const kindName = (text(row.EventType) ?? "").toLowerCase();
  if (reopened || lane === "open" || kindName === "incident cleared") return null;
  const point = inCircle(
    lat,
    lon,
    [
      latLonPair(row.IncidentLocLatLong),
      latLonPair(row.FromLocLatLong),
      latLonPair(row.ToLocLatLong),
      midpoint(latLonPair(row.FromLocLatLong), latLonPair(row.ToLocLatLong)),
    ],
  );
  if (!point) return null;
  const facility = text(row.Facility);
  const description = text(row.Description);
  const travelLane =
    lane === "closed" ||
    lane === "lane restriction" ||
    lane === "ramp closure" ||
    lane === "ramp restriction" ||
    lane === "traffic disruption" ||
    lane === "speed restriction" ||
    lane === "vehicle restriction" ||
    lane === "no entry access";
  const crash = /crash|debris|flood|bridge outage|disabled|vehicle fire|downed|winter weather|damaged roadway/.test(
    kindName,
  );
  const affectsTravel = travelLane || crash;
  if (lane === "shoulder closed") {
    return makeEvent({
      id: `penndot:${text(row.EventID) ?? description ?? facility ?? "event"}`,
      title: description || joinWords([kindName, "on", facility]) || "Road event",
      kind: "incident",
      severity: "info",
      affectsTravel: false,
      summary: text(row.LaneStatus),
      road: facility,
      direction: text(row.Direction),
      lat: point.lat,
      lon: point.lon,
      updatedAt: text(row.LastUpdate) ?? text(row.DateTimeVerified),
      detailUrl: "https://www.511pa.com/",
      feedName: FEED_NAME.penndot,
    });
  }
  let severity: TrafficSeverity = "info";
  if (lane === "closed" || lane === "no entry access" || kindName === "bridge outage") severity = "alert";
  else if (affectsTravel) severity = "warn";
  const kind: TrafficKind =
    lane === "closed" || lane === "ramp closure" || kindName === "bridge outage"
      ? "closure"
      : kindName.includes("roadwork") || kindName.includes("utility work")
        ? "roadwork"
        : "incident";
  return makeEvent({
    id: `penndot:${text(row.EventID) ?? `${point.lat},${point.lon}`}`,
    title: description || joinWords([text(row.EventType), "on", facility]) || "Road event",
    kind,
    severity,
    affectsTravel,
    summary: [text(row.LaneStatus), text(row.AffectedLanes)].filter(Boolean).join(" · ") || undefined,
    road: facility,
    direction: text(row.Direction),
    lat: point.lat,
    lon: point.lon,
    updatedAt: text(row.LastUpdate) ?? text(row.CreateTime),
    detailUrl: "https://www.511pa.com/",
    feedName: FEED_NAME.penndot,
  });
}

function winterEvent(
  row: Record<string, unknown>,
  lat: number,
  lon: number,
): TrafficEvent | "routine" | null {
  const condition = text(row.Condition) ?? "";
  const rank = winterRank(condition);
  const from = latLonPair(row.FromLocLatLong);
  const to = latLonPair(row.ToLocLatLong);
  const point = inCircle(lat, lon, [midpoint(from, to), from, to]);
  if (!point) return null;
  if (rank === "routine") return "routine";
  return makeEvent({
    id: `penndot-winter:${text(row.RoadSectionID) ?? `${point.lat},${point.lon}`}`,
    title: `${condition} · ${text(row.Facility) ?? "road"}`,
    kind: "condition",
    severity: rank === "alert" ? "alert" : "warn",
    affectsTravel: true,
    summary: [text(row.CountyName), text(row.FromLoc), text(row.ToLoc)].filter(Boolean).join(" · "),
    road: text(row.Facility),
    lat: point.lat,
    lon: point.lon,
    updatedAt: text(row.LastUpdate),
    detailUrl: "https://www.511pa.com/",
    feedName: FEED_NAME.penndot,
  });
}

function winterRank(condition: string): "routine" | "warn" | "alert" {
  const value = condition.toLowerCase();
  if (!value || value === "clear") return "routine";
  if (value.includes("impassable") || value.includes("icy") || value.includes("packed")) return "alert";
  if (
    value.includes("freezing") ||
    value.includes("ice") ||
    value.includes("snow") ||
    value.includes("slush")
  ) {
    return "warn";
  }
  if (value.includes("wet")) return "routine";
  return "warn";
}

function parseOhgo(body: unknown, lat: number, lon: number): ParseResult {
  const rows = namedRows(body, ["Results", "results", "data"]);
  if (!rows) return unreadable();
  const events: TrafficEvent[] = [];
  for (const row of rows) {
    const event = text(row.DelayTime) !== undefined || text(row.TravelTime) !== undefined
      ? ohgoDelay(row, lat, lon)
      : ohgoIncident(row, lat, lon);
    if (event) events.push(event);
  }
  return { events, routineOmitted: 0, unreadable: false };
}

function ohgoIncident(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const point = inCircle(lat, lon, [latLonFields(row), ...pathPoints(row.RoadClosureDetails)]);
  if (!point) return null;
  const roadStatus = (text(row.RoadStatus) ?? "").toLowerCase();
  const category = (text(row.Category) ?? "").toLowerCase();
  const description = text(row.Description);
  const closed = roadStatus.includes("closed") && !roadStatus.includes("partial");
  const partial = roadStatus.includes("partial") || roadStatus.includes("restrict");
  const hazard = /accident|crash|closure|snow|ice|flood|debris|disabled|fire/.test(
    `${category} ${description ?? ""}`.toLowerCase(),
  );
  const affectsTravel = closed || partial || hazard;
  const severity: TrafficSeverity = closed ? "alert" : affectsTravel ? "warn" : "info";
  const route = text(row.RouteName) ?? text(row.Location);
  return makeEvent({
    id: `ohgo:${text(row.Id) ?? text(row.ID) ?? `${point.lat},${point.lon}`}`,
    title: description || joinWords([text(row.Category), "on", route]) || "Ohio road incident",
    kind: closed ? "closure" : "incident",
    severity,
    affectsTravel,
    summary: [text(row.Category), text(row.RoadStatus)].filter(Boolean).join(" · ") || undefined,
    road: route,
    direction: text(row.Direction),
    lat: point.lat,
    lon: point.lon,
    detailUrl: "https://ohgo.com/",
    feedName: FEED_NAME.ohgo,
  });
}

function ohgoDelay(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const point = inCircle(lat, lon, [latLonFields(row)]);
  if (!point) return null;
  const delay = finite(row.DelayTime) ?? 0;
  const current = finite(row.CurrentAvgSpeed);
  const normal = finite(row.NormalAvgSpeed);
  const ratio = current != null && normal != null && normal > 0 ? current / normal : 1;
  const affectsTravel = delay >= 3 || ratio <= 0.75;
  const severity: TrafficSeverity = delay >= 10 || ratio <= 0.5 ? "alert" : affectsTravel ? "warn" : "info";
  const route = text(row.RouteName) ?? text(row.Location);
  const summary = [
    delay ? `${Math.round(delay)} min delay` : "",
    current != null ? `${Math.round(current)} mph` : "",
    normal != null ? `usually ${Math.round(normal)} mph` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return makeEvent({
    id: `ohgo-delay:${text(row.Id) ?? text(row.ID) ?? `${point.lat},${point.lon}`}`,
    title: text(row.Description) || joinWords(["Delay on", route]) || "Travel delay",
    kind: "delay",
    severity,
    affectsTravel,
    summary: summary || undefined,
    road: route,
    direction: text(row.Direction),
    lat: point.lat,
    lon: point.lon,
    detailUrl: "https://ohgo.com/",
    feedName: FEED_NAME.ohgo,
  });
}

function parseChart(body: unknown, lat: number, lon: number): ParseResult {
  const rows = namedRows(body, ["data", "Data"]);
  if (!rows) return unreadable();
  const events: TrafficEvent[] = [];
  for (const row of rows) {
    if (row.closed === true) continue;
    const closureFeed = text(row.closureStartDate) !== undefined || text(row.lanesClosed) !== undefined || text(row.planned) !== undefined;
    const event = closureFeed ? chartClosure(row, lat, lon) : chartEvent(row, lat, lon);
    if (event) events.push(event);
  }
  return { events, routineOmitted: 0, unreadable: false };
}

function chartEvent(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const point = inCircle(lat, lon, [latLonFields(row)]);
  if (!point) return null;
  const type = finite(row.type);
  const impact = laneImpact(row.lanes, text(row.lanesStatus) ?? "");
  const trafficAlert = row.trafficAlert === true;
  const incidentType = (text(row.incidentType) ?? "").toLowerCase();
  if ((type === 249 || type === 254) && !trafficAlert && impact === "none") return null;
  if (incidentType.includes("off-road") && impact === "none" && !trafficAlert) return null;
  const hazard = /closure|crash|debris|disabled|weather|congestion|collision|injury/.test(incidentType);
  const affectsTravel =
    trafficAlert || impact !== "none" || type === 2 || type === 250 || type === 253 || type === 255 || hazard;
  const severity: TrafficSeverity =
    impact === "all" || incidentType.includes("weather closure") ? "alert" : affectsTravel ? "warn" : "info";
  const kind: TrafficKind =
    type === 250 ? "delay" : impact === "all" || incidentType.includes("closure") ? "closure" : type === 4 ? "roadwork" : "incident";
  return makeEvent({
    id: `chart:${text(row.id) ?? `${point.lat},${point.lon}`}`,
    title: text(row.description) || text(row.name) || "Maryland road event",
    kind,
    severity,
    affectsTravel,
    summary: [text(row.incidentType), text(row.lanesStatus), text(row.trafficAlertTextMsg)].filter(Boolean).join(" · ") || undefined,
    road: text(row.county),
    direction: text(row.direction),
    lat: point.lat,
    lon: point.lon,
    updatedAt: epoch(row.lastCachedDataUpdateTime) ?? epoch(row.startDateTime),
    detailUrl: "https://chart.maryland.gov/",
    feedName: FEED_NAME.chart,
  });
}

function chartClosure(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const point = inCircle(lat, lon, [latLonFields(row)]);
  if (!point) return null;
  const impact = laneImpact(row.lanes, text(row.lanesClosed) ?? text(row.lanesStatus) ?? "");
  if (impact === "none") return null;
  return makeEvent({
    id: `chart-closure:${text(row.id) ?? `${point.lat},${point.lon}`}`,
    title: text(row.description) || text(row.name) || "Road closure",
    kind: "closure",
    severity: impact === "all" ? "alert" : "warn",
    affectsTravel: true,
    summary: text(row.lanesClosed) || text(row.lanesStatus) || text(row.reason),
    road: text(row.county),
    direction: text(row.direction),
    lat: point.lat,
    lon: point.lon,
    updatedAt: epoch(row.lastCachedDataUpdateTime) ?? epoch(row.startDateTime),
    detailUrl: "https://chart.maryland.gov/",
    feedName: FEED_NAME.chart,
  });
}

function laneImpact(lanes: unknown, statusText: string): "none" | "ramp" | "lane" | "all" {
  const list = Array.isArray(lanes) ? lanes : [];
  let traffic = 0;
  let trafficClosed = 0;
  let rampClosed = false;
  for (const lane of list) {
    const row = record(lane);
    if (!row) continue;
    const status = (text(row.laneStatus) ?? "").toLowerCase();
    const description = (text(row.laneDescription) ?? "").toLowerCase();
    const type = `${text(row.laneType) ?? ""} ${description}`.toLowerCase();
    const closed = status === "closed";
    if (type.includes("ramp") && closed) rampClosed = true;
    const trafficLane =
      (type.includes("traffic") || /^l\d+/.test(description)) &&
      !type.includes("shoulder") &&
      !type.includes("ramp");
    if (trafficLane) {
      traffic += 1;
      if (closed) trafficClosed += 1;
    }
  }
  if (traffic > 0 && trafficClosed === traffic) return "all";
  if (trafficClosed > 0) return "lane";
  if (rampClosed) return "ramp";
  const prose = statusText.toLowerCase();
  if (prose.includes("all") && prose.includes("closed") && prose.includes("traffic")) return "all";
  if (prose.includes("closed") && prose.includes("traffic") && !prose.includes("shoulder only")) return "lane";
  if (prose.includes("ramp") && prose.includes("closed")) return "ramp";
  return "none";
}

function parseIowa(body: unknown, lat: number, lon: number): ParseResult {
  const features = featuresOf(body);
  if (!features) return unreadable();
  const events: TrafficEvent[] = [];
  let routineOmitted = 0;
  for (const feature of features) {
    const props = record(feature.properties) ?? {};
    if (text(props.ROAD_CONDITION) || text(props.HL_PAVEMENT_CONDITION)) {
      const condition = iowaCondition(feature, props, lat, lon);
      if (condition === "routine") routineOmitted += 1;
      else if (condition) events.push(condition);
      continue;
    }
    const event = iowaEvent(feature, props, lat, lon);
    if (event) events.push(event);
  }
  return { events, routineOmitted, unreadable: false };
}

function iowaEvent(
  feature: { geometry?: unknown },
  props: Record<string, unknown>,
  lat: number,
  lon: number,
): TrafficEvent | null {
  const style = (text(props.STYLE) ?? "").toLowerCase();
  if (style === "future_event") return null;
  const point = inCircle(lat, lon, geoPoints(feature.geometry));
  if (!point) return null;
  const route = text(props.Route) ?? text(props.ROUTE_NAME);
  const phrase = text(props.phrase) ?? text(props.headline);
  const affectsTravel = style === "closure" || style === "lane_closure" || style === "restriction" || style === "warning" || style === "roadwork";
  const severity: TrafficSeverity = style === "closure" ? "alert" : affectsTravel ? "warn" : "info";
  const kind: TrafficKind =
    style === "closure" || style === "lane_closure" ? "closure" : style === "roadwork" ? "roadwork" : "incident";
  const link = text(props.linktxt);
  return makeEvent({
    id: `iowa:${text(props.ID) ?? text(props.OBJECTID) ?? `${point.lat},${point.lon}`}`,
    title: text(props.headline) || joinWords([phrase, route]) || "Iowa road event",
    kind,
    severity,
    affectsTravel,
    summary: [phrase, text(props.msg0)].filter(Boolean).join(" · ") || undefined,
    road: route,
    lat: point.lat,
    lon: point.lon,
    updatedAt: [text(props.UpdateDate), text(props.UpdateTime)].filter(Boolean).join(" ") || text(props.gisupdated),
    detailUrl: link && /^https?:\/\//i.test(link) ? link : "https://511ia.org/",
    feedName: FEED_NAME.iowa,
  });
}

function iowaCondition(
  feature: { geometry?: unknown },
  props: Record<string, unknown>,
  lat: number,
  lon: number,
): TrafficEvent | "routine" | null {
  const condition = text(props.ROAD_CONDITION) ?? text(props.HL_PAVEMENT_CONDITION) ?? "";
  const rank = surfaceRank(condition);
  const primary = latLonFields({
    lat: props.PRIMARY_LATITUDE,
    lon: props.PRIMARY_LONGITUDE,
  });
  const point = inCircle(lat, lon, [primary, ...geoPoints(feature.geometry)]);
  if (!point) return null;
  if (rank === "routine") return "routine";
  return makeEvent({
    id: `iowa-road:${text(props.SEGMENT_ID) ?? text(props.OBJECTID) ?? `${point.lat},${point.lon}`}`,
    title: `${condition} · ${text(props.ROUTE_NAME) ?? text(props.NAMEID) ?? "road"}`,
    kind: "condition",
    severity: rank,
    affectsTravel: true,
    summary: text(props.LONG_NAME),
    road: text(props.ROUTE_NAME) ?? text(props.NAMEID),
    lat: point.lat,
    lon: point.lon,
    updatedAt: epoch(props.CARS_MSG_UPDATE_DATE),
    detailUrl: "https://511ia.org/",
    feedName: FEED_NAME.iowa,
  });
}

function surfaceRank(condition: string): "routine" | TrafficSeverity {
  const value = condition.toLowerCase();
  if (!value || /seasonal|normal|clear|dry|bare|wet|damp/.test(value)) return "routine";
  if (/impassable|closed/.test(value)) return "alert";
  return "warn";
}

function parseOpen511(body: unknown, lat: number, lon: number): ParseResult {
  const root = record(body);
  const events = root && Array.isArray(root.events) ? root.events : null;
  if (!events) return unreadable();
  const out: TrafficEvent[] = [];
  for (const item of events) {
    const row = record(item);
    if (!row) continue;
    const event = open511Event(row, lat, lon);
    if (event) out.push(event);
  }
  return { events: out, routineOmitted: 0, unreadable: false };
}

function open511Event(row: Record<string, unknown>, lat: number, lon: number): TrafficEvent | null {
  const geography = record(row.geography);
  const point = inCircle(lat, lon, geoPoints(geography));
  if (!point) return null;
  const eventType = (text(row.event_type) ?? "").toUpperCase();
  const severityName = (text(row.severity) ?? "").toUpperCase();
  const roads = Array.isArray(row.roads) ? row.roads : [];
  let impact: "none" | "partial" | "closed" = "none";
  const roadNames: string[] = [];
  let direction: string | undefined;
  for (const road of roads) {
    const item = record(road);
    if (!item) continue;
    if (!roadNames.length) direction = text(item.direction);
    const name = text(item.name);
    if (name) roadNames.push(name);
    impact = worseImpact(impact, roadStateImpact(text(item.state) ?? ""));
  }
  const description = text(row.description);
  const headline = text(row.headline);
  const weather = eventType === "WEATHER_CONDITION" || eventType === "ROAD_CONDITION";
  const incident = eventType === "INCIDENT" || eventType.includes("CLOSURE");
  const affectsTravel =
    impact !== "none" ||
    severityName === "MAJOR" ||
    severityName === "MODERATE" ||
    incident ||
    (weather && severityName !== "MINOR");
  const severity: TrafficSeverity =
    impact === "closed" || (severityName === "MAJOR" && (incident || impact !== "none"))
      ? "alert"
      : affectsTravel
        ? "warn"
        : "info";
  const kind: TrafficKind =
    impact === "closed" || eventType.includes("CLOSURE")
      ? "closure"
      : weather
        ? "condition"
        : eventType === "CONSTRUCTION"
          ? "roadwork"
          : "incident";
  return makeEvent({
    id: `open511:${text(row.id) ?? `${point.lat},${point.lon}`}`,
    title: headline && description ? `${headline}: ${clip(description, 140)}` : description || headline || "Road event",
    kind,
    severity,
    affectsTravel,
    summary: clip(description, 500),
    road: roadNames.join(", ") || undefined,
    direction,
    lat: point.lat,
    lon: point.lon,
    updatedAt: text(row.updated) ?? text(row.created),
    detailUrl: text(row.url),
    feedName: FEED_NAME.open511,
  });
}

function roadStateImpact(state: string): "none" | "partial" | "closed" {
  const value = state.toUpperCase();
  if (!value || value === "ALL_LANES_OPEN" || value === "UNKNOWN") return "none";
  if (value.includes("SHOULDER") && !value.includes("LANE")) return "none";
  if (value === "CLOSED" || value.includes("ALL_LANES_CLOSED")) return "closed";
  if (value.includes("CLOSED") || value.includes("ALTERNATING")) return "partial";
  return "none";
}

function worseImpact(
  current: "none" | "partial" | "closed",
  next: "none" | "partial" | "closed",
): "none" | "partial" | "closed" {
  const rank = { none: 0, partial: 1, closed: 2 };
  return rank[next] > rank[current] ? next : current;
}

function parseCompass(xml: string, lat: number, lon: number): ParseResult {
  if (!xml.includes("<incidentData") && !xml.includes("<status")) return unreadable();
  const events: TrafficEvent[] = [];
  const chunks = xml.split(/<incident\b/i).slice(1);
  for (const chunk of chunks) {
    const event = compassEvent(chunk, lat, lon);
    if (event) events.push(event);
  }
  return { events, routineOmitted: 0, unreadable: false };
}

function compassEvent(chunk: string, lat: number, lon: number): TrafficEvent | null {
  const body = chunk.split(/<\/incident>/i)[0] ?? chunk;
  const status = (xmlText(body, "status") ?? "").toLowerCase();
  if (/cleared|cancel|expired/.test(status)) return null;
  const point = inCircle(lat, lon, [compassPoint(xmlText(body, "lat"), xmlText(body, "lon"))]);
  if (!point) return null;
  const description = xmlText(body, "desc") ?? "Road incident";
  const severityName = (xmlText(body, "severity") ?? "").toLowerCase();
  const lanes = /<isBlocked>\s*true\s*<\/isBlocked>/i.test(body) || /closed/i.test(xmlText(body, "affectedLanesDescription") ?? "");
  const closedRoad = /bridge closed|road closed|all lanes|closed due/i.test(description);
  const affectsTravel = lanes || closedRoad || /delay/i.test(description) || severityName === "high" || severityName === "medium";
  const severity: TrafficSeverity =
    closedRoad || severityName === "high" || severityName === "major" ? "alert" : affectsTravel ? "warn" : "info";
  const idMatch = body.match(/\bid="([^"]+)"/i);
  const roadway = xmlText(body, "roadway");
  return makeEvent({
    id: `compass:${idMatch?.[1] ?? `${point.lat},${point.lon}`}`,
    title: description,
    kind: closedRoad ? "closure" : "incident",
    severity,
    affectsTravel,
    summary: xmlText(body, "affectedLanesDescription"),
    road: roadway,
    direction: xmlText(body, "direction"),
    lat: point.lat,
    lon: point.lon,
    updatedAt: xmlText(body, "lastUpdatedTimestamp") ?? xmlText(body, "createdTimestamp"),
    detailUrl: "https://newengland511.org/",
    feedName: FEED_NAME.compass,
  });
}

function compassPoint(latRaw: string | undefined, lonRaw: string | undefined): { lat: number; lon: number } | null {
  let lat = finite(latRaw);
  let lon = finite(lonRaw);
  if (lat == null || lon == null) return null;
  if (Math.abs(lat) > 90) lat /= 1_000_000;
  if (Math.abs(lon) > 180) lon /= 1_000_000;
  if (!inWorld(lat, lon)) return null;
  return { lat, lon };
}

function xmlText(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  const value = match?.[1]?.replace(/<[^>]+>/g, "").trim();
  return value || undefined;
}

function inCircle(
  lat: number,
  lon: number,
  points: Array<{ lat: number; lon: number } | null | undefined>,
): { lat: number; lon: number } | null {
  let best: { lat: number; lon: number } | null = null;
  let bestMiles = Infinity;
  for (const point of points) {
    if (!point || !inWorld(point.lat, point.lon)) continue;
    const miles = milesBetween(lat, lon, point.lat, point.lon);
    if (miles <= REGION_MILES && miles < bestMiles) {
      best = point;
      bestMiles = miles;
    }
  }
  return best;
}

function makeEvent(event: TrafficEvent): TrafficEvent {
  return {
    ...event,
    title: clip(event.title, 220) || "Road event",
    summary: clip(event.summary, 500),
  };
}

function pathPoints(value: unknown): Array<{ lat: number; lon: number } | null> {
  const row = record(value);
  if (!row) return [];
  const points: Array<{ lat: number; lon: number } | null> = [];
  for (const key of ["ClosureStartLocation", "ClosureEndLocation"]) {
    points.push(lonLatArray(row[key]));
  }
  if (Array.isArray(row.Polyline)) {
    for (const pair of row.Polyline) points.push(lonLatArray(pair));
  }
  return points;
}

function lonLatArray(value: unknown): { lat: number; lon: number } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = finite(value[0]);
  const lat = finite(value[1]);
  if (lat == null || lon == null || !inWorld(lat, lon)) return null;
  return { lat, lon };
}

function geoPoints(geometry: unknown): Array<{ lat: number; lon: number }> {
  const row = record(geometry);
  if (!row || !Array.isArray(row.coordinates)) return [];
  const type = text(row.type);
  if (type === "Point") {
    const point = lonLatArray(row.coordinates);
    return point ? [point] : [];
  }
  if (type === "LineString" || type === "MultiPoint") {
    return row.coordinates.map(lonLatArray).filter((point): point is { lat: number; lon: number } => point != null);
  }
  if (type === "MultiLineString" || type === "Polygon") {
    const out: Array<{ lat: number; lon: number }> = [];
    for (const line of row.coordinates) {
      if (!Array.isArray(line)) continue;
      for (const pair of line) {
        const point = lonLatArray(pair);
        if (point) out.push(point);
      }
    }
    return out;
  }
  return [];
}

function featuresOf(body: unknown): Array<{ geometry?: unknown; properties?: unknown }> | null {
  const root = record(body);
  if (!root) return null;
  if (root.error) return null;
  if (!Array.isArray(root.features)) return null;
  return root.features.filter((item) => record(item) != null) as Array<{ geometry?: unknown; properties?: unknown }>;
}

function namedRows(body: unknown, keys: string[]): Array<Record<string, unknown>> | null {
  if (Array.isArray(body)) return body.map(record).filter((row): row is Record<string, unknown> => row != null);
  const root = record(body);
  if (!root) return null;
  if (root.error || root.Error) return null;
  for (const key of keys) {
    if (Array.isArray(root[key])) {
      return root[key].map(record).filter((row): row is Record<string, unknown> => row != null);
    }
  }
  return null;
}

function latLonFields(row: Record<string, unknown>): { lat: number; lon: number } | null {
  const lat = finite(row.lat ?? row.Lat ?? row.Latitude ?? row.latitude);
  const lon = finite(row.lon ?? row.Lon ?? row.Longitude ?? row.longitude);
  if (lat == null || lon == null || !inWorld(lat, lon)) return null;
  return { lat, lon };
}

function latLonPair(value: unknown): { lat: number; lon: number } | null {
  const raw = text(value);
  if (!raw) return null;
  const [latText, lonText] = raw.split(",");
  const lat = finite(latText);
  const lon = finite(lonText);
  if (lat == null || lon == null || !inWorld(lat, lon)) return null;
  return { lat, lon };
}

function midpoint(
  a: { lat: number; lon: number } | null,
  b: { lat: number; lon: number } | null,
): { lat: number; lon: number } | null {
  if (!a || !b) return null;
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

function epoch(value: unknown): string | undefined {
  const n = finite(value);
  if (n == null) return undefined;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function unreadable(): ParseResult {
  return { events: [], routineOmitted: 0, unreadable: true };
}

function hasSecret(...values: Array<string | undefined>): boolean {
  return values.every((value) => Boolean(value?.trim()));
}

function joinWords(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const textValue = value.replace(/\s+/g, " ").trim();
  if (!textValue) return undefined;
  return textValue.length > max ? `${textValue.slice(0, max - 1)}…` : textValue;
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function inWorld(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function iowaQuery(bounds: TrafficBounds): string {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    f: "geojson",
    outSR: "4326",
    inSR: "4326",
    geometry: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: "2000",
  });
  return params.toString();
}

async function readJson(
  get: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init?: RequestInit,
): Promise<FeedBody> {
  try {
    const response = await get(url, init);
    if (response.status === 401 || response.status === 403) {
      return { error: "refused the saved credentials." };
    }
    if (!response.ok) return { error: "did not respond." };
    const raw = await response.text();
    try {
      return { json: JSON.parse(raw) as unknown };
    } catch {
      return { error: "returned data this app could not read." };
    }
  } catch {
    return { error: "did not respond." };
  }
}

async function readText(
  get: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
): Promise<FeedBody> {
  try {
    const response = await get(url);
    if (!response.ok) return { error: "did not respond." };
    return { text: await response.text() };
  } catch {
    return { error: "did not respond." };
  }
}

function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
