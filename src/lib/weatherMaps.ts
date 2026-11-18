/** Map scales the weather panel can show. Order is the rotation order. */
export const WEATHER_MAPS = [
  { id: "local", label: "Local" },
  { id: "regional", label: "Regional" },
  { id: "nationwide", label: "Nationwide" },
] as const;

export type WeatherMapId = (typeof WEATHER_MAPS)[number]["id"];

const ORDER: WeatherMapId[] = ["local", "regional", "nationwide"];

export function readWeatherMaps(params: Record<string, unknown>): WeatherMapId[] {
  const raw = params.scopes;
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) parts.push(String(item));
  } else if (typeof raw === "string") {
    parts.push(...raw.split(/[,+| ]+/));
  }
  const chosen = new Set(parts.map((part) => part.trim().toLowerCase()));
  return ORDER.filter((id) => chosen.has(id));
}

/** How many chosen maps are on screen. Older sources omit this and show every chosen map. */
export function readMapCount(params: Record<string, unknown>, maps: readonly string[]): number {
  const available = Math.max(1, maps.length);
  const raw = params.mapCount;
  if (raw === undefined || raw === null || raw === "") return Math.min(available, maps.length || 1);
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.min(available, maps.length || 1);
  return Math.min(available, Math.max(1, Math.round(n)));
}

export function readRotateMaps(params: Record<string, unknown>): boolean {
  return params.rotateMaps === true;
}

export function readMapRotateSec(params: Record<string, unknown>): number {
  const n = Number(params.mapRotateSec);
  if (!Number.isFinite(n)) return 30;
  return Math.min(3600, Math.max(5, Math.round(n)));
}

/** Maps visible at `index`. Rotation advances one step through the chosen maps. */
export function visibleWeatherMaps(params: Record<string, unknown>, index: number): WeatherMapId[] {
  const maps = readWeatherMaps(params);
  if (maps.length === 0) return [];
  const count = readMapCount(params, maps);
  if (!readRotateMaps(params) || maps.length <= count) return maps.slice(0, count);
  const start = ((index % maps.length) + maps.length) % maps.length;
  return Array.from({ length: count }, (_, step) => maps[(start + step) % maps.length]);
}

export function weatherMapsSaveError(params: Record<string, unknown>): string | null {
  if (readWeatherMaps(params).length === 0) {
    return "Choose at least one weather map.";
  }
  return null;
}
