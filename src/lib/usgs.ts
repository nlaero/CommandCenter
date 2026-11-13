import type {
  Incident,
  IncidentSeverity,
  QuakeEvent,
  QuakePayload,
  SourceConfig,
  SourcePayload,
} from "../types";

/** Keep the id list aligned with `ALLOWED_FEEDS` in `src-tauri/src/sources/quake.rs`. */
export const USGS_FEED_OPTIONS: { value: string; label: string }[] = [
  { value: "all_hour", label: "Past hour — all events" },
  { value: "all_day", label: "Past day — all events" },
  { value: "2.5_day", label: "Past day — M2.5+" },
  { value: "4.5_day", label: "Past day — M4.5+" },
  { value: "4.5_week", label: "Past week — M4.5+" },
  { value: "significant_hour", label: "Past hour — significant" },
  { value: "significant_day", label: "Past day — significant" },
  { value: "significant_week", label: "Past week — significant" },
  { value: "significant_month", label: "Past month — significant" },
];

const USGS_FEEDS = new Set(USGS_FEED_OPTIONS.map((option) => option.value));

/** USGS asks clients not to poll summary feeds faster than once a minute. */
export const USGS_MIN_POLL_MS = 60_000;

const HAZARD_TYPES = new Set(["landslide", "volcanic eruption"]);

type MemEntry = {
  body: unknown;
  lastModified?: string;
  etag?: string;
  storedAt: number;
  waitMs: number;
  maxAgeSec: number;
};

const memory = new Map<string, MemEntry>();

export function usgsFeedUrl(feedId: string): string {
  if (!USGS_FEEDS.has(feedId)) {
    throw new Error(`unknown USGS feed "${feedId}"`);
  }
  return `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feedId}.geojson`;
}

export function parseCacheControl(header: string | null): number | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("max-age=")) continue;
    const secs = Number(trimmed.slice("max-age=".length).trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs);
  }
  return null;
}

/** Remaining CDN freshness, but never faster than USGS's once-a-minute rule. */
export function pollWaitMs(maxAgeSec: number | null, ageSec: number): number {
  const maxAge = maxAgeSec == null ? 60 : maxAgeSec;
  const age = Math.min(Math.max(0, ageSec), maxAge);
  const remaining = Math.max(0, maxAge - age);
  return Math.max(60, remaining) * 1000;
}

function parseRetryAfter(value: string | null): number {
  if (!value) return USGS_MIN_POLL_MS;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.max(60, secs) * 1000;
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(USGS_MIN_POLL_MS, when - Date.now());
  return USGS_MIN_POLL_MS;
}

/** Keep in sync with `assess` in `src-tauri/src/sources/quake.rs`. */
export function assessQuake(args: {
  mag?: number;
  tsunami: boolean;
  pager?: string;
  eventType: string;
  notableMinMag: number;
}): { severity: IncidentSeverity; notable: boolean } {
  const mag = args.mag ?? 0;
  const pager = (args.pager ?? "").trim().toLowerCase();
  const kind = args.eventType.trim().toLowerCase();
  const hazard = HAZARD_TYPES.has(kind);
  const notable =
    args.tsunami ||
    hazard ||
    pager === "yellow" ||
    pager === "orange" ||
    pager === "red" ||
    mag >= args.notableMinMag;
  const severity: IncidentSeverity =
    args.tsunami || pager === "orange" || pager === "red" || mag >= 6 || kind === "volcanic eruption"
      ? "alert"
      : notable
        ? "warn"
        : "info";
  return { severity, notable };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numField(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function summaryText(event: QuakeEvent): string {
  const parts: string[] = [];
  if (event.mag != null) parts.push(`M${event.mag.toFixed(1)}`);
  parts.push(event.eventType);
  if (event.tsunami) parts.push("tsunami flag");
  if (event.depthKm != null) parts.push(`${event.depthKm.toFixed(1)} km deep`);
  if (event.place) parts.push(event.place);
  return parts.join(" · ");
}

export function parseUsgsFeed(
  body: unknown,
  limit: number,
  notableMinMag: number,
): {
  events: QuakeEvent[];
  incidents: Incident[];
  feedTitle?: string;
  totalCount?: number;
} {
  const root = asRecord(body);
  const features = root?.features;
  if (!Array.isArray(features)) {
    throw new Error("USGS payload was not a GeoJSON FeatureCollection");
  }
  const events: QuakeEvent[] = [];
  features.forEach((feature, index) => {
    const row = asRecord(feature);
    if (!row) return;
    const props = asRecord(row.properties) ?? {};
    const geometry = asRecord(row.geometry);
    const coords = geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const depthRaw = coords.length > 2 ? Number(coords[2]) : undefined;
    const mag = numField(props, ["mag"]);
    const eventType = strField(props, ["type"]) ?? "unknown";
    const place = strField(props, ["place"]);
    const pager = strField(props, ["alert"]);
    const tsunami = numField(props, ["tsunami"]) === 1;
    const { severity, notable } = assessQuake({
      mag,
      tsunami,
      pager,
      eventType,
      notableMinMag,
    });
    const title =
      strField(props, ["title"]) ??
      `${mag != null ? `M ${mag.toFixed(1)} ` : ""}${eventType} — ${place ?? "unknown location"}`;
    const id =
      (typeof row.id === "string" && row.id.trim() ? row.id : undefined) ??
      (typeof row.id === "number" ? String(row.id) : undefined) ??
      strField(props, ["code", "ids"]) ??
      `row-${index}`;
    const time = numField(props, ["time"]);
    const updated = numField(props, ["updated"]);
    events.push({
      id,
      title,
      mag,
      magType: strField(props, ["magType"]),
      place,
      occurredAt: time != null ? new Date(time).toISOString() : undefined,
      updatedAt: updated != null ? new Date(updated).toISOString() : undefined,
      lat,
      lon,
      depthKm: depthRaw != null && Number.isFinite(depthRaw) ? depthRaw : undefined,
      tsunami,
      alert: pager,
      significance: numField(props, ["sig"]),
      eventType,
      status: strField(props, ["status"]),
      url: strField(props, ["url"]),
      felt: numField(props, ["felt"]),
      mmi: numField(props, ["mmi"]),
      severity,
      notable,
    });
  });
  events.sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")));
  const metadata = asRecord(root?.metadata);
  const totalCount =
    typeof metadata?.count === "number" ? metadata.count : events.length;
  const feedTitle = typeof metadata?.title === "string" ? metadata.title : undefined;
  const shown = events.slice(0, Math.max(1, Math.min(300, limit)));
  const incidents: Incident[] = shown.map((event) => ({
    id: event.id,
    title: event.title,
    category: event.eventType,
    description: event.tsunami ? `Tsunami flag. ${summaryText(event)}` : summaryText(event),
    occurredAt: event.occurredAt,
    address: event.place,
    lat: event.lat,
    lon: event.lon,
    detailUrl: event.url,
    severity: event.severity,
  }));
  return { events: shown, incidents, feedTitle, totalCount };
}

function cacheRemaining(entry: MemEntry): number | null {
  const remaining = entry.waitMs - (Date.now() - entry.storedAt);
  return remaining > 1000 ? remaining : null;
}

function buildPayload(
  sourceId: string,
  source: SourceConfig,
  feedId: string,
  feedUrl: string,
  body: unknown,
  timing: { pollAfterMs: number; maxAgeSec: number; fromCache: boolean; notModified: boolean },
  note?: string,
): SourcePayload {
  const limit = Number(source.params.limit ?? 50) || 50;
  const notableMinMag = Number(source.params.notableMinMag ?? 4.5);
  const parsed = parseUsgsFeed(
    body,
    limit,
    Number.isFinite(notableMinMag) ? notableMinMag : 4.5,
  );
  const quake: QuakePayload = {
    feedId,
    feedUrl,
    feedTitle: parsed.feedTitle,
    totalCount: parsed.totalCount,
    events: parsed.events,
    pollAfterMs: Math.max(1000, timing.pollAfterMs),
    cacheMaxAgeSec: timing.maxAgeSec,
    fromCache: timing.fromCache,
    notModified: timing.notModified,
  };
  const attribution = parsed.feedTitle
    ? `USGS Earthquake Hazards Program — ${parsed.feedTitle}`
    : "USGS Earthquake Hazards Program";
  return {
    sourceId,
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution,
    note:
      note ??
      "Summary GeoJSON. Polled on the USGS cache lifetime, never faster than once a minute. Last-Modified conditional GET.",
    incidents: parsed.incidents,
    quake,
  };
}

/**
 * Browser mock. Vite proxies `/proxy/usgs` so Cache-Control, Age, and
 * Last-Modified are readable (Age is not a CORS-safelisted header).
 * The Tauri path does the same work in Rust.
 */
export async function fetchUsgsInBrowser(
  sourceId: string,
  source: SourceConfig,
): Promise<SourcePayload> {
  const feedId = String(source.params.feed ?? "all_day");
  const feedUrl = usgsFeedUrl(feedId);
  const cached = memory.get(feedId);
  const remaining = cached ? cacheRemaining(cached) : null;
  if (cached && remaining != null) {
    return buildPayload(sourceId, source, feedId, feedUrl, cached.body, {
      pollAfterMs: remaining,
      maxAgeSec: cached.maxAgeSec,
      fromCache: true,
      notModified: false,
    });
  }

  const headers: Record<string, string> = {
    accept: "application/geo+json, application/json",
  };
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const path = new URL(feedUrl).pathname;
  let response: Response;
  try {
    response = await fetch(`/proxy/usgs${path}`, { cache: "no-store", headers });
  } catch (err) {
    if (cached) {
      return buildPayload(sourceId, source, feedId, feedUrl, cached.body, {
        pollAfterMs: USGS_MIN_POLL_MS,
        maxAgeSec: cached.maxAgeSec,
        fromCache: true,
        notModified: false,
      }, `USGS request failed (${err instanceof Error ? err.message : String(err)}). Showing the last feed.`);
    }
    throw err;
  }

  const maxAge = parseCacheControl(response.headers.get("cache-control"));
  const ageHeader = Number(response.headers.get("age") ?? "0");
  const age = Number.isFinite(ageHeader) && ageHeader > 0 ? ageHeader : 0;
  const waitMs = pollWaitMs(maxAge, age);
  const maxAgeSec = maxAge ?? 60;
  const lastModified = response.headers.get("last-modified") ?? cached?.lastModified;
  const etag = response.headers.get("etag") ?? cached?.etag;

  if (response.status === 304 && cached) {
    memory.set(feedId, {
      body: cached.body,
      lastModified,
      etag,
      storedAt: Date.now(),
      waitMs,
      maxAgeSec,
    });
    return buildPayload(sourceId, source, feedId, feedUrl, cached.body, {
      pollAfterMs: waitMs,
      maxAgeSec,
      fromCache: false,
      notModified: true,
    });
  }

  if ((response.status === 429 || response.status >= 500) && cached) {
    const retryMs =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : USGS_MIN_POLL_MS;
    memory.set(feedId, {
      ...cached,
      storedAt: Date.now(),
      waitMs: retryMs,
    });
    return buildPayload(
      sourceId,
      source,
      feedId,
      feedUrl,
      cached.body,
      {
        pollAfterMs: retryMs,
        maxAgeSec: cached.maxAgeSec,
        fromCache: true,
        notModified: false,
      },
      `USGS HTTP ${response.status}. Showing the last feed.`,
    );
  }

  if (!response.ok) {
    throw new Error(`USGS HTTP ${response.status} for ${feedId}`);
  }

  const body: unknown = await response.json();
  memory.set(feedId, {
    body,
    lastModified,
    etag,
    storedAt: Date.now(),
    waitMs,
    maxAgeSec,
  });
  return buildPayload(sourceId, source, feedId, feedUrl, body, {
    pollAfterMs: waitMs,
    maxAgeSec,
    fromCache: false,
    notModified: false,
  });
}
