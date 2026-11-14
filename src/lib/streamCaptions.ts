/**
 * Caption timing for camera and file panels.
 *
 * Streams that already include captions (HLS WebVTT or CEA-708, YouTube) use those.
 * Everything else is transcribed on this computer. YouTube media is never fetched
 * for that — the embed supplies its own captions.
 */

export type HlsCaptionPlan =
  | { kind: "embedded" }
  | { kind: "transcribe"; audioPlaylistUrl: string | null; mediaPlaylistUrl: string | null };

export type MediaSlice = {
  url: string;
  startSec: number;
  durationSec: number;
};

/** Captions show while muted. CC keeps them up after the sound is turned on. */
export function captionsVisible(muted: boolean, ccOn: boolean): boolean {
  return muted || ccOn;
}

/** Hosts whose media we do not download for transcription. */
export function blocksCaptionDownload(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return (
    host === "youtu.be" ||
    host.endsWith(".youtu.be") ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtube-nocookie.com" ||
    host.endsWith(".youtube-nocookie.com") ||
    host === "googlevideo.com" ||
    host.endsWith(".googlevideo.com") ||
    host === "youtube.googleapis.com" ||
    host.endsWith(".youtube.googleapis.com")
  );
}

export function cleanCaptionText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  if (/^\[?\s*(blank[_\s-]?audio|silence|inaudible)\s*\]?$/i.test(trimmed)) return "";
  return trimmed;
}

export function hlsHasEmbeddedCaptions(playlist: string): boolean {
  if (/#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES\b/i.test(playlist)) return true;
  if (/#EXT-X-MEDIA:[^\n]*TYPE=CLOSED-CAPTIONS\b/i.test(playlist)) return true;
  for (const match of playlist.matchAll(/CLOSED-CAPTIONS=("[^"]*"|[^,\s]*)/gi)) {
    let value = match[1] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value && value.toUpperCase() !== "NONE") return true;
  }
  return false;
}

export function playlistIsVod(playlist: string): boolean {
  return /#EXT-X-ENDLIST\b/.test(playlist) || /#EXT-X-PLAYLIST-TYPE:\s*VOD\b/i.test(playlist);
}

export function hlsCaptionPlan(playlist: string, playlistUrl: string): HlsCaptionPlan {
  if (hlsHasEmbeddedCaptions(playlist)) return { kind: "embedded" };
  const audioPlaylistUrl = audioPlaylistUrlFrom(playlist, playlistUrl);
  const variants = variantPlaylists(playlist, playlistUrl);
  if (!variants.length && !playlist.includes("#EXTINF:")) {
    return { kind: "transcribe", audioPlaylistUrl, mediaPlaylistUrl: null };
  }
  if (variants.length) {
    return {
      kind: "transcribe",
      audioPlaylistUrl,
      mediaPlaylistUrl: variants[0]?.url ?? null,
    };
  }
  return { kind: "transcribe", audioPlaylistUrl, mediaPlaylistUrl: null };
}

export function parseMediaSegments(playlist: string, playlistUrl: string): MediaSlice[] {
  if (!playlist.includes("#EXTINF:")) return [];
  let base: URL;
  try {
    base = new URL(playlistUrl);
  } catch {
    return [];
  }
  const lines = playlist.split(/\r?\n/);
  const slices: MediaSlice[] = [];
  let startSec = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXTINF:")) continue;
    const duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j += 1;
    const ref = lines[j]?.trim();
    if (!ref) continue;
    let url: string;
    try {
      url = new URL(ref, base).href;
    } catch {
      continue;
    }
    slices.push({ url, startSec, durationSec: duration });
    startSec += duration;
  }
  return slices;
}

/** Audio segment URLs on the video timeline, so captions match `currentTime`. */
export function alignAudioSlices(video: MediaSlice[], audio: MediaSlice[]): MediaSlice[] {
  if (!audio.length) return video;
  if (!video.length) return audio;
  const count = Math.min(video.length, audio.length);
  return Array.from({ length: count }, (_, index) => ({
    url: audio[index].url,
    startSec: video[index].startSec,
    durationSec: video[index].durationSec,
  }));
}

export function slicesAround(slices: MediaSlice[], timeSec: number, count: number): MediaSlice[] {
  if (!slices.length || count <= 0) return [];
  const index = slices.findIndex((slice) => timeSec < slice.startSec + slice.durationSec);
  const start = index < 0 ? Math.max(0, slices.length - 1) : index;
  return slices.slice(start, start + count);
}

export function fileCaptionWindow(timeSec: number, windowSec = 12): { startSec: number; durationSec: number } {
  const size = Math.min(30, Math.max(4, windowSec));
  const startSec = Math.max(0, Math.floor(Math.max(0, timeSec) / size) * size);
  return { startSec, durationSec: size };
}

function audioPlaylistUrlFrom(playlist: string, playlistUrl: string): string | null {
  const tags = mediaTags(playlist).filter((tag) => tag.TYPE?.toUpperCase() === "AUDIO" && tag.URI);
  const chosen = tags.find((tag) => tag.DEFAULT?.toUpperCase() === "YES") ?? tags[0];
  if (!chosen?.URI) return null;
  try {
    return new URL(chosen.URI, playlistUrl).href;
  } catch {
    return null;
  }
}

function variantPlaylists(playlist: string, playlistUrl: string): { bandwidth: number; url: string }[] {
  const lines = playlist.split(/\r?\n/);
  const variants: { bandwidth: number; url: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith("#"))) j += 1;
    const ref = lines[j]?.trim();
    if (!ref) continue;
    try {
      variants.push({ bandwidth, url: new URL(ref, playlistUrl).href });
    } catch {
      // Skip a variant we cannot resolve.
    }
  }
  return variants;
}

function mediaTags(playlist: string): Array<Record<string, string>> {
  const tags: Array<Record<string, string>> = [];
  for (const line of playlist.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-MEDIA:")) continue;
    tags.push(parseAttributes(trimmed.slice("#EXT-X-MEDIA:".length)));
  }
  return tags;
}

function parseAttributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    let value = match[2] ?? "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[match[1]] = value;
  }
  return attrs;
}
