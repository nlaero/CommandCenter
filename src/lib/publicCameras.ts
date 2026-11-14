import { PUBLIC_CAMERAS, type PublicCamera, type PublicCameraMedia } from "./publicCameraData.ts";
import { streamLinkError } from "./privateCameras.ts";
import { assertHttpUrl, classifyPlayback } from "./streamMedia.ts";

export type { PublicCamera, PublicCameraMedia };
export { PUBLIC_CAMERAS };

export type CameraBand = "near" | "metro" | "farther";

export type CameraHit = {
  camera: PublicCamera;
  miles: number | null;
  band: CameraBand | null;
};

const NEAR_MILES = 25;
const METRO_MILES = 80;

export function milesBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earth = 3958.7613;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bandFor(miles: number | null): CameraBand | null {
  if (miles == null || !Number.isFinite(miles)) return null;
  if (miles <= NEAR_MILES) return "near";
  if (miles <= METRO_MILES) return "metro";
  return "farther";
}

export function formatMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return "";
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

function toHit(camera: PublicCamera, near: { lat: number; lon: number } | null): CameraHit {
  const miles = near ? milesBetween(near, camera) : null;
  return { camera, miles, band: bandFor(miles) };
}

export function mergeCameras(primary: PublicCamera[], extra: PublicCamera[]): PublicCamera[] {
  const seenUrl = new Set(primary.map((camera) => camera.url));
  const seenId = new Set(primary.map((camera) => camera.id));
  const merged = [...primary];
  for (const camera of extra) {
    if (seenUrl.has(camera.url) || seenId.has(camera.id)) continue;
    seenUrl.add(camera.url);
    seenId.add(camera.id);
    merged.push(camera);
  }
  return merged;
}

/** Suggestions when the search box is empty. With a place, the nearest cameras come first. */
export function recommendCameras(
  cameras: PublicCamera[],
  near: { lat: number; lon: number } | null,
  limit = 8,
): CameraHit[] {
  if (!near) {
    const featured = cameras.filter((camera) => camera.featured);
    const list = (featured.length ? featured : cameras).slice(0, limit);
    return list.map((camera) => toHit(camera, null));
  }
  return cameras
    .map((camera) => toHit(camera, near))
    .sort(
      (a, b) =>
        (a.miles ?? 0) - (b.miles ?? 0) || a.camera.name.localeCompare(b.camera.name),
    )
    .slice(0, limit);
}

export function searchCameras(
  cameras: PublicCamera[],
  query: string,
  near: { lat: number; lon: number } | null,
  limit = 30,
): CameraHit[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return recommendCameras(cameras, near);
  const hits = cameras
    .filter((camera) => {
      const hay = `${camera.name} ${camera.place} ${camera.region} ${camera.agency}`.toLowerCase();
      return tokens.every((token) => hay.includes(token));
    })
    .map((camera) => toHit(camera, near));
  hits.sort((a, b) => {
    if (a.miles != null && b.miles != null && a.miles !== b.miles) return a.miles - b.miles;
    return a.camera.name.localeCompare(b.camera.name);
  });
  return hits.slice(0, limit);
}

export function recommendationNote(hits: CameraHit[], hasPlace: boolean): string | null {
  if (!hasPlace || hits.length === 0) return null;
  if (hits.every((hit) => hit.band === "farther")) {
    return "Nothing in this list is close to that place. These are the nearest published cameras.";
  }
  return null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mediaOf(value: unknown, url: string): PublicCameraMedia {
  if (value === "image" || value === "hls" || value === "file" || value === "youtube") return value;
  const kind = classifyPlayback(url);
  if (kind === "image" || kind === "mjpeg") return "image";
  if (kind === "file") return "file";
  if (kind === "youtube") return "youtube";
  return "hls";
}

export function cameraPlaybackNote(media: PublicCameraMedia): string {
  if (media === "image") return "Still image. It refreshes on its interval and has no captions.";
  if (media === "youtube") return "YouTube. Sound starts muted, and YouTube's captions show while the sound is off.";
  if (media === "file") return "Video file. Sound starts muted.";
  return "Live video. Sound starts muted. Captions show while the sound is off.";
}

export function playbackNoteForUrl(url: string): string {
  const kind = classifyPlayback(url);
  if (kind === "unknown") {
    return "The panel plays this if it is an HLS playlist, a video file, a still image, or a YouTube link. Sound starts muted. A still has no captions.";
  }
  return cameraPlaybackNote(kind === "mjpeg" ? "image" : kind);
}

/** Write the camera's preloaded link, label, and refresh. A confirmed place on the source is left alone. */
export function applyPublicCamera(
  params: Record<string, unknown>,
  camera: PublicCamera,
): Record<string, unknown> {
  return {
    ...params,
    cameraId: camera.id,
    url: camera.url,
    label: camera.name,
    place: camera.place,
    region: camera.region,
    agency: camera.agency,
    attribution: camera.attribution,
    media: camera.media,
    refresh: camera.refresh,
    cameraLat: camera.lat,
    cameraLon: camera.lon,
  };
}

export function selectedPublicCamera(
  params: Record<string, unknown>,
  pool: PublicCamera[],
): PublicCamera | null {
  const id = text(params.cameraId);
  if (!id) return null;
  const found = pool.find((camera) => camera.id === id);
  if (found) return found;
  const url = text(params.url);
  if (!url) return null;
  const lat = typeof params.cameraLat === "number" ? params.cameraLat : 0;
  const lon = typeof params.cameraLon === "number" ? params.cameraLon : 0;
  return {
    id,
    name: text(params.label) || "Camera",
    place: text(params.place),
    region: text(params.region),
    agency: text(params.agency),
    lat,
    lon,
    url,
    media: mediaOf(params.media, url),
    refresh: text(params.refresh) || "30s",
    attribution: text(params.attribution),
    featured: false,
  };
}

function refreshOf(value: unknown): string {
  const raw = text(value);
  if (/^\d+\s*[smh]$/i.test(raw)) return raw.replace(/\s+/g, "");
  return "30s";
}

/**
 * Keep a known camera's published link. A label the user typed stays.
 * Live catalog rows that are not in the preloaded list keep the parameters picked in the form.
 */
export function sealPublicCamera(
  params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown>; refresh: string } | { ok: false; message: string } {
  const id = text(params.cameraId);
  if (!id) return { ok: false, message: "Pick a public camera." };
  const known = PUBLIC_CAMERAS.find((camera) => camera.id === id);
  let next = params;
  if (known) {
    const label = text(params.label) || known.name;
    next = applyPublicCamera(params, known);
    next.label = label;
  }
  const label = text(next.label);
  if (!label) return { ok: false, message: "Add a camera label." };
  const linkError = streamLinkError(next.url, "Pick a public camera.");
  if (linkError) return { ok: false, message: linkError };
  let url: string;
  try {
    url = assertHttpUrl(text(next.url));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Pick a public camera." };
  }
  const media = mediaOf(next.media, url);
  next = { ...next, url, media, label };
  return { ok: true, params: next, refresh: refreshOf(next.refresh) };
}
