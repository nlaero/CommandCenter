import catalogFile from "./news-outlets.json" with { type: "json" };
import type { NewsFeedState, NewsPayload, NewsStory, SourceConfig, SourcePayload } from "../types";

/**
 * Free RSS news.
 *
 * National outlets are the ones the user checked. Local outlets are chosen
 * from the confirmed place: up to three catalog feeds inside their radius,
 * nearest first. If none cover that place, a Google News search for the
 * place name is the local feed. Google publishes that RSS for a personal
 * reader.
 *
 * Poll interval, shortest publisher hint that is at least one minute:
 * RSS ttl, syndication update period, and remaining Cache-Control max-age.
 * A feed that states none of those waits 15 minutes. Hints under a minute
 * (a CDN max-age of a few seconds, with no longer channel hint) still wait
 * one minute. Retry-After can only make the wait longer.
 * Keep this in step with `poll_interval_secs` in src-tauri/src/sources/news.rs.
 */

export const NEWS_USER_AGENT =
  "CommandCenter/0.1 (personal news reader; +https://github.com/nlaero/CommandCenter)";

export const NEWS_MIN_POLL_SEC = 60;
export const NEWS_DEFAULT_POLL_SEC = 15 * 60;
export const LOCAL_OUTLET_CAP = 3;
const ITEMS_PER_FEED = 60;
const MAX_FEED_BYTES = 2_000_000;

export type NationalOutlet = { id: string; name: string; url: string };
export type LocalOutlet = NationalOutlet & {
  lat: number;
  lon: number;
  radiusMi: number;
  priority: number;
};
export type LocalMatch = LocalOutlet & { distanceMi: number };
export type ResolvedFeed = {
  id: string;
  name: string;
  url: string;
  scope: "national" | "local";
};
export type PollHints = {
  ttlMinutes?: number | null;
  updatePeriod?: string | null;
  updateFrequency?: number | null;
  maxAgeSec?: number | null;
};

type CatalogFile = { national: NationalOutlet[]; local: LocalOutlet[] };
const catalog = catalogFile as CatalogFile;

export const NATIONAL_OUTLETS: NationalOutlet[] = catalog.national;
export const LOCAL_OUTLETS: LocalOutlet[] = catalog.local;

const NATIONAL_BY_ID = new Map(NATIONAL_OUTLETS.map((outlet) => [outlet.id, outlet]));
const CATALOG_URLS = new Set<string>([
  ...NATIONAL_OUTLETS.map((outlet) => outlet.url),
  ...LOCAL_OUTLETS.map((outlet) => outlet.url),
]);

const PERIOD_SEC: Record<string, number> = {
  hourly: 3600,
  daily: 86400,
  weekly: 7 * 86400,
  monthly: 30 * 86400,
  yearly: 365 * 86400,
};

const COUNTRIES = new Set([
  "united states",
  "united states of america",
  "usa",
  "u.s.",
  "u.s.a.",
  "us",
]);

const STATE_NAMES = new Set([
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "district of columbia",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
]);

const STATE_ABBR = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "dc", "fl", "ga", "hi", "id", "il", "in", "ia",
  "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm",
  "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa",
  "wv", "wi", "wy",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  middot: "·",
};

export type ParsedFeed = {
  ttlMinutes: number | null;
  updatePeriod: string | null;
  updateFrequency: number | null;
  items: ParsedItem[];
};

export type ParsedItem = {
  title: string;
  link: string | null;
  guid: string | null;
  published: string | null;
  summary: string | null;
};

type ElementHit = { attrs: string; inner: string; end: number };

export function newsSaveError(params: Record<string, unknown>): string | null {
  if (selectedNationalIds(params).length === 0) return "Pick at least one national outlet.";
  return null;
}

export function selectedNationalIds(params: Record<string, unknown>): string[] {
  const raw = params.outlets;
  const ids = Array.isArray(raw)
    ? raw.map((value) => String(value))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!NATIONAL_BY_ID.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return NATIONAL_OUTLETS.map((outlet) => outlet.id).filter((id) => seen.has(id));
}

export function storyLimit(params: Record<string, unknown>): number {
  const raw = params.limit;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 40;
  if (!Number.isFinite(parsed)) return 40;
  return Math.min(100, Math.max(1, Math.round(parsed)));
}

export function confirmedNewsPlace(
  params: Record<string, unknown>,
): { lat: number; lon: number; label: string } | null {
  const raw = params.location;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    if (row.confirmed === true) {
      const lat = finite(row.lat);
      const lon = finite(row.lon);
      if (lat != null && lon != null && inRange(lat, lon)) {
        const label =
          typeof row.label === "string" && row.label.trim()
            ? row.label.trim()
            : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        return { lat, lon, label };
      }
    }
  }
  const lat = finite(params.lat);
  const lon = finite(params.lon);
  if (lat == null || lon == null || !inRange(lat, lon)) return null;
  return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
}

export function placeQuery(label: string): string | null {
  let parts = label
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !COUNTRIES.has(part.toLowerCase()));
  while (parts.length > 1 && /\d/.test(parts[0])) parts = parts.slice(1);
  if (!parts.length || !/[a-z]/i.test(parts.join(" "))) return null;
  let stateIndex = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (isState(parts[i])) {
      stateIndex = i;
      break;
    }
  }
  if (stateIndex > 0) {
    const city =
      parts.slice(0, stateIndex).find((part) => !isCounty(part)) ?? parts[0];
    return `${city}, ${parts[stateIndex]}`;
  }
  return parts.slice(0, 2).join(", ");
}

export function googleNewsUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

export function isGoogleNewsSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "news.google.com" &&
      parsed.pathname === "/rss/search" &&
      Boolean(parsed.searchParams.get("q")?.trim())
    );
  } catch {
    return false;
  }
}

export function isAllowedNewsUrl(url: string): boolean {
  return CATALOG_URLS.has(url) || isGoogleNewsSearchUrl(url);
}

export function matchLocalOutlets(lat: number, lon: number): LocalMatch[] {
  return LOCAL_OUTLETS.map((outlet) => ({
    ...outlet,
    distanceMi: milesBetween(lat, lon, outlet.lat, outlet.lon),
  }))
    .filter((outlet) => outlet.distanceMi <= outlet.radiusMi)
    .sort(
      (a, b) =>
        a.distanceMi - b.distanceMi || a.priority - b.priority || a.name.localeCompare(b.name),
    )
    .slice(0, LOCAL_OUTLET_CAP);
}

export function formatMiles(miles: number): string {
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function resolveNewsFeeds(params: Record<string, unknown>):
  | { ok: true; feeds: ResolvedFeed[]; placeLabel: string }
  | { ok: false; message: string } {
  const place = confirmedNewsPlace(params);
  if (!place) {
    return {
      ok: false,
      message:
        "Find a location first. Use GPS, network location, another source on this device, or an address. Command Center has to confirm the place before this source can be saved.",
    };
  }
  const ids = selectedNationalIds(params);
  if (!ids.length) return { ok: false, message: "Pick at least one national outlet." };
  const feeds: ResolvedFeed[] = ids.map((id) => {
    const outlet = NATIONAL_BY_ID.get(id)!;
    return { id: outlet.id, name: outlet.name, url: outlet.url, scope: "national" };
  });
  const local = matchLocalOutlets(place.lat, place.lon);
  for (const outlet of local) {
    feeds.push({ id: outlet.id, name: outlet.name, url: outlet.url, scope: "local" });
  }
  if (!local.length) {
    const query = placeQuery(place.label);
    if (query) {
      feeds.push({
        id: "google.local",
        name: `Local headlines · ${query}`,
        url: googleNewsUrl(query),
        scope: "local",
      });
    }
  }
  return { ok: true, feeds, placeLabel: place.label };
}

export function syndicationSec(
  period?: string | null,
  frequency?: number | null,
): number | null {
  if (!period) return null;
  const base = PERIOD_SEC[period.trim().toLowerCase()];
  if (!base) return null;
  const times = frequency != null && frequency > 0 ? frequency : 1;
  return Math.round(base / times);
}

export function pollIntervalSec(hints: PollHints): number {
  const limits: number[] = [];
  if (hints.ttlMinutes != null && hints.ttlMinutes > 0) {
    limits.push(Math.round(hints.ttlMinutes * 60));
  }
  const sy = syndicationSec(hints.updatePeriod, hints.updateFrequency);
  if (sy != null && sy > 0) limits.push(sy);
  if (hints.maxAgeSec != null && hints.maxAgeSec > 0) limits.push(Math.round(hints.maxAgeSec));
  const usable = limits.filter((value) => value >= NEWS_MIN_POLL_SEC);
  if (usable.length) return Math.min(...usable);
  if (limits.length) return NEWS_MIN_POLL_SEC;
  return NEWS_DEFAULT_POLL_SEC;
}

export function remainingMaxAge(maxAge: number | null, age: number): number | null {
  if (maxAge == null || maxAge <= 0) return null;
  const remaining = maxAge - Math.min(Math.max(0, age), maxAge);
  return remaining > 0 ? remaining : null;
}

export function cacheControlMaxAge(header: string | null): number | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed.startsWith("max-age=")) continue;
    const secs = Number(trimmed.slice("max-age=".length).trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs);
  }
  return null;
}

export function ageSeconds(header: string | null): number {
  if (!header) return 0;
  const secs = Number(header.trim());
  if (!Number.isFinite(secs) || secs < 0) return 0;
  return Math.floor(secs);
}

export function retryAfterSec(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - now) / 1000));
}

export function nextPollSec(hints: PollHints, retryAfter: number | null): number {
  const base = pollIntervalSec(hints);
  if (retryAfter == null) return base;
  return Math.max(base, retryAfter);
}

export function parseNewsXml(xml: string): ParsedFeed {
  const source = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const ttlText = firstText(source, "ttl");
  const ttl = ttlText != null ? Number(ttlText) : NaN;
  const period = firstText(source, "updateperiod");
  const freqText = firstText(source, "updatefrequency");
  const freq = freqText != null ? Number(freqText) : NaN;
  const blocks = elementsLimited(source, "item", ITEMS_PER_FEED);
  const nodes = blocks.length ? blocks : elementsLimited(source, "entry", ITEMS_PER_FEED);
  const items: ParsedItem[] = [];
  for (const node of nodes) {
    const title = textOf(node.inner, ["title"]);
    if (!title) continue;
    const summary = textOf(node.inner, ["description", "summary", "encoded", "content"]);
    items.push({
      title,
      link: linkOf(node.inner),
      guid: textOf(node.inner, ["guid", "id"]),
      published: textOf(node.inner, ["pubdate", "published", "updated", "date"]),
      summary,
    });
  }
  return {
    ttlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    updatePeriod: period,
    updateFrequency: Number.isFinite(freq) && freq > 0 ? freq : null,
    items,
  };
}

export function mergeStories(
  groups: { feed: ResolvedFeed; items: ParsedItem[] }[],
  limit: number,
): NewsStory[] {
  const stories: NewsStory[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      const key = (item.guid || item.link || item.title).trim();
      const id = `${group.feed.id}:${key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const publishedAt = item.published ? toIso(item.published) : undefined;
      stories.push({
        id,
        title: item.title,
        outletId: group.feed.id,
        outlet: group.feed.name,
        scope: group.feed.scope,
        summary: cleanSummary(item.summary, item.title),
        url: httpUrl(item.link),
        publishedAt,
      });
    }
  }
  stories.sort((a, b) => {
    const delta = stamp(b.publishedAt) - stamp(a.publishedAt);
    if (delta !== 0) return delta;
    return a.title.localeCompare(b.title);
  });
  return stories.slice(0, limit);
}

type MemEntry = {
  xml: string;
  etag?: string;
  lastModified?: string;
  readyAt: number;
  hints: PollHints;
};

const memory = new Map<string, MemEntry>();

export async function fetchNewsInBrowser(
  sourceId: string,
  source: SourceConfig,
): Promise<SourcePayload> {
  const resolved = resolveNewsFeeds(source.params);
  if (!resolved.ok) throw new Error(resolved.message);
  const limit = storyLimit(source.params);
  const loaded = await Promise.all(resolved.feeds.map((feed) => loadFeed(feed)));
  const news = assembleNews(resolved.placeLabel, loaded, limit);
  const names = loaded.map((row) => row.feed.name);
  return {
    sourceId,
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution: names.join(" · "),
    note: newsNote(news.feeds),
    incidents: [],
    news,
  };
}

type LoadedFeed = {
  feed: ResolvedFeed;
  items: ParsedItem[];
  hints: PollHints;
  pollAfterMs: number;
  fromCache: boolean;
  notModified: boolean;
  error?: string;
};

async function loadFeed(feed: ResolvedFeed): Promise<LoadedFeed> {
  const cached = memory.get(feed.url);
  const now = Date.now();
  if (cached && cached.readyAt > now) {
    const parsed = parseNewsXml(cached.xml);
    return {
      feed,
      items: parsed.items,
      hints: cached.hints,
      pollAfterMs: cached.readyAt - now,
      fromCache: true,
      notModified: false,
    };
  }
  try {
    const headers: Record<string, string> = {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      "user-agent": NEWS_USER_AGENT,
    };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;
    const response = await fetch(`/proxy/rss?u=${encodeURIComponent(feed.url)}`, {
      headers,
      cache: "no-store",
    });
    const retry = retryAfterSec(response.headers.get("retry-after"));
    if (response.status === 304 && cached) {
      const hints = hintsFrom(response, parseNewsXml(cached.xml));
      const wait = nextPollSec(hints, retry);
      cached.readyAt = Date.now() + wait * 1000;
      cached.hints = hints;
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (etag) cached.etag = etag;
      if (lastModified) cached.lastModified = lastModified;
      return {
        feed,
        items: parseNewsXml(cached.xml).items,
        hints,
        pollAfterMs: wait * 1000,
        fromCache: false,
        notModified: true,
      };
    }
    if (!response.ok) {
      return failFeed(feed, cached, `HTTP ${response.status}`, retry);
    }
    const xml = trimFeedXml(await response.text());
    if (!/<(rss|feed|rdf)\b/i.test(xml.slice(0, 2000))) {
      return failFeed(feed, cached, "did not return a feed", retry);
    }
    const parsed = parseNewsXml(xml);
    const hints = hintsFrom(response, parsed);
    const wait = nextPollSec(hints, retry);
    memory.set(feed.url, {
      xml,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      readyAt: Date.now() + wait * 1000,
      hints,
    });
    return {
      feed,
      items: parsed.items,
      hints,
      pollAfterMs: wait * 1000,
      fromCache: false,
      notModified: false,
    };
  } catch {
    return failFeed(feed, cached, "the feed did not respond", null);
  }
}

function failFeed(
  feed: ResolvedFeed,
  cached: MemEntry | undefined,
  error: string,
  retry: number | null,
): LoadedFeed {
  const wait = nextPollSec(cached?.hints ?? {}, retry);
  if (cached) cached.readyAt = Date.now() + wait * 1000;
  const items = cached ? parseNewsXml(cached.xml).items : [];
  return {
    feed,
    items,
    hints: cached?.hints ?? {},
    pollAfterMs: wait * 1000,
    fromCache: Boolean(cached),
    notModified: false,
    error,
  };
}

function hintsFrom(response: Response, parsed: ParsedFeed): PollHints {
  const maxAge = remainingMaxAge(
    cacheControlMaxAge(response.headers.get("cache-control")),
    ageSeconds(response.headers.get("age")),
  );
  return {
    ttlMinutes: parsed.ttlMinutes,
    updatePeriod: parsed.updatePeriod,
    updateFrequency: parsed.updateFrequency,
    maxAgeSec: maxAge,
  };
}

function assembleNews(placeLabel: string, loaded: LoadedFeed[], limit: number): NewsPayload {
  const stories = mergeStories(
    loaded.map((row) => ({ feed: row.feed, items: row.items })),
    limit,
  );
  const feeds: NewsFeedState[] = loaded.map((row) => ({
    id: row.feed.id,
    name: row.feed.name,
    scope: row.feed.scope,
    pollAfterMs: Math.max(1000, row.pollAfterMs),
    fromCache: row.fromCache,
    notModified: row.notModified,
    error: row.error,
    itemCount: row.items.length,
  }));
  const soonest = feeds.reduce((min, feed) => Math.min(min, feed.pollAfterMs), NEWS_DEFAULT_POLL_SEC * 1000);
  return {
    placeLabel,
    stories,
    feeds,
    pollAfterMs: Math.max(1000, soonest),
  };
}

function newsNote(feeds: NewsFeedState[]): string {
  const parts = ["Each feed waits for its own schedule."];
  const failed = feeds.filter((feed) => feed.error);
  if (failed.length) {
    parts.push(failed.map((feed) => `${feed.name}: ${feed.error}`).join(" "));
  }
  if (feeds.some((feed) => feed.id === "google.local")) {
    parts.push("Google News is a personal-reader fallback for this place.");
  }
  return parts.join(" ");
}

function trimFeedXml(xml: string): string {
  if (xml.length < MAX_FEED_BYTES) return xml;
  const slice = xml.slice(0, MAX_FEED_BYTES);
  const lower = slice.toLowerCase();
  const item = lower.lastIndexOf("</item>");
  const entry = lower.lastIndexOf("</entry>");
  if (item < 0 && entry < 0) return slice;
  return item > entry ? slice.slice(0, item + "</item>".length) : slice.slice(0, entry + "</entry>".length);
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inRange(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isState(part: string): boolean {
  const key = part.trim().toLowerCase();
  if (STATE_NAMES.has(key)) return true;
  return key.length === 2 && STATE_ABBR.has(key);
}

function isCounty(part: string): boolean {
  return /\b(county|parish|borough)$/i.test(part.trim());
}

function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 3958.7613;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

function stamp(value?: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function toIso(value: string): string | undefined {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function httpUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return undefined;
  return text;
}

function cleanSummary(summary: string | null, title: string): string | undefined {
  if (!summary) return undefined;
  const text = summary.replace(/\s+/g, " ").trim();
  if (!text || text.toLowerCase() === title.toLowerCase()) return undefined;
  if (text.length < 24 || /^https?:\/\//i.test(text)) return undefined;
  if (text.length <= 320) return text;
  const cut = text.slice(0, 320);
  const space = cut.lastIndexOf(" ");
  return `${(space > 200 ? cut.slice(0, space) : cut).trim()}…`;
}

function firstText(xml: string, name: string): string | null {
  const hit = nextElement(xml, 0, name);
  if (!hit) return null;
  const text = innerText(hit.inner);
  return text || null;
}

function textOf(inner: string, names: string[]): string | null {
  for (const name of names) {
    const hit = nextElement(inner, 0, name);
    if (!hit) continue;
    const text = innerText(hit.inner);
    if (text) return text;
  }
  return null;
}

function linkOf(inner: string): string | null {
  let from = 0;
  let fallback: string | null = null;
  while (from < inner.length) {
    const hit = nextElement(inner, from, "link");
    if (!hit) break;
    from = hit.end;
    const href = attr(hit.attrs, "href");
    const rel = attr(hit.attrs, "rel");
    const candidate = href || innerText(hit.inner) || null;
    if (!candidate) continue;
    if (!fallback) fallback = candidate;
    if (!rel || rel.toLowerCase() === "alternate") return candidate;
  }
  return fallback;
}

function elementsLimited(xml: string, name: string, limit: number): ElementHit[] {
  const out: ElementHit[] = [];
  let from = 0;
  while (out.length < limit && from < xml.length) {
    const hit = nextElement(xml, from, name);
    if (!hit) break;
    out.push(hit);
    from = hit.end;
  }
  return out;
}

function nextElement(xml: string, from: number, wanted: string): ElementHit | null {
  let i = from;
  while (i < xml.length) {
    const skipped = skipNoise(xml, i);
    if (skipped != null) {
      i = skipped;
      continue;
    }
    if (xml[i] !== "<" || xml[i + 1] === "/" || xml[i + 1] === "?" || xml[i + 1] === "!") {
      i += 1;
      continue;
    }
    const parsed = localNameAt(xml, i + 1);
    if (!parsed) {
      i += 1;
      continue;
    }
    const gt = xml.indexOf(">", parsed.end);
    if (gt === -1) return null;
    const selfClosing = xml[gt - 1] === "/";
    const attrs = xml.slice(parsed.end, selfClosing ? gt - 1 : gt);
    if (parsed.name !== wanted) {
      i = gt + 1;
      continue;
    }
    if (selfClosing) return { attrs, inner: "", end: gt + 1 };
    const close = findClose(xml, gt + 1, parsed.name);
    if (!close) return null;
    return { attrs, inner: xml.slice(gt + 1, close.start), end: close.end };
  }
  return null;
}

function findClose(xml: string, from: number, name: string): { start: number; end: number } | null {
  let depth = 1;
  let i = from;
  while (i < xml.length) {
    const skipped = skipNoise(xml, i);
    if (skipped != null) {
      i = skipped;
      continue;
    }
    if (xml[i] !== "<") {
      i += 1;
      continue;
    }
    const closing = xml[i + 1] === "/";
    const parsed = localNameAt(xml, closing ? i + 2 : i + 1);
    if (!parsed || parsed.name !== name) {
      const gt = xml.indexOf(">", i + 1);
      i = gt === -1 ? xml.length : gt + 1;
      continue;
    }
    const gt = xml.indexOf(">", parsed.end);
    if (gt === -1) return null;
    if (closing) {
      depth -= 1;
      if (depth === 0) return { start: i, end: gt + 1 };
    } else if (xml[gt - 1] !== "/") {
      depth += 1;
    }
    i = gt + 1;
  }
  return null;
}

function skipNoise(xml: string, i: number): number | null {
  const slice = xml.slice(i, i + 9).toLowerCase();
  if (slice === "<![cdata[") {
    const close = xml.toLowerCase().indexOf("]]>", i + 9);
    return close === -1 ? xml.length : close + 3;
  }
  if (xml.startsWith("<!--", i)) {
    const close = xml.indexOf("-->", i + 4);
    return close === -1 ? xml.length : close + 3;
  }
  return null;
}

function localNameAt(xml: string, i: number): { name: string; end: number } | null {
  let j = i;
  let colon = -1;
  while (j < xml.length) {
    const ch = xml[j];
    if (ch === ":") {
      colon = j;
      j += 1;
      continue;
    }
    if (!/[A-Za-z0-9_.-]/.test(ch)) break;
    j += 1;
  }
  if (j === i) return null;
  const name = (colon >= 0 ? xml.slice(colon + 1, j) : xml.slice(i, j)).toLowerCase();
  if (!name) return null;
  return { name, end: j };
}

function innerText(inner: string): string {
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(inner);
  const decoded = cdata ? cdata[1] : decodeEntities(inner);
  return decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, key: string): string | null {
  const match = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!match) return null;
  const value = decodeEntities(match[1] ?? match[2] ?? "").trim();
  return value || null;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}
