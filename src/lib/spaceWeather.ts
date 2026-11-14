import type {
  Hemisphere,
  IncidentSeverity,
  SourceConfig,
  SourcePayload,
  SpaceAlert,
  SpacePayload,
  SpaceScales,
  AuroraPoint,
} from "../types.ts";

/**
 * NOAA SWPC products. No key.
 * https://services.swpc.noaa.gov/
 *
 * Ham pairing reads saved `ham.swpc` sources. It does not change that source.
 */
export const HAM_SOLAR_TYPE = "ham.swpc";

export const SWPC_ORIGIN = "https://services.swpc.noaa.gov";

export const SWPC_PATHS = {
  alerts: "/products/alerts.json",
  scales: "/products/noaa-scales.json",
  kp: "/products/noaa-planetary-k-index.json",
  kpNow: "/json/planetary_k_index_1m.json",
  flux: "/json/f107_cm_flux.json",
  xray: "/json/goes/primary/xrays-6-hour.json",
  ovation: "/json/ovation_aurora_latest.json",
} as const;

/** SWPC can update sooner; a personal board does not poll these products faster than this. */
export const SPACE_MIN_POLL_MS = 5 * 60 * 1000;

/** Watches and warnings older than this stay on the panel and off the alerts pane, unless still valid. */
export const SPACE_ALERT_WINDOW_MS = 72 * 60 * 60 * 1000;

const ALERTS_PAGE = "https://www.swpc.noaa.gov/products/alerts-watches-and-warnings";
const SCALES_PAGE = "https://www.swpc.noaa.gov/noaa-scales-explanation";

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export type BandCondition = "quiet" | "fair" | "poor" | "aurora";

export type HamBandRead = {
  band: string;
  condition: BandCondition;
  note: string;
};

export type HamPair = {
  sourceId: string;
  bands: HamBandRead[];
  summary: string;
};

export type BandIndices = {
  g: number;
  r: number;
  s: number;
  known: boolean;
  kp?: number;
  flux?: number;
};

type CacheEntry = { at: number; body: unknown };

const memory = new Map<string, CacheEntry>();

export function clearSpaceWeatherCache(): void {
  memory.clear();
}

export function parseSwpcTime(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let iso = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `2026 Nov 10 1200 UTC` */
export function parseSwpcHumanTime(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2})(\d{2})\s+UTC\b/i);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (month == null) return null;
  const parsed = Date.UTC(
    Number(match[1]),
    month,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  return Number.isNaN(parsed) ? null : parsed;
}

export function toIso(ms: number | null | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** GOES 0.1–0.8 nm flux (W/m²) to the A/B/C/M/X class SWPC publishes. */
export function xrayClass(flux: number): string | null {
  if (!Number.isFinite(flux) || flux <= 0) return null;
  const bands: Array<[string, number]> = [
    ["X", 1e-4],
    ["M", 1e-5],
    ["C", 1e-6],
    ["B", 1e-7],
    ["A", 1e-8],
  ];
  for (const [letter, floor] of bands) {
    if (flux >= floor) return formatClass(letter, flux / floor);
  }
  return formatClass("A", flux / 1e-8);
}

function formatClass(letter: string, magnitude: number): string {
  if (magnitude >= 10) return `${letter}${magnitude.toFixed(0)}`;
  return `${letter}${magnitude.toFixed(1)}`;
}

export function formatIndex(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

export function mapHemisphere(setting: unknown, lat: number): Hemisphere {
  const raw = typeof setting === "string" ? setting.trim().toLowerCase() : "auto";
  if (raw === "north" || raw === "south" || raw === "both") return raw;
  if (lat > 0) return "north";
  if (lat < 0) return "south";
  return "both";
}

export function showAuroraMap(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "false" || text === "0" || text === "no" || text === "off") return false;
  }
  return true;
}

export function spacePollMs(refresh: string | undefined, pollAfterMs: number | undefined): number {
  return Math.max(parseRefreshMs(refresh), pollAfterMs ?? 0, SPACE_MIN_POLL_MS);
}

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return SPACE_MIN_POLL_MS;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return SPACE_MIN_POLL_MS;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return SPACE_MIN_POLL_MS;
  const unit = match[2].toLowerCase();
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return n * 60 * 60_000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function numField(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function latestRow(
  body: unknown,
  accept: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  if (!Array.isArray(body)) return null;
  let best: Record<string, unknown> | null = null;
  let bestMs = -1;
  for (const item of body) {
    if (Array.isArray(item)) {
      continue;
    }
    const row = asRecord(item);
    if (!row || !accept(row)) continue;
    const stamp = textField(row, ["time_tag", "timeTag", "time"]);
    const ms = stamp ? parseSwpcTime(stamp) ?? 0 : 0;
    if (ms >= bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  if (best) return best;
  // Legacy header-plus-rows: ["time_tag","Kp",...], ["2026-...", "1.33", ...]
  let header: string[] | null = null;
  for (const item of body) {
    if (!Array.isArray(item)) continue;
    if (!header) {
      if (item.every((cell) => typeof cell === "string")) header = item.map((cell) => String(cell));
      continue;
    }
    const row: Record<string, unknown> = {};
    header.forEach((key, index) => {
      row[key] = item[index];
    });
    if (!accept(row)) continue;
    const stamp = textField(row, ["time_tag", "timeTag", "time"]);
    const ms = stamp ? parseSwpcTime(stamp) ?? 0 : 0;
    if (ms >= bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  return best;
}

export function parseScales(body: unknown): SpaceScales | null {
  const root = asRecord(body);
  const current = root ? asRecord(root["0"]) : null;
  if (!current) return null;
  const date = textField(current, ["DateStamp", "dateStamp"]);
  const time = textField(current, ["TimeStamp", "timeStamp"]);
  let observedAt: string | undefined;
  if (date && time) observedAt = toIso(parseSwpcTime(`${date} ${time}`));
  else if (date) observedAt = toIso(parseSwpcTime(`${date} 00:00:00`));
  return {
    observedAt,
    radio: readScale(current.R ?? current.r),
    solar: readScale(current.S ?? current.s),
    geomagnetic: readScale(current.G ?? current.g),
  };
}

function readScale(value: unknown): { level: number; text: string } {
  const row = asRecord(value);
  const raw = row ? textField(row, ["Scale", "scale"]) : undefined;
  const level = raw != null && /^\d+$/.test(raw) ? Number(raw) : 0;
  const text = (row ? textField(row, ["Text", "text"]) : undefined) ?? "none";
  return { level: level >= 0 && level <= 5 ? level : 0, text };
}

export function parsePlanetaryKp(body: unknown): { kp: number; time?: string } | null {
  const row = latestRow(body, (candidate) => numField(candidate, ["Kp", "kp"]) != null);
  if (!row) return null;
  const kp = numField(row, ["Kp", "kp"]);
  if (kp == null) return null;
  const stamp = textField(row, ["time_tag", "timeTag", "time"]);
  return { kp, time: stamp ? toIso(parseSwpcTime(stamp)) ?? stamp : undefined };
}

export function parseEstimatedKp(body: unknown): { kp: number; time?: string } | null {
  const row = latestRow(
    body,
    (candidate) => numField(candidate, ["estimated_kp", "estimatedKp"]) != null,
  );
  if (!row) return null;
  const kp = numField(row, ["estimated_kp", "estimatedKp"]);
  if (kp == null) return null;
  const stamp = textField(row, ["time_tag", "timeTag", "time"]);
  return { kp, time: stamp ? toIso(parseSwpcTime(stamp)) ?? stamp : undefined };
}

export function parseSolarFlux(body: unknown): { flux: number; time?: string } | null {
  const row = latestRow(body, (candidate) => numField(candidate, ["flux"]) != null);
  if (!row) return null;
  const flux = numField(row, ["flux"]);
  if (flux == null) return null;
  const stamp = textField(row, ["time_tag", "timeTag", "time"]);
  return { flux, time: stamp ? toIso(parseSwpcTime(stamp)) ?? stamp : undefined };
}

export function parseXray(body: unknown): { flux: number; klass: string; time?: string } | null {
  const row = latestRow(body, (candidate) => {
    const energy = textField(candidate, ["energy"])?.toLowerCase();
    return energy === "0.1-0.8nm" && numField(candidate, ["flux"]) != null;
  });
  if (!row) return null;
  const flux = numField(row, ["flux"]);
  if (flux == null) return null;
  const klass = xrayClass(flux);
  if (!klass) return null;
  const stamp = textField(row, ["time_tag", "timeTag", "time"]);
  return { flux, klass, time: stamp ? toIso(parseSwpcTime(stamp)) ?? stamp : undefined };
}

type OvationGrid = {
  observedAt?: string;
  forecastAt?: string;
  coordinates: Array<[number, number, number]>;
};

export function parseOvation(body: unknown): OvationGrid | null {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.coordinates)) return null;
  const coordinates: Array<[number, number, number]> = [];
  for (const item of root.coordinates) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const lon = Number(item[0]);
    const lat = Number(item[1]);
    const chance = Number(item[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(chance)) continue;
    coordinates.push([lon, lat, chance]);
  }
  if (coordinates.length === 0) return null;
  const observed = textField(root, ["Observation Time", "observationTime"]);
  const forecast = textField(root, ["Forecast Time", "forecastTime"]);
  return {
    observedAt: observed ? toIso(parseSwpcTime(observed)) ?? observed : undefined,
    forecastAt: forecast ? toIso(parseSwpcTime(forecast)) ?? forecast : undefined,
    coordinates,
  };
}

export function nearestAurora(
  coordinates: Array<[number, number, number]>,
  lat: number,
  lon: number,
): number | null {
  let best = Infinity;
  let chance: number | null = null;
  for (const [pointLon, pointLat, value] of coordinates) {
    const dLat = pointLat - lat;
    let dLon = pointLon - lon;
    dLon = ((dLon + 540) % 360) - 180;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < best) {
      best = dist;
      chance = value;
    }
  }
  return chance;
}

export function selectAuroraPoints(
  coordinates: Array<[number, number, number]>,
  hemisphere: Hemisphere,
): AuroraPoint[] {
  for (const threshold of [5, 10, 20]) {
    const points = collectAurora(coordinates, hemisphere, threshold);
    if (points.length <= 6000) return points;
  }
  return collectAurora(coordinates, hemisphere, 20).slice(0, 6000);
}

function collectAurora(
  coordinates: Array<[number, number, number]>,
  hemisphere: Hemisphere,
  threshold: number,
): AuroraPoint[] {
  const points: AuroraPoint[] = [];
  for (const [lon, lat, chance] of coordinates) {
    if (chance < threshold) continue;
    if (hemisphere === "north" && lat < 0) continue;
    if (hemisphere === "south" && lat > 0) continue;
    if (Math.abs(lat) === 90 && lon !== 0) continue;
    if (Math.round(lat) % 2 !== 0 || Math.round(lon) % 2 !== 0) continue;
    points.push({ lon, lat, chance });
  }
  return points;
}

function messageField(message: string, label: string): string | undefined {
  const match = message.match(new RegExp(`^${label}:\\s*(.+)$`, "im"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function messageTitle(message: string): string {
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(Space Weather Message Code|Serial Number|Issue Time):/i.test(trimmed)) continue;
    return trimmed.replace(/\s+/g, " ");
  }
  return "Space weather message";
}

function noaaScale(message: string): number | null {
  const match =
    message.match(/NOAA Scale:\s*[GSR]\s*(\d)/i) ??
    message.match(/Category\s+[GSR]\s*(\d)/i);
  if (!match) return null;
  const level = Number(match[1]);
  return level >= 0 && level <= 5 ? level : null;
}

function kFromCode(code: string): number | null {
  const match = code.match(/^(?:ALTK|WARK)(\d{2})$/i);
  if (!match) return null;
  const k = Number(match[1]);
  return k >= 0 && k <= 9 ? k : null;
}

function messageKind(title: string, code: string): "alert" | "warning" | "watch" | "summary" | "other" {
  const text = title.toLowerCase();
  if (text.includes("watch") || /^WAT/i.test(code)) return "watch";
  if (text.includes("warning") || /^WAR/i.test(code)) return "warning";
  if (text.includes("summary") || /^SUM/i.test(code)) return "summary";
  if (text.includes("alert") || /^ALT/i.test(code)) return "alert";
  return "other";
}

function assessMessage(args: {
  code: string;
  kind: "alert" | "warning" | "watch" | "summary" | "other";
  scale: number | null;
  k: number | null;
}): { severity: IncidentSeverity; notable: boolean } {
  if (/^ALTEF/i.test(args.code) || /^SUM/i.test(args.code) || /^ALTTP/i.test(args.code)) {
    return { severity: "info", notable: false };
  }
  if (args.kind === "summary") return { severity: "info", notable: false };
  const level = args.scale ?? 0;
  const k = args.k ?? 0;
  if (args.kind === "alert" && level < 1 && k < 5) return { severity: "info", notable: false };
  if (level >= 3 || k >= 7) return { severity: "alert", notable: true };
  if (level >= 1 || k >= 5 || args.kind === "watch" || args.kind === "warning") {
    return { severity: "warn", notable: true };
  }
  return { severity: "info", notable: false };
}

function impacts(message: string): string | undefined {
  const index = message.search(/Potential Impacts:/i);
  if (index < 0) return undefined;
  const text = message
    .slice(index)
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

type RawMessage = { productId: string; issued: string; message: string };

function rawMessages(body: unknown): RawMessage[] {
  if (!Array.isArray(body)) return [];
  const out: RawMessage[] = [];
  let legacyHeader = false;
  for (const item of body) {
    const row = asRecord(item);
    if (row) {
      const message = textField(row, ["message"]);
      if (!message) continue;
      out.push({
        productId: textField(row, ["product_id", "productId"]) ?? "",
        issued: textField(row, ["issue_datetime", "issueDatetime"]) ?? "",
        message,
      });
      continue;
    }
    if (!Array.isArray(item) || item.length < 3) continue;
    if (!legacyHeader && item.every((cell) => typeof cell === "string") && !String(item[2]).includes("Space Weather")) {
      legacyHeader = true;
      continue;
    }
    const message = typeof item[2] === "string" ? item[2] : "";
    if (!message.includes("Space Weather") && !message.includes("Message Code")) continue;
    out.push({
      productId: String(item[0] ?? ""),
      issued: String(item[1] ?? ""),
      message,
    });
  }
  return out;
}

export function parseAlerts(body: unknown): SpaceAlert[] {
  const parsed: SpaceAlert[] = [];
  for (const raw of rawMessages(body)) {
    const code =
      (messageField(raw.message, "Space Weather Message Code") ?? raw.productId) || "SWPC";
    const serial = messageField(raw.message, "Serial Number");
    const title = messageTitle(raw.message);
    const kind = messageKind(title, code);
    const scale = noaaScale(raw.message);
    const k = kFromCode(code);
    const assessed = assessMessage({ code, kind, scale, k });
    const issuedMs = parseSwpcTime(raw.issued);
    const untilRaw =
      messageField(raw.message, "Now Valid Until") ?? messageField(raw.message, "Valid To");
    const untilMs = untilRaw ? parseSwpcHumanTime(untilRaw) : null;
    const summary =
      impacts(raw.message) ??
      (scale != null ? `NOAA scale ${scale}` : undefined) ??
      (k != null ? `K-index ${k}` : undefined);
    const bodyText = raw.message.replace(/\r\n/g, "\n").trim().slice(0, 2500);
    parsed.push({
      id: `${code}-${serial || raw.issued || raw.productId || title}`,
      code,
      title,
      summary,
      body: bodyText || undefined,
      issuedAt: toIso(issuedMs),
      validUntil: toIso(untilMs),
      severity: assessed.severity,
      notable: assessed.notable,
      detailUrl: ALERTS_PAGE,
    });
  }
  parsed.sort((a, b) => (Date.parse(b.issuedAt ?? "") || 0) - (Date.parse(a.issuedAt ?? "") || 0));
  const seen = new Set<string>();
  const unique: SpaceAlert[] = [];
  for (const alert of parsed) {
    if (seen.has(alert.code)) continue;
    seen.add(alert.code);
    unique.push(alert);
  }
  return unique;
}

export function scaleAlerts(scales: SpaceScales): SpaceAlert[] {
  const rows: Array<["G" | "S" | "R", string, { level: number; text: string }]> = [
    ["G", "Geomagnetic storm", scales.geomagnetic],
    ["S", "Solar radiation storm", scales.solar],
    ["R", "Radio blackout", scales.radio],
  ];
  return rows
    .filter(([, , scale]) => scale.level >= 1)
    .map(([letter, name, scale]) => ({
      id: `scale-${letter}`,
      code: `${letter}${scale.level}`,
      title: `${name} ${letter}${scale.level} — ${scale.text}`,
      summary: "Current NOAA scale",
      issuedAt: scales.observedAt,
      severity: (scale.level >= 3 ? "alert" : "warn") as IncidentSeverity,
      notable: true,
      detailUrl: SCALES_PAGE,
    }));
}

export function spaceAlertIsCurrent(alert: SpaceAlert, now = Date.now()): boolean {
  if (alert.id.startsWith("scale-")) return true;
  if (alert.validUntil) {
    const until = Date.parse(alert.validUntil);
    if (!Number.isNaN(until) && until >= now) return true;
  }
  if (!alert.issuedAt) return false;
  const issued = Date.parse(alert.issuedAt);
  if (Number.isNaN(issued)) return false;
  const age = now - issued;
  return age <= SPACE_ALERT_WINDOW_MS && age >= -5 * 60_000;
}

export function spaceAlertsForBoard(alerts: SpaceAlert[], now = Date.now()): SpaceAlert[] {
  return alerts.filter((alert) => alert.notable && spaceAlertIsCurrent(alert, now));
}

export function parseHamBands(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const seen = new Set<string>();
  const bands: string[] = [];
  for (const part of value.split(/[,;/]+|\s+/)) {
    const band = part.trim();
    if (!band) continue;
    const key = band.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bands.push(band);
  }
  return bands;
}

function bandMeters(band: string): number | null {
  const match = band.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(cm|m)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (match[2] === "cm") return n / 100;
  return n;
}

type BandGroup = "hf-low" | "hf-high" | "vhf" | "other";

function bandGroup(band: string): BandGroup {
  const meters = bandMeters(band);
  if (meters == null) return "other";
  if (meters >= 40 && meters <= 160) return "hf-low";
  if (meters >= 10 && meters < 40) return "hf-high";
  if (meters >= 1 && meters <= 6) return "vhf";
  return "other";
}

function worse(a: BandCondition, b: BandCondition): BandCondition {
  const rank: Record<BandCondition, number> = { quiet: 0, aurora: 1, fair: 2, poor: 3 };
  return rank[a] >= rank[b] ? a : b;
}

export function readBand(band: string, indices: BandIndices): HamBandRead {
  if (!indices.known) {
    return { band, condition: "quiet", note: "NOAA scales were not available." };
  }
  const group = bandGroup(band);
  if (group === "other") {
    return {
      band,
      condition: "quiet",
      note: "Outside the HF and aurora bands this pairing reads.",
    };
  }
  if (group === "vhf") {
    if (indices.g >= 4) return { band, condition: "aurora", note: `G${indices.g} — aurora likely.` };
    if (indices.g >= 2) return { band, condition: "aurora", note: `G${indices.g} — aurora possible.` };
    if (indices.g === 1) {
      return { band, condition: "aurora", note: "G1 — aurora possible at high latitude." };
    }
    return { band, condition: "quiet", note: "No geomagnetic storm on the G scale." };
  }

  const notes: string[] = [];
  let condition: BandCondition = "quiet";
  if (indices.r >= 3) {
    condition = "poor";
    notes.push(`R${indices.r} wide HF blackout on the sunlit side.`);
  } else if (indices.r === 2) {
    condition = group === "hf-low" ? "poor" : "fair";
    notes.push("R2 limited HF blackout on the sunlit side.");
  } else if (indices.r === 1) {
    condition = "fair";
    notes.push("R1 minor HF fade on the sunlit side.");
  }

  if (indices.g >= 4) {
    condition = "poor";
    notes.push(`G${indices.g} severe geomagnetic storm.`);
  } else if (indices.g >= 3) {
    condition = worse(condition, group === "hf-low" ? "poor" : "fair");
    notes.push(`G${indices.g} HF fade at higher latitudes.`);
  } else if (indices.g >= 2) {
    condition = worse(condition, "fair");
    notes.push(`G${indices.g} HF can fade at higher latitudes.`);
  } else if (indices.g === 1 && group === "hf-low") {
    condition = worse(condition, "fair");
    notes.push("G1 minor effects, mainly poleward of 60°.");
  }

  if (notes.length === 0) notes.push("No storm degradation on the current NOAA scales.");
  return { band, condition, note: notes.join(" ") };
}

export function pairSummary(bands: HamBandRead[], indices: BandIndices): string {
  if (!indices.known) return "NOAA scales were not available. Bands are not marked.";
  const parts = [`G${indices.g}`, `R${indices.r}`, `S${indices.s}`];
  if (indices.kp != null) parts.push(`Kp ${formatIndex(indices.kp)}`);
  if (indices.flux != null) parts.push(`${Math.round(indices.flux)} sfu`);
  let storm = "No storm degradation.";
  if (bands.some((band) => band.condition === "poor")) storm = "Some paired bands are poor.";
  else if (bands.some((band) => band.condition === "fair" || band.condition === "aurora")) {
    storm = "Some paired bands are unsettled.";
  }
  const polar = indices.s >= 2 ? ` S${indices.s} degrades polar paths.` : "";
  return `${parts.join(" · ")}. ${storm}${polar}`;
}

export function spaceIndices(space: SpacePayload | undefined): BandIndices {
  if (!space?.scales) return { g: 0, r: 0, s: 0, known: false, kp: space?.kp, flux: space?.solarFlux };
  return {
    g: space.scales.geomagnetic.level,
    r: space.scales.radio.level,
    s: space.scales.solar.level,
    known: true,
    kp: space.kp,
    flux: space.solarFlux,
  };
}

export function listHamPairs(
  sources: Record<string, Pick<SourceConfig, "type" | "params" | "enabled" | "draft"> | undefined>,
  indices: BandIndices,
): HamPair[] {
  const pairs: HamPair[] = [];
  for (const [sourceId, source] of Object.entries(sources)) {
    if (!source || source.type !== HAM_SOLAR_TYPE) continue;
    if (source.enabled === false || source.draft) continue;
    const names = parseHamBands(source.params?.bands);
    const bands = names.map((band) => readBand(band, indices));
    pairs.push({ sourceId, bands, summary: pairSummary(bands, indices) });
  }
  return pairs;
}

export function buildSpaceSnapshot(args: {
  lat: number;
  lon: number;
  hemisphere: Hemisphere;
  showAurora: boolean;
  alerts?: unknown;
  scales?: unknown;
  kp?: unknown;
  kpNow?: unknown;
  flux?: unknown;
  xray?: unknown;
  ovation?: unknown;
  pollAfterMs?: number;
}): { space: SpacePayload; note: string } {
  const scales = args.scales == null ? null : parseScales(args.scales);
  const planetary = args.kp == null ? null : parsePlanetaryKp(args.kp);
  const estimated = args.kpNow == null ? null : parseEstimatedKp(args.kpNow);
  const flux = args.flux == null ? null : parseSolarFlux(args.flux);
  const xray = args.xray == null ? null : parseXray(args.xray);
  const ovation = args.ovation == null ? null : parseOvation(args.ovation);
  const messages = args.alerts == null ? [] : parseAlerts(args.alerts);
  const alerts = [...(scales ? scaleAlerts(scales) : []), ...messages];
  const chance = ovation ? nearestAurora(ovation.coordinates, args.lat, args.lon) : null;
  const gaps: string[] = [];
  if (args.alerts == null) gaps.push("alerts");
  if (!scales) gaps.push("scales");
  if (!planetary && !estimated) gaps.push("Kp");
  if (!flux) gaps.push("10.7 cm flux");
  if (!xray) gaps.push("X-ray");
  if (!ovation) gaps.push("aurora forecast");
  const note = gaps.length
    ? `Some NOAA SWPC products did not load: ${gaps.join(", ")}. Polled no faster than every 5 minutes.`
    : "Polled no faster than every 5 minutes. Aurora chance is the nearest OVATION grid point.";
  return {
    note,
    space: {
      lat: args.lat,
      lon: args.lon,
      hemisphere: args.hemisphere,
      kp: planetary?.kp,
      kpTime: planetary?.time,
      estimatedKp: estimated?.kp,
      estimatedKpTime: estimated?.time,
      solarFlux: flux?.flux,
      solarFluxTime: flux?.time,
      xrayClass: xray?.klass,
      xrayTime: xray?.time,
      auroraChance: chance ?? undefined,
      auroraObservedAt: ovation?.observedAt,
      auroraForecastAt: ovation?.forecastAt,
      auroraPoints: ovation && args.showAurora ? selectAuroraPoints(ovation.coordinates, args.hemisphere) : [],
      scales: scales ?? undefined,
      alerts,
      pollAfterMs: Math.max(SPACE_MIN_POLL_MS, args.pollAfterMs ?? SPACE_MIN_POLL_MS),
    },
  };
}

/** Same place rules as `readCoords`: direct lat/lon, or a confirmed location object. */
function coordsFromParams(params: Record<string, unknown>): { lat: number; lon: number } | null {
  const directLat = finiteNumber(params.lat);
  const directLon = finiteNumber(params.lon);
  if (directLat != null && directLon != null && inRange(directLat, directLon)) {
    return { lat: directLat, lon: directLon };
  }
  const raw = params.location;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const loc = raw as Record<string, unknown>;
  if (loc.confirmed !== true) return null;
  const lat = finiteNumber(loc.lat);
  const lon = finiteNumber(loc.lon);
  if (lat == null || lon == null || !inRange(lat, lon)) return null;
  return { lat, lon };
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function inRange(lat: number, lon: number): boolean {
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

async function swpcJson(path: string): Promise<unknown> {
  const hit = memory.get(path);
  if (hit && Date.now() - hit.at < SPACE_MIN_POLL_MS) return hit.body;
  const response = await fetch(`/proxy/swpc${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    if (hit) return hit.body;
    throw new Error(`NOAA SWPC returned HTTP ${response.status} for ${path}`);
  }
  const body: unknown = await response.json();
  memory.set(path, { at: Date.now(), body });
  return body;
}

async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await swpcJson(path);
  } catch {
    return undefined;
  }
}

function cachePollRemaining(): number {
  let oldest = Date.now();
  let any = false;
  for (const entry of memory.values()) {
    any = true;
    oldest = Math.min(oldest, entry.at);
  }
  if (!any) return SPACE_MIN_POLL_MS;
  return Math.max(1000, SPACE_MIN_POLL_MS - (Date.now() - oldest));
}

export async function fetchSpaceInBrowser(
  sourceId: string,
  source: SourceConfig,
): Promise<SourcePayload> {
  const coords = coordsFromParams(source.params);
  if (!coords) throw new Error("latitude and longitude are required");
  const hemisphere = mapHemisphere(source.params.hemisphere, coords.lat);
  const showAurora = showAuroraMap(source.params.showAurora);
  const [alerts, scales, kp, kpNow, flux, xray, ovation] = await Promise.all([
    optionalJson(SWPC_PATHS.alerts),
    optionalJson(SWPC_PATHS.scales),
    optionalJson(SWPC_PATHS.kp),
    optionalJson(SWPC_PATHS.kpNow),
    optionalJson(SWPC_PATHS.flux),
    optionalJson(SWPC_PATHS.xray),
    optionalJson(SWPC_PATHS.ovation),
  ]);
  if (
    alerts == null &&
    scales == null &&
    kp == null &&
    kpNow == null &&
    flux == null &&
    xray == null &&
    ovation == null
  ) {
    throw new Error("Couldn't reach NOAA SWPC.");
  }
  const built = buildSpaceSnapshot({
    lat: coords.lat,
    lon: coords.lon,
    hemisphere,
    showAurora,
    alerts,
    scales,
    kp,
    kpNow,
    flux,
    xray,
    ovation,
    pollAfterMs: cachePollRemaining(),
  });
  return {
    sourceId,
    typeId: source.type,
    fetchedAt: new Date().toISOString(),
    attribution:
      "NOAA SWPC · alerts, scales, Kp, 10.7 cm flux, GOES X-ray, OVATION aurora",
    note: built.note,
    incidents: [],
    space: built.space,
  };
}
