import { getAdapter } from "../adapters/catalog";

/**
 * Live pictures and live audio do not scroll. A rolling panel would leave them
 * while they are still live, so they stay a single panel.
 * Keep this list in step with `source_scrolls` in the Rust commands.
 */
const LIVE_FEED_TYPES = new Set([
  "adsb.exchange",
  "adsb.local",
  "audio.local",
  "broadcastify.owner",
  "camera.http_image",
  "camera.private",
  "camera.public",
  "camera.rtsp",
  "scanner.web",
  "video.youtube",
]);

export function sourceScrolls(typeId: string): boolean {
  return !LIVE_FEED_TYPES.has(typeId);
}

export function sourceGroup(typeId: string): string {
  switch (typeId) {
    case "weather.openmeteo":
    case "storms.spc":
    case "lightning.glm":
    case "noaa.space":
    case "ham.swpc":
      return "Weather";
    case "rivers.nwps":
    case "usgs.earthquake":
    case "spills.uscg":
    case "radiation.epa":
    case "nuclear.nrc":
      return "Water and hazards";
    case "traffic.roads":
    case "transit.gtfs":
      return "Travel";
    case "adsb.exchange":
    case "adsb.local":
    case "tfr.faa":
      return "Air";
    case "broadcastify.owner":
    case "broadcastify.calls":
    case "scanner.web":
    case "audio.local":
    case "safety.nearby":
    case "camera.public":
    case "camera.private":
    case "camera.http_image":
    case "camera.rtsp":
    case "video.youtube":
      return "Radio and cameras";
    case "news.rss":
    case "x.follow":
    case "incident.opendata":
    case "agency.rss":
    case "disease.who":
    case "internet.ioda":
      return "News and notices";
    case "alarms.home":
      return "Home";
    default:
      return "Other";
  }
}

export const SOURCE_GROUP_ORDER = [
  "Weather",
  "Water and hazards",
  "Travel",
  "Air",
  "Radio and cameras",
  "News and notices",
  "Home",
  "Other",
] as const;

/**
 * Why this source cannot join a rolling panel, or null when it can.
 * Weather rotates its own maps inside the weather panel, so it is refused
 * even though the hourly strip scrolls.
 */
export function liveFeedRefusal(typeId: string): string | null {
  if (typeId === "weather.openmeteo") {
    return "Weather stays in its own panel. Choose which maps it shows, how many are on screen, and whether those maps rotate inside the weather panel. Weather cannot be added to a rolling panel.";
  }
  if (sourceScrolls(typeId)) return null;
  const name = getAdapter(typeId)?.name ?? "This source";
  return `${name} is a live feed and does not scroll. It cannot be part of a rolling panel. Leave it as its own panel, or pick a source that scrolls.`;
}

/** Refuse when any member of a rolling panel cannot scroll. */
export function rollingPanelRefusal(typeIds: string[]): string | null {
  for (const typeId of typeIds) {
    const refusal = liveFeedRefusal(typeId);
    if (refusal) return refusal;
  }
  return null;
}
