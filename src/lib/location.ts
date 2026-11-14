import type { AdapterField } from "../types";

export type LocationProvider = "gps" | "network" | "device" | "address";

export type ConfirmedLocation = {
  lat: number;
  lon: number;
  label: string;
  source: LocationProvider | "saved";
  accuracyM: number | null;
  query: string;
};

export type LocationFormState = {
  provider: LocationProvider | null;
  query: string;
  confirmed: ConfirmedLocation | null;
};

export type ResolvedLocation = {
  lat: number;
  lon: number;
  label: string;
  source: LocationProvider;
  accuracyM: number | null;
  confirmed: true;
};

const PROVIDERS: LocationProvider[] = ["gps", "network", "device", "address"];

type LocationObject = Record<string, unknown>;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export function latLonKeys(field: Pick<AdapterField, "latKey" | "lonKey">): {
  latKey: string;
  lonKey: string;
} {
  return {
    latKey: field.latKey ?? "lat",
    lonKey: field.lonKey ?? "lon",
  };
}

export function isLocationProvider(value: unknown): value is LocationProvider {
  return typeof value === "string" && (PROVIDERS as string[]).includes(value);
}

function asFinite(value: unknown): number | null {
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

function locationObject(value: unknown): LocationObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LocationObject;
}

export function readLocationState(
  params: Record<string, unknown>,
  field: Pick<AdapterField, "key" | "latKey" | "lonKey">,
): LocationFormState {
  const { latKey, lonKey } = latLonKeys(field);
  const raw = locationObject(params[field.key]);
  if (raw) {
    const provider = isLocationProvider(raw.provider) ? raw.provider : null;
    const query = typeof raw.query === "string" ? raw.query : "";
    const lat = asFinite(raw.lat);
    const lon = asFinite(raw.lon);
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const accuracyM = asFinite(raw.accuracyM);
    const source: ConfirmedLocation["source"] = provider ?? "saved";
    const confirmed =
      raw.confirmed === true && lat != null && lon != null && inRange(lat, lon)
        ? {
            lat,
            lon,
            label: label || formatCoords(lat, lon),
            source,
            accuracyM,
            query,
          }
        : null;
    return { provider, query, confirmed };
  }

  const lat = asFinite(params[latKey]);
  const lon = asFinite(params[lonKey]);
  if (lat != null && lon != null && inRange(lat, lon)) {
    return {
      provider: null,
      query: "",
      confirmed: {
        lat,
        lon,
        label: formatCoords(lat, lon),
        source: "saved",
        accuracyM: null,
        query: "",
      },
    };
  }
  return { provider: null, query: "", confirmed: null };
}

/** Radio selection. A brand-new source starts on GPS. A saved lat/lon with no provider stays unselected. */
export function selectedProvider(state: LocationFormState): LocationProvider | null {
  if (state.provider) return state.provider;
  if (state.confirmed?.source === "saved") return null;
  return "gps";
}

export function readCoords(
  params: Record<string, unknown>,
  latKey = "lat",
  lonKey = "lon",
): { lat: number; lon: number } | null {
  const lat = asFinite(params[latKey]);
  const lon = asFinite(params[lonKey]);
  if (lat != null && lon != null && inRange(lat, lon)) return { lat, lon };
  const raw = locationObject(params.location);
  if (!raw || raw.confirmed !== true) return null;
  const nestedLat = asFinite(raw.lat);
  const nestedLon = asFinite(raw.lon);
  if (nestedLat == null || nestedLon == null || !inRange(nestedLat, nestedLon)) return null;
  return { lat: nestedLat, lon: nestedLon };
}

export function confirmedPlaceLabel(params: Record<string, unknown>, key = "location"): string | null {
  const raw = locationObject(params[key]);
  if (!raw || raw.confirmed !== true) return null;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  return label || null;
}

export function isMissingParam(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (typeof value === "number") return !Number.isFinite(value);
  const raw = locationObject(value);
  if (!raw || !("confirmed" in raw)) return false;
  if (raw.confirmed !== true) return true;
  const lat = asFinite(raw.lat);
  const lon = asFinite(raw.lon);
  return lat == null || lon == null || !inRange(lat, lon);
}

export function locationSaveError(
  fields: AdapterField[],
  params: Record<string, unknown>,
): string | null {
  for (const field of fields) {
    if (field.kind !== "location" || !field.required) continue;
    const state = readLocationState(params, field);
    if (!state.confirmed) {
      return "Find a location first. Use GPS, network location, another source on this device, or an address. Command Center has to confirm the place before this source can be saved.";
    }
  }
  return null;
}

/** Copy a legacy lat/lon pair into the location object so save can record that it was confirmed. */
export function ensureLocationParams(
  fields: AdapterField[],
  params: Record<string, unknown>,
): Record<string, unknown> {
  let next = params;
  for (const field of fields) {
    if (field.kind !== "location") continue;
    const state = readLocationState(next, field);
    if (!state.confirmed || locationObject(next[field.key])?.confirmed === true) continue;
    next = withConfirmed(
      next,
      field,
      {
        lat: state.confirmed.lat,
        lon: state.confirmed.lon,
        label: state.confirmed.label,
        source: "address",
        accuracyM: null,
        confirmed: true,
      },
      state.confirmed.query,
    );
    const raw = locationObject(next[field.key]);
    if (raw && state.confirmed.source === "saved") {
      next = {
        ...next,
        [field.key]: { ...raw, provider: "saved" },
      };
    }
  }
  return next;
}

export function withProvider(
  params: Record<string, unknown>,
  field: Pick<AdapterField, "key" | "latKey" | "lonKey">,
  provider: LocationProvider,
): Record<string, unknown> {
  const prev = readLocationState(params, field);
  const { latKey, lonKey } = latLonKeys(field);
  const next = { ...params };
  delete next[latKey];
  delete next[lonKey];
  next[field.key] = {
    provider,
    query: provider === "address" ? prev.query : "",
    confirmed: false,
  };
  return next;
}

export function withQuery(
  params: Record<string, unknown>,
  field: Pick<AdapterField, "key" | "latKey" | "lonKey">,
  query: string,
): Record<string, unknown> {
  const prev = readLocationState(params, field);
  const { latKey, lonKey } = latLonKeys(field);
  const same =
    prev.confirmed?.source === "address" && prev.confirmed.query === query && query.trim() !== "";
  const next = { ...params };
  if (same && prev.confirmed) {
    next[latKey] = prev.confirmed.lat;
    next[lonKey] = prev.confirmed.lon;
    next[field.key] = {
      provider: "address",
      query,
      label: prev.confirmed.label,
      lat: prev.confirmed.lat,
      lon: prev.confirmed.lon,
      accuracyM: prev.confirmed.accuracyM,
      confirmed: true,
    };
    return next;
  }
  delete next[latKey];
  delete next[lonKey];
  next[field.key] = { provider: "address", query, confirmed: false };
  return next;
}

export function withConfirmed(
  params: Record<string, unknown>,
  field: Pick<AdapterField, "key" | "latKey" | "lonKey">,
  loc: ResolvedLocation,
  query: string,
): Record<string, unknown> {
  const { latKey, lonKey } = latLonKeys(field);
  return {
    ...params,
    [field.key]: {
      provider: loc.source,
      query: loc.source === "address" ? query : "",
      label: loc.label,
      lat: loc.lat,
      lon: loc.lon,
      accuracyM: loc.accuracyM,
      confirmed: true,
    },
    [latKey]: loc.lat,
    [lonKey]: loc.lon,
  };
}

export function clearConfirmation(
  params: Record<string, unknown>,
  field: Pick<AdapterField, "key" | "latKey" | "lonKey">,
  provider: LocationProvider,
  query: string,
): Record<string, unknown> {
  const { latKey, lonKey } = latLonKeys(field);
  const next = { ...params };
  delete next[latKey];
  delete next[lonKey];
  next[field.key] = {
    provider,
    query: provider === "address" ? query : "",
    confirmed: false,
  };
  return next;
}

export function sourcePhrase(source: ConfirmedLocation["source"], accuracyM: number | null): string {
  const base =
    source === "gps"
      ? "From GPS"
      : source === "network"
        ? "From network location"
        : source === "device"
          ? "From another location service on this device"
          : source === "address"
            ? "From the address you typed"
            : "Already saved on this source";
  const accuracy = formatAccuracy(accuracyM);
  return accuracy ? `${base} · ${accuracy}` : base;
}

export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

export function formatAccuracy(meters: number | null): string | null {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return null;
  if (meters >= 1000) return `about ${Math.round(meters / 1000)} km`;
  return `about ${Math.round(meters)} m`;
}

const OBJECT_TEXT = "[object Object]";

function usefulText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === OBJECT_TEXT) return null;
  return text;
}

/**
 * Text from a thrown value. Tauri command errors arrive as `{ message }`
 * objects, and `String(that)` is `[object Object]`.
 */
export function describeError(err: unknown, fallback: string): string {
  return readFailure(err, new Set()) ?? fallback;
}

export function locationFailure(err: unknown): string {
  return describeError(err, "Command Center could not confirm a location.");
}

function readFailure(err: unknown, seen: Set<unknown>): string | null {
  const direct = usefulText(err);
  if (direct) {
    if (direct.startsWith("{") || direct.startsWith("[")) {
      try {
        const nested = readFailure(JSON.parse(direct) as unknown, seen);
        if (nested) return nested;
      } catch {
        /* The string itself is the message. */
      }
    }
    return direct;
  }
  if (!err || typeof err !== "object") return null;
  if (seen.has(err)) return null;
  seen.add(err);
  const record = err as Record<string, unknown>;
  if (err instanceof Error) {
    const fromMessage = readFailure(err.message, seen);
    if (fromMessage) return fromMessage;
  }
  for (const key of ["message", "error", "reason", "detail", "description"]) {
    if (!(key in record)) continue;
    const nested = readFailure(record[key], seen);
    if (nested) return nested;
  }
  return null;
}

export async function findLocations(input: {
  provider: LocationProvider;
  address?: string;
}): Promise<ResolvedLocation[]> {
  if (input.provider === "address") {
    const address = input.address?.trim() ?? "";
    if (!address) throw new Error("Type an address first.");
    if (isTauri()) return tauriLookup(input.provider, address);
    return lookupAddress(address);
  }
  if (input.provider === "gps") {
    try {
      return [await gpsPosition()];
    } catch (err) {
      if (!isTauri()) throw err;
      try {
        return await tauriLookup("gps");
      } catch {
        throw err;
      }
    }
  }
  if (input.provider === "network") {
    try {
      return [await networkPosition()];
    } catch {
      if (isTauri()) {
        try {
          return await tauriLookup("network");
        } catch {
          /* Browser IP lookup is the same network source. */
        }
      }
      return [await lookupIp()];
    }
  }
  if (isTauri()) {
    try {
      return await tauriLookup("device");
    } catch {
      /* Fall through to the browser location service. */
    }
  }
  return [await devicePosition()];
}

async function tauriLookup(provider: LocationProvider, address?: string): Promise<ResolvedLocation[]> {
  let result: { matches?: ResolvedLocation[] };
  try {
    result = await invoke<{ matches?: ResolvedLocation[] }>("resolve_location", {
      request: { provider, address: address ?? null },
    });
  } catch (err) {
    throw new Error(locationFailure(err));
  }
  const matches = (result.matches ?? [])
    .map(normalizeResolved)
    .filter((item): item is ResolvedLocation => item != null);
  if (!matches.length) {
    throw new Error("Command Center could not confirm a location.");
  }
  return matches;
}

function normalizeResolved(value: ResolvedLocation | undefined): ResolvedLocation | null {
  if (!value) return null;
  const lat = asFinite(value.lat);
  const lon = asFinite(value.lon);
  if (lat == null || lon == null || !inRange(lat, lon)) return null;
  if (!isLocationProvider(value.source)) return null;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  return {
    lat,
    lon,
    label: label || formatCoords(lat, lon),
    source: value.source,
    accuracyM: asFinite(value.accuracyM),
    confirmed: true,
  };
}

function getPosition(enableHighAccuracy: boolean, timeout: number, maximumAge: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device has no location service."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        if (err.code === 1) reject(new Error("Location permission was denied on this device."));
        else if (enableHighAccuracy) {
          reject(new Error("No GPS fix. This device did not report a satellite position."));
        } else if (err.code === 3) reject(new Error("The location request timed out."));
        else reject(new Error("This device could not determine a position."));
      },
      { enableHighAccuracy, timeout, maximumAge },
    );
  });
}

async function gpsPosition(): Promise<ResolvedLocation> {
  const pos = await getPosition(true, 10_000, 0);
  const accuracy = pos.coords.accuracy;
  if (Number.isFinite(accuracy) && accuracy > 1000) {
    throw new Error(
      `No GPS fix. The only reading was ${formatAccuracy(accuracy)}, which is too coarse for GPS.`,
    );
  }
  return withPlaceLabel(
    pos.coords.latitude,
    pos.coords.longitude,
    "gps",
    Number.isFinite(accuracy) ? accuracy : null,
  );
}

async function networkPosition(): Promise<ResolvedLocation> {
  const pos = await getPosition(false, 8_000, 60_000);
  const accuracy = pos.coords.accuracy;
  return withPlaceLabel(
    pos.coords.latitude,
    pos.coords.longitude,
    "network",
    Number.isFinite(accuracy) ? accuracy : null,
  );
}

async function devicePosition(): Promise<ResolvedLocation> {
  try {
    const pos = await getPosition(false, 8_000, 0);
    const accuracy = pos.coords.accuracy;
    return await withPlaceLabel(
      pos.coords.latitude,
      pos.coords.longitude,
      "device",
      Number.isFinite(accuracy) ? accuracy : null,
    );
  } catch {
    throw new Error("No other location service on this device responded.");
  }
}

async function withPlaceLabel(
  lat: number,
  lon: number,
  source: LocationProvider,
  accuracyM: number | null,
): Promise<ResolvedLocation> {
  if (!inRange(lat, lon)) {
    throw new Error("The lookup returned coordinates that are not a real location.");
  }
  let label = formatCoords(lat, lon);
  try {
    const named = await reverseLabel(lat, lon);
    if (named) label = named;
  } catch {
    /* Coordinates alone are enough to confirm the fix. */
  }
  return { lat, lon, label, source, accuracyM, confirmed: true };
}

async function lookupIp(): Promise<ResolvedLocation> {
  const body = await fetchJson("/proxy/ipwho/");
  const parsed = parseIpwho(body);
  if (!parsed) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : "No network location. The IP lookup did not return a place.";
    throw new Error(message.startsWith("No network") ? message : `No network location. ${message}`);
  }
  return parsed;
}

async function lookupAddress(address: string): Promise<ResolvedLocation[]> {
  const attempts: Array<() => Promise<ResolvedLocation[]>> = [
    async () => parsePhoton(await fetchJson(`/proxy/photon/api/?q=${encodeURIComponent(address)}&limit=5`)),
    async () =>
      parseNominatim(
        await fetchJson(
          `/proxy/nominatim/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=5&addressdetails=1`,
        ),
      ),
    async () =>
      parseOpenMeteo(
        await fetchJson(
          `/proxy/geocode/v1/search?name=${encodeURIComponent(address)}&count=5&language=en&format=json`,
        ),
      ),
  ];
  let sawEmpty = false;
  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      const matches = await attempt();
      if (matches.length) return matches;
      sawEmpty = true;
    } catch (err) {
      const text = describeError(err, "");
      lastError = text || null;
    }
  }
  if (sawEmpty || !lastError) {
    throw new Error("No place matched that address. Try a street, city, and region.");
  }
  throw new Error(lastError);
}

async function reverseLabel(lat: number, lon: number): Promise<string | null> {
  const matches = parsePhoton(await fetchJson(`/proxy/photon/reverse?lat=${lat}&lon=${lon}`));
  return matches[0]?.label ?? null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`lookup failed (HTTP ${response.status}).`);
  }
  return response.json() as Promise<unknown>;
}

function textProp(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function joinPlace(parts: Array<string | null>): string {
  const out: string[] = [];
  for (const part of parts) {
    const text = part?.trim() ?? "";
    if (!text) continue;
    if (out.length && out[out.length - 1].toLowerCase() === text.toLowerCase()) continue;
    out.push(text);
  }
  return out.join(", ");
}

export function parsePhoton(body: unknown): ResolvedLocation[] {
  if (!body || typeof body !== "object") return [];
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const matches: ResolvedLocation[] = [];
  for (const feature of features) {
    if (!feature || typeof feature !== "object") continue;
    const geometry = (feature as { geometry?: { coordinates?: unknown } }).geometry;
    const coords = geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = asFinite(coords[0]);
    const lat = asFinite(coords[1]);
    if (lat == null || lon == null || !inRange(lat, lon)) continue;
    const props = (feature as { properties?: unknown }).properties;
    const number = textProp(props, "housenumber");
    const street = textProp(props, "street");
    let streetLine = "";
    if (number && street) {
      streetLine = street.toLowerCase().includes(number.toLowerCase()) ? street : `${number} ${street}`;
    } else {
      streetLine = street || number || "";
    }
    const label =
      joinPlace([
        textProp(props, "name"),
        streetLine || null,
        textProp(props, "city") ?? textProp(props, "district"),
        textProp(props, "state"),
        textProp(props, "country"),
      ]) || formatCoords(lat, lon);
    matches.push({ lat, lon, label, source: "address", accuracyM: null, confirmed: true });
  }
  return matches;
}

export function parseNominatim(body: unknown): ResolvedLocation[] {
  if (!Array.isArray(body)) return [];
  const matches: ResolvedLocation[] = [];
  for (const row of body) {
    const lat = asFinite(textProp(row, "lat"));
    const lon = asFinite(textProp(row, "lon"));
    if (lat == null || lon == null || !inRange(lat, lon)) continue;
    const label = textProp(row, "display_name") || formatCoords(lat, lon);
    matches.push({ lat, lon, label, source: "address", accuracyM: null, confirmed: true });
  }
  return matches;
}

export function parseOpenMeteo(body: unknown): ResolvedLocation[] {
  if (!body || typeof body !== "object") return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const matches: ResolvedLocation[] = [];
  for (const row of results) {
    const lat = asFinite(textProp(row, "latitude") ?? (row as { latitude?: unknown }).latitude);
    const lon = asFinite(textProp(row, "longitude") ?? (row as { longitude?: unknown }).longitude);
    if (lat == null || lon == null || !inRange(lat, lon)) continue;
    const label =
      joinPlace([textProp(row, "name"), textProp(row, "admin1"), textProp(row, "country")]) ||
      formatCoords(lat, lon);
    matches.push({ lat, lon, label, source: "address", accuracyM: null, confirmed: true });
  }
  return matches;
}

export function parseIpwho(body: unknown): ResolvedLocation | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (row.success === false) return null;
  const lat = asFinite(row.latitude);
  const lon = asFinite(row.longitude);
  if (lat == null || lon == null || !inRange(lat, lon)) return null;
  const label =
    joinPlace([textProp(row, "city"), textProp(row, "region"), textProp(row, "country")]) ||
    formatCoords(lat, lon);
  return { lat, lon, label, source: "network", accuracyM: null, confirmed: true };
}
