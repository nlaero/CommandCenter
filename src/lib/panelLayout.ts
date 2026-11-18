import { isPennHillsPreset, PENN_HILLS_FEED } from "./broadcastifyPreset";
import { confirmedPlaceLabel } from "./location";
import type { AdapterDefinition, Panel } from "../types";

export function panelTitleFor(
  adapter: AdapterDefinition,
  params: Record<string, unknown>,
): string {
  if (adapter.typeId === "broadcastify.owner" && isPennHillsPreset(params)) {
    return PENN_HILLS_FEED.name;
  }
  const label = typeof params.label === "string" ? params.label.trim() : "";
  if (
    label &&
    (adapter.typeId === "broadcastify.calls" ||
      adapter.typeId === "camera.http_image" ||
      adapter.typeId === "camera.public" ||
      adapter.typeId === "camera.private" ||
      adapter.typeId === "video.youtube" ||
      adapter.typeId === "scanner.web" ||
      adapter.typeId === "x.follow" ||
      adapter.typeId === "audio.local" ||
      adapter.typeId === "agency.rss" ||
      adapter.typeId === "alarms.home")
  ) {
    return label;
  }
  if (adapter.typeId === "x.follow") return "X";
  if (adapter.typeId === "news.rss") {
    const place = confirmedPlaceLabel(params);
    const city = place?.split(",")[0]?.trim() ?? "";
    if (city && !/^-?\d/.test(city)) return `News · ${city}`;
  }
  if (
    adapter.typeId === "rivers.nwps" ||
    adapter.typeId === "storms.spc" ||
    adapter.typeId === "lightning.glm" ||
    adapter.typeId === "traffic.roads" ||
    adapter.typeId === "camera.penndot"
  ) {
    const place = confirmedPlaceLabel(params);
    const city = place?.split(",")[0]?.trim() ?? "";
    if (city && !/^-?\d/.test(city)) return `${adapter.name} · ${city}`;
  }
  return adapter.name;
}

export function panelLayoutFor(
  typeId: string,
  panelId: string,
  yMax: number,
): Panel["layout"] {
  if (typeId === "weather.openmeteo") {
    return { i: panelId, x: 0, y: yMax, w: 28, h: 32, minW: 16, minH: 18 };
  }
  if (typeId === "usgs.earthquake" || typeId === "traffic.roads" || typeId === "camera.penndot") {
    return { i: panelId, x: 0, y: yMax, w: 32, h: 34, minW: 18, minH: 18 };
  }
  if (typeId === "noaa.space") {
    return { i: panelId, x: 0, y: yMax, w: 32, h: 36, minW: 18, minH: 18 };
  }
  if (typeId === "safety.nearby") {
    return { i: panelId, x: 0, y: yMax, w: 40, h: 46, minW: 22, minH: 24 };
  }
  if (typeId === "audio.local") {
    return { i: panelId, x: 0, y: yMax, w: 28, h: 32, minW: 16, minH: 18 };
  }
  if (typeId === "broadcastify.owner" || typeId === "broadcastify.calls") {
    return { i: panelId, x: 0, y: yMax, w: 28, h: 28, minW: 16, minH: 16 };
  }
  if (typeId === "x.follow") {
    return { i: panelId, x: 0, y: yMax, w: 26, h: 32, minW: 16, minH: 18 };
  }
  if (
    typeId === "incident.opendata" ||
    typeId === "rivers.nwps" ||
    typeId === "storms.spc" ||
    typeId === "lightning.glm" ||
    typeId === "agency.rss" ||
    typeId === "transit.gtfs" ||
    typeId === "tfr.faa" ||
    typeId === "nuclear.nrc" ||
    typeId === "radiation.epa" ||
    typeId === "spills.uscg" ||
    typeId === "disease.who" ||
    typeId === "internet.ioda" ||
    typeId === "alarms.home"
  ) {
    return { i: panelId, x: 0, y: yMax, w: 24, h: 22, minW: 12, minH: 12 };
  }
  if (typeId === "scanner.web" || typeId === "news.rss") {
    return { i: panelId, x: 0, y: yMax, w: 28, h: 28, minW: 16, minH: 16 };
  }
  if (
    typeId === "camera.http_image" ||
    typeId === "camera.public" ||
    typeId === "camera.private" ||
    typeId === "video.youtube"
  ) {
    return { i: panelId, x: 0, y: yMax, w: 24, h: 18, minW: 12, minH: 10 };
  }
  return { i: panelId, x: 0, y: yMax, w: 16, h: 14, minW: 8, minH: 8 };
}

/** Largest member layout, so a rolling slot is not crushed. */
export function rollingLayoutFor(
  typeIds: string[],
  panelId: string,
  yMax: number,
): Panel["layout"] {
  const layouts = typeIds.map((typeId) => panelLayoutFor(typeId, panelId, yMax));
  const w = Math.max(...layouts.map((layout) => layout.w));
  const h = Math.max(...layouts.map((layout) => layout.h));
  const minW = Math.max(...layouts.map((layout) => layout.minW ?? 8));
  const minH = Math.max(...layouts.map((layout) => layout.minH ?? 8));
  return { i: panelId, x: 0, y: yMax, w, h, minW, minH };
}
