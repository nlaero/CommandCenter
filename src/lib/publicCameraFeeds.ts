import type { PublicCamera, PublicCameraMedia } from "./publicCameraData.ts";
import { milesBetween } from "./publicCameras.ts";

export type AgencyFeed = {
  id: string;
  title: string;
  url: string;
  keywords: string[];
  anchor: { lat: number; lon: number };
  /** Fetch this catalog when a confirmed place is within this many miles. */
  reachMiles: number;
  parse: (body: unknown) => PublicCamera[];
};

const cache = new Map<string, PublicCamera[]>();

export function cachedFeed(id: string): PublicCamera[] | undefined {
  return cache.get(id);
}

export function storeFeed(id: string, cameras: PublicCamera[]): void {
  cache.set(id, cameras);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function idText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function httpsUrl(value: unknown): string | null {
  const url = text(value);
  if (!url.startsWith("https://")) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function camera(partial: PublicCamera): PublicCamera | null {
  if (!partial.id || !partial.name || !partial.url) return null;
  if (!Number.isFinite(partial.lat) || !Number.isFinite(partial.lon)) return null;
  if (partial.lat < -90 || partial.lat > 90 || partial.lon < -180 || partial.lon > 180) return null;
  return partial;
}

export function parseCaltrans(district: number, body: unknown): PublicCamera[] {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: PublicCamera[] = [];
  for (const row of rows) {
    const cctv = (row as { cctv?: unknown })?.cctv as Record<string, unknown> | undefined;
    if (!cctv || String(cctv.inService).toLowerCase() !== "true") continue;
    const loc = (cctv.location ?? {}) as Record<string, unknown>;
    const imageData = (cctv.imageData ?? {}) as Record<string, unknown>;
    const still = (imageData.static ?? {}) as Record<string, unknown>;
    const url = httpsUrl(still.currentImageURL);
    const lat = num(loc.latitude);
    const lon = num(loc.longitude);
    const name = text(loc.locationName);
    if (!url || lat == null || lon == null || !name) continue;
    const placeName = text(loc.nearbyPlace);
    let seconds = num(still.currentImageUpdateFrequency) ?? 30;
    seconds = Math.min(3600, Math.max(5, Math.round(seconds)));
    const next = camera({
      id: `ct-d${district}-${idText(cctv.index) || String(out.length)}`,
      name,
      place: placeName ? `${placeName}, California` : "California",
      region: "California",
      agency: "Caltrans",
      lat,
      lon,
      url,
      media: "image",
      refresh: `${seconds}s`,
      attribution: "Caltrans CCTV",
      featured: false,
    });
    if (next) out.push(next);
    if (out.length >= 800) break;
  }
  return out;
}

export function parseNyc(body: unknown): PublicCamera[] {
  if (!Array.isArray(body)) return [];
  const out: PublicCamera[] = [];
  for (const row of body) {
    const item = row as Record<string, unknown>;
    if (String(item.isOnline).toLowerCase() === "false") continue;
    const url = httpsUrl(item.imageUrl);
    const lat = num(item.latitude);
    const lon = num(item.longitude);
    const name = text(item.name);
    const id = text(item.id);
    if (!url || lat == null || lon == null || !name || !id) continue;
    const area = text(item.area);
    const next = camera({
      id: `nyc-${id}`,
      name,
      place: area ? `${area}, New York` : "New York",
      region: "New York",
      agency: "New York City Department of Transportation",
      lat,
      lon,
      url,
      media: "image" satisfies PublicCameraMedia,
      refresh: "30s",
      attribution: "NYC DOT traffic camera",
      featured: false,
    });
    if (next) out.push(next);
    if (out.length >= 800) break;
  }
  return out;
}

function marylandName(row: Record<string, unknown>): string {
  const name = text(row.name);
  const desc = text(row.description);
  if (!name) return desc;
  if (!desc) return name;
  if (/^\d+$/.test(name) || desc.length > name.length) return desc;
  return name;
}

export function parseMaryland(body: unknown): PublicCamera[] {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: PublicCamera[] = [];
  for (const row of rows) {
    const item = row as Record<string, unknown>;
    if (text(item.opStatus).toUpperCase() !== "OK") continue;
    const id = text(item.id);
    const host = text(item.cctvIp);
    if (!/^[a-f0-9]+$/i.test(id)) continue;
    if (!/^[a-z0-9.-]+$/i.test(host) || host.includes("..")) continue;
    const url = httpsUrl(`https://${host}/rtplive/${id}/playlist.m3u8`);
    const lat = num(item.lat);
    const lon = num(item.lon);
    const name = marylandName(item);
    if (!url || lat == null || lon == null || !name) continue;
    const next = camera({
      id: `md-${id.slice(0, 8)}`,
      name,
      place: /baltimore/i.test(name) ? "Baltimore area, Maryland" : "Maryland",
      region: "Maryland",
      agency: "Maryland DOT CHART",
      lat,
      lon,
      url,
      media: "hls",
      refresh: "30s",
      attribution: "Maryland DOT CHART",
      featured: false,
    });
    if (next) out.push(next);
    if (out.length >= 800) break;
  }
  return out;
}

function caltransFeed(
  district: number,
  title: string,
  anchor: { lat: number; lon: number },
  keywords: string[],
): AgencyFeed {
  return {
    id: `caltrans-d${district}`,
    title,
    url: `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, "0")}.json`,
    keywords,
    anchor,
    reachMiles: 120,
    parse: (body) => parseCaltrans(district, body),
  };
}

export const AGENCY_FEEDS: AgencyFeed[] = [
  {
    id: "nyc",
    title: "New York City",
    url: "https://webcams.nyctmc.org/api/cameras",
    keywords: [
      "new york",
      "nyc",
      "manhattan",
      "brooklyn",
      "queens",
      "bronx",
      "staten island",
      "central park",
    ],
    anchor: { lat: 40.75, lon: -73.99 },
    reachMiles: 70,
    parse: parseNyc,
  },
  {
    id: "maryland",
    title: "Maryland",
    url: "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do",
    keywords: ["maryland", "baltimore", "bethesda", "annapolis", "silver spring"],
    anchor: { lat: 39.29, lon: -76.61 },
    reachMiles: 230,
    parse: parseMaryland,
  },
  caltransFeed(1, "Caltrans North Coast", { lat: 40.8, lon: -124.16 }, ["eureka", "crescent city", "ukiah"]),
  caltransFeed(2, "Caltrans North", { lat: 40.59, lon: -122.39 }, ["redding", "yreka"]),
  caltransFeed(3, "Caltrans Sacramento", { lat: 38.58, lon: -121.49 }, ["sacramento", "roseville", "davis"]),
  caltransFeed(4, "Caltrans Bay Area", { lat: 37.8, lon: -122.27 }, [
    "oakland",
    "san francisco",
    "san jose",
    "berkeley",
    "bay area",
  ]),
  caltransFeed(5, "Caltrans Central Coast", { lat: 35.28, lon: -120.66 }, [
    "san luis",
    "santa barbara",
    "monterey",
    "salinas",
  ]),
  caltransFeed(6, "Caltrans San Joaquin", { lat: 36.74, lon: -119.79 }, ["fresno", "bakersfield"]),
  caltransFeed(7, "Caltrans Los Angeles", { lat: 34.05, lon: -118.24 }, [
    "los angeles",
    "hollywood",
    "glendale",
    "long beach",
  ]),
  caltransFeed(8, "Caltrans Inland Empire", { lat: 34.1, lon: -117.3 }, [
    "san bernardino",
    "riverside",
    "palm springs",
  ]),
  caltransFeed(9, "Caltrans Eastern Sierra", { lat: 37.36, lon: -118.4 }, ["bishop", "mammoth"]),
  caltransFeed(10, "Caltrans Central Valley", { lat: 37.96, lon: -121.29 }, ["stockton", "modesto", "tracy"]),
  caltransFeed(11, "Caltrans San Diego", { lat: 32.72, lon: -117.16 }, ["san diego", "chula vista", "oceanside"]),
  caltransFeed(12, "Caltrans Orange County", { lat: 33.72, lon: -117.83 }, ["orange county", "anaheim", "irvine", "santa ana"]),
];

function queryMatches(feed: AgencyFeed, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (feed.keywords.some((keyword) => q.includes(keyword))) return true;
  const tokens = q.split(/\s+/).filter((token) => token.length >= 4);
  return feed.keywords.some((keyword) => tokens.some((token) => keyword.startsWith(token)));
}

/** At most two catalogs. A city in the search box wins, then the closest place. */
export function feedsFor(query: string, near: { lat: number; lon: number } | null): AgencyFeed[] {
  const picked: AgencyFeed[] = [];
  const seen = new Set<string>();
  const add = (feed: AgencyFeed) => {
    if (picked.length >= 2 || seen.has(feed.id)) return;
    seen.add(feed.id);
    picked.push(feed);
  };
  for (const feed of AGENCY_FEEDS) {
    if (queryMatches(feed, query)) add(feed);
  }
  if (near && picked.length < 2) {
    const nearby = AGENCY_FEEDS.filter((feed) => milesBetween(near, feed.anchor) <= feed.reachMiles)
      .map((feed) => ({ feed, miles: milesBetween(near, feed.anchor) }))
      .sort((a, b) => a.miles - b.miles);
    for (const item of nearby) add(item.feed);
  }
  return picked;
}
