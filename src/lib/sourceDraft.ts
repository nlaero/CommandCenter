import { getAdapter } from "../adapters/catalog";
import { CALLS_APP } from "./broadcastifyCallsPreset";
import { isPennHillsPreset, PENN_HILLS_FEED } from "./broadcastifyPreset";
import { ensureLocationParams, locationSaveError, readCoords } from "./location";
import { localAudioSaveError } from "./localAudio";
import { newsSaveError } from "./news";
import { brandId, canonicalStreamUrl, streamLinkError } from "./privateCameras";
import { sealPublicCamera } from "./publicCameras";
import { blankFeed, feedsSaveError, normalizeSafetyParams } from "./safety";
import { weatherMapsSaveError } from "./weatherMaps";
import { normalizeWebScannerUrl, webScannerUrlError } from "./webScanner";
import { xClientIdError, xPostLimitError } from "./xFollow";
import { newId, validateSourceFields } from "./api";
import type { SourceConfig } from "../types";

export const PRT_BUS_ALERTS = "https://truetime.rideprt.org/gtfsrt-bus/alerts";
export const PRT_RAIL_ALERTS = "https://truetime.rideprt.org/gtfsrt-train/alerts";

const RADIUS: Record<string, { min: number; max: number; fallback: number }> = {
  "rivers.nwps": { min: 5, max: 150, fallback: 25 },
  "storms.spc": { min: 10, max: 300, fallback: 50 },
  "lightning.glm": { min: 5, max: 200, fallback: 30 },
  "tfr.faa": { min: 10, max: 400, fallback: 80 },
  "spills.uscg": { min: 5, max: 200, fallback: 40 },
};

export function inPrtArea(lat: number, lon: number): boolean {
  return lat >= 40.15 && lat <= 40.85 && lon >= -80.45 && lon <= -79.55;
}

export function initialParams(typeId: string): Record<string, unknown> {
  const initial: Record<string, unknown> = {};
  if (typeId === "incident.opendata") {
    initial.provider = "chicago";
    initial.limit = 50;
    initial.attribution = "City of Chicago Open Data — Crimes 2001 to Present";
  }
  if (typeId === "broadcastify.owner") {
    initial.preset = PENN_HILLS_FEED.preset;
    initial.feedId = PENN_HILLS_FEED.feedId;
    initial.includeArchives = true;
    initial.enableCaptions = true;
  }
  if (typeId === "broadcastify.calls") {
    initial.selector = "system";
    initial.limit = 40;
    initial.keyId = CALLS_APP.keyId;
    initial.issuer = CALLS_APP.issuer;
  }
  if (typeId === "weather.openmeteo") {
    initial.scopes = "local";
    initial.units = "imperial";
    initial.showRadar = true;
    initial.showSatellite = true;
    initial.mapCount = 1;
    initial.rotateMaps = false;
    initial.mapRotateSec = 30;
  }
  if (typeId === "usgs.earthquake") {
    initial.feed = "all_day";
    initial.limit = 50;
    initial.notableMinMag = 4.5;
    initial.autoPan = true;
  }
  if (typeId === "noaa.space") {
    initial.hemisphere = "auto";
    initial.showAurora = true;
  }
  if (typeId === "safety.nearby") {
    initial.radiusMi = 10;
    initial.enableCaptions = true;
    initial.feeds = [blankFeed()];
  }
  if (typeId === "scanner.web" || typeId === "audio.local") {
    initial.enableCaptions = true;
  }
  if (typeId === "x.follow") initial.limit = 20;
  if (typeId === "news.rss") {
    initial.limit = 40;
    initial.outlets = [];
  }
  if (typeId === "camera.private") initial.brand = "custom";
  const radius = RADIUS[typeId];
  if (radius) initial.radiusMi = radius.fallback;
  if (typeId === "disease.who") initial.limit = 12;
  if (typeId === "alarms.home") {
    initial.link = "homeassistant";
    initial.topic = "homeassistant/#";
    initial.mqttPort = 1883;
  }
  if (typeId === "transit.gtfs") initial.urls = "";
  return initial;
}

export function initialSecrets(typeId: string): Record<string, string> {
  if (typeId === "broadcastify.owner") {
    return { "broadcastify.username": PENN_HILLS_FEED.username };
  }
  return {};
}

export function editParams(typeId: string, params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params };
  if (typeId === "usgs.earthquake" && next.autoPan === undefined) next.autoPan = true;
  if (typeId === "safety.nearby") {
    if (!Array.isArray(next.feeds) || next.feeds.length === 0) next.feeds = [blankFeed()];
    if (next.radiusMi === undefined || next.radiusMi === "") next.radiusMi = 10;
    if (next.enableCaptions === undefined) next.enableCaptions = true;
  }
  if ((typeId === "audio.local" || typeId === "scanner.web") && next.enableCaptions === undefined) {
    next.enableCaptions = true;
  }
  if (typeId === "broadcastify.owner") {
    const feedId = String(next.feedId ?? "").trim();
    if (next.preset !== "penn-hills" && next.preset !== "custom") {
      next.preset = feedId === PENN_HILLS_FEED.feedId || feedId === "" ? PENN_HILLS_FEED.preset : "custom";
    }
    if (next.preset === PENN_HILLS_FEED.preset) next.feedId = PENN_HILLS_FEED.feedId;
  }
  if (typeId === "weather.openmeteo") {
    if (!next.scopes) next.scopes = "local";
    if (next.rotateMaps === undefined) next.rotateMaps = false;
    if (next.mapRotateSec === undefined || next.mapRotateSec === "") next.mapRotateSec = 30;
  }
  if (typeId === "alarms.home") {
    if (!next.link) next.link = "homeassistant";
    if (!next.topic) next.topic = "homeassistant/#";
  }
  return next;
}

export function sourceHint(typeId: string): string | null {
  switch (typeId) {
    case "weather.openmeteo":
      return "Choose the maps, how many are on screen, and whether they rotate inside this weather panel. Weather cannot be added to a rolling panel.";
    case "transit.gtfs":
      return "Pittsburgh bus and rail alerts are filled in when the confirmed place is in that area. Anywhere else, paste the agency alerts URL.";
    case "agency.rss":
      return "Paste a public RSS or Atom URL from the agency. This is not a directory, and it is not a meeting calendar.";
    case "spills.uscg":
      return "These are caller reports to the Coast Guard. They are not confirmed spills and they do not include a cleanup status.";
    case "internet.ioda":
      return "Outages for this state, shown on this computer. The panel credits Georgia Tech.";
    case "alarms.home":
      return "Point this at a Home Assistant hub or a broker on this network. Smoke, gas, and carbon monoxide trip as alerts. Water, doors, and gates warn.";
    case "lightning.glm":
      return "NOAA GOES-East lightning. Flashes outside the radius are dropped.";
    case "disease.who":
      return "A short global list from WHO. It is not a local case map.";
    default:
      return null;
  }
}

function clampRadius(typeId: string, params: Record<string, unknown>): void {
  const spec = RADIUS[typeId];
  if (!spec) return;
  const n = Number(params.radiusMi);
  const value = Number.isFinite(n) ? n : spec.fallback;
  params.radiusMi = Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

function transitUrls(params: Record<string, unknown>): string[] {
  return String(params.urls ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function fillTransitUrls(params: Record<string, unknown>): Record<string, unknown> {
  const coords = readCoords(params);
  if (!coords || !inPrtArea(coords.lat, coords.lon)) return params;
  if (transitUrls(params).length > 0) return params;
  return { ...params, urls: `${PRT_BUS_ALERTS}\n${PRT_RAIL_ALERTS}` };
}

export type PreparedSource = {
  source: SourceConfig;
  secretsProvided: Record<string, string>;
};

export async function prepareSource(args: {
  typeId: string;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  existing?: SourceConfig;
  sourceId?: string;
}): Promise<{ ok: true; value: PreparedSource } | { ok: false; message: string }> {
  const adapter = getAdapter(args.typeId);
  if (!adapter) return { ok: false, message: "That source is not available." };
  const existing = args.existing;
  const secretsProvided = Object.fromEntries(
    Object.entries(args.secrets).filter(([, value]) => Boolean(value?.trim())),
  );
  let params = { ...args.params };
  if (args.typeId === "transit.gtfs") params = fillTransitUrls(params);

  const required = adapter.fields
    .filter((field) => field.required)
    .map((field) => field.key)
    .filter((key) => {
      if (args.typeId === "incident.opendata" && key === "endpoint") {
        return String(params.provider ?? "") === "custom";
      }
      if (args.typeId === "broadcastify.owner" && key === "feedId") {
        return !isPennHillsPreset(params);
      }
      if (existing && key.startsWith("secret:")) {
        const name = key.slice("secret:".length);
        if (existing.secrets.includes(name) && !secretsProvided[name]) return false;
      }
      return true;
    });

  if (args.typeId === "incident.opendata" && String(params.provider ?? "") === "custom") {
    if (!String(params.endpoint ?? "").trim()) {
      return { ok: false, message: "missing required fields: endpoint" };
    }
  }
  const locationError = locationSaveError(adapter.fields, params);
  if (locationError) return { ok: false, message: locationError };
  if (args.typeId === "safety.nearby") {
    const safetyError = feedsSaveError(params);
    if (safetyError) return { ok: false, message: safetyError };
  }
  if (args.typeId === "scanner.web") {
    const scannerError = webScannerUrlError(String(params.url ?? ""));
    if (scannerError) return { ok: false, message: scannerError };
  }
  if (args.typeId === "x.follow") {
    const xError = xClientIdError(String(params.clientId ?? "")) ?? xPostLimitError(params.limit);
    if (xError) return { ok: false, message: xError };
  }
  if (args.typeId === "audio.local") {
    const audioError = localAudioSaveError(params);
    if (audioError) return { ok: false, message: audioError };
  }
  if (args.typeId === "news.rss") {
    const newsError = newsSaveError(params);
    if (newsError) return { ok: false, message: newsError };
  }
  if (args.typeId === "camera.public") {
    const sealed = sealPublicCamera(params);
    if (!sealed.ok) return { ok: false, message: sealed.message };
  }
  if (args.typeId === "camera.private") {
    const linkError = streamLinkError(params.url);
    if (linkError) return { ok: false, message: linkError };
  }
  if (args.typeId === "weather.openmeteo") {
    const mapsError = weatherMapsSaveError(params);
    if (mapsError) return { ok: false, message: mapsError };
    const count = Number(params.mapCount);
    const seconds = Number(params.mapRotateSec);
    if (params.mapCount !== undefined && params.mapCount !== "" && (!Number.isFinite(count) || count < 1)) {
      return { ok: false, message: "Choose how many weather maps are on screen." };
    }
    if (params.rotateMaps === true && Number.isFinite(seconds)) {
      params.mapRotateSec = Math.min(3600, Math.max(5, Math.round(seconds)));
    }
  }
  if (args.typeId === "agency.rss" && !/^https?:\/\//i.test(String(params.url ?? "").trim())) {
    return { ok: false, message: "Paste the agency's public feed URL." };
  }
  if (args.typeId === "transit.gtfs" && transitUrls(params).length === 0) {
    return {
      ok: false,
      message: "Paste the agency's GTFS-RT alerts URL. Pittsburgh bus and rail are filled in only for a place in that area.",
    };
  }
  if (args.typeId === "disease.who") {
    const limit = Number(params.limit);
    params.limit = Number.isFinite(limit) ? Math.min(40, Math.max(1, Math.round(limit))) : 12;
  }
  if (args.typeId === "internet.ioda") {
    const asn = String(params.asn ?? "").trim();
    if (asn && !/^(AS)?\d{1,10}$/i.test(asn)) {
      return { ok: false, message: "The network number should be digits, with or without AS." };
    }
    if (asn) params.asn = asn.replace(/^AS/i, "");
  }
  if (args.typeId === "alarms.home") {
    const link = String(params.link ?? "homeassistant");
    const base = String(params.baseUrl ?? "").trim();
    const host = String(params.mqttHost ?? "").trim();
    const wantsHa = link === "homeassistant" || link === "both";
    const wantsMqtt = link === "mqtt" || link === "both";
    if (wantsHa && !/^https?:\/\//i.test(base)) {
      return { ok: false, message: "Enter the Home Assistant URL on this network." };
    }
    if (wantsHa) {
      const stored = existing?.secrets.includes("alarms.token") && !secretsProvided["alarms.token"];
      if (!stored && !secretsProvided["alarms.token"]) {
        return { ok: false, message: "The Home Assistant token stays in the OS keyring. Enter it to save this panel." };
      }
    }
    if (wantsMqtt && !host) {
      return { ok: false, message: "Enter the MQTT host on this network." };
    }
    if (!wantsHa && !wantsMqtt) {
      return { ok: false, message: "Choose a Home Assistant hub or a broker on this network." };
    }
    if (!String(params.topic ?? "").trim()) params.topic = "homeassistant/#";
  }
  clampRadius(args.typeId, params);

  const readyParams = ensureLocationParams(adapter.fields, params);
  const validation = await validateSourceFields(required, readyParams, secretsProvided);
  if (!validation.ok) return { ok: false, message: validation.message };

  const cleaned = { ...readyParams };
  if (args.typeId === "incident.opendata" && String(cleaned.provider) !== "custom") {
    delete cleaned.endpoint;
  }
  if (args.typeId === "broadcastify.owner" && isPennHillsPreset(cleaned)) {
    cleaned.preset = PENN_HILLS_FEED.preset;
    cleaned.feedId = PENN_HILLS_FEED.feedId;
  }
  if (args.typeId === "safety.nearby") Object.assign(cleaned, normalizeSafetyParams(cleaned));
  let refresh = existing?.refresh ?? adapter.defaultRefresh;
  if (args.typeId === "scanner.web") {
    cleaned.url = normalizeWebScannerUrl(String(cleaned.url ?? ""));
    if (cleaned.enableCaptions === undefined) cleaned.enableCaptions = true;
  }
  if (args.typeId === "camera.public") {
    const sealed = sealPublicCamera(cleaned);
    if (!sealed.ok) return { ok: false, message: sealed.message };
    Object.assign(cleaned, sealed.params);
    refresh = sealed.refresh;
  }
  if (args.typeId === "camera.private") {
    cleaned.url = canonicalStreamUrl(cleaned.url);
    cleaned.brand = brandId(cleaned.brand);
  }
  const source: SourceConfig = {
    type: adapter.typeId,
    params: cleaned,
    refresh,
    secrets: Array.from(new Set([...(existing?.secrets ?? []), ...Object.keys(secretsProvided)])),
    enabled: true,
    draft: false,
  };
  return { ok: true, value: { source, secretsProvided } };
}

export function newSourceId(typeId: string): string {
  const tail = typeId.split(".").pop() ?? "source";
  return newId(`src.${tail}`);
}
