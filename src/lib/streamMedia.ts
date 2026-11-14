/** Classify camera and YouTube links and fetch bytes for HLS (playlists stay absolute). */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const MAX_BYTES = 32 * 1024 * 1024;

export type PlaybackKind = "hls" | "file" | "image" | "mjpeg" | "youtube" | "unknown";

export type MediaBytes = {
  data: ArrayBuffer;
  /** URL after redirects. Relative playlist entries resolve against this. */
  finalUrl: string;
  contentType: string;
};

export function assertHttpUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter an http or https link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Enter an http or https link.");
  }
  return url.toString();
}

export function isYoutubeUrl(input: string): boolean {
  try {
    const host = new URL(input.trim()).hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtube-nocookie.com"
    );
  } catch {
    return false;
  }
}

/** Watch, live, embed, shorts, youtu.be, or a bare 11-character id. */
export function youtubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (!raw.includes("://") && !raw.includes("/") && YT_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isYoutubeUrl(raw)) return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return YT_ID.test(id) ? id : null;
  }
  const fromQuery = url.searchParams.get("v");
  if (fromQuery && YT_ID.test(fromQuery)) return fromQuery;
  const parts = url.pathname.split("/").filter(Boolean);
  const markers = new Set(["embed", "live", "shorts", "v", "e"]);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (markers.has(parts[i]) && YT_ID.test(parts[i + 1])) return parts[i + 1];
  }
  return null;
}

export function youtubeChannelId(input: string): string | null {
  if (!isYoutubeUrl(input)) return null;
  try {
    const parts = new URL(input.trim()).pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("channel");
    const id = idx >= 0 ? parts[idx + 1] : "";
    return id && CHANNEL_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** `@name/live` or `/channel/UC…/live` — the current live stream, not a VOD id. */
export function prefersChannelLive(input: string): boolean {
  if (!isYoutubeUrl(input) || youtubeVideoId(input)) return false;
  try {
    const parts = new URL(input.trim()).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1]?.toLowerCase() === "live";
  } catch {
    return false;
  }
}

export function youtubeFromPage(html: string): { videoId: string | null; channelId: string | null } {
  const channelId =
    html.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/channel_id=(UC[\w-]{22})/)?.[1] ??
    null;
  // The first videoId on a channel page is often a recommendation. Player details,
  // the canonical watch URL, or the id next to `"isLive":true` is the stream
  // the live page actually opened.
  const videoId =
    html.match(/"videoDetails":\{"videoId":"([A-Za-z0-9_-]{11})"/)?.[1] ??
    html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/)?.[1] ??
    html.match(/property="og:url" content="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/)?.[1] ??
    videoIdNearLive(html) ??
    html.match(/watch\?v=([A-Za-z0-9_-]{11})/)?.[1] ??
    html.match(/"videoId":"([A-Za-z0-9_-]{11})"/)?.[1] ??
    null;
  return {
    videoId: videoId && YT_ID.test(videoId) ? videoId : null,
    channelId: channelId && CHANNEL_ID.test(channelId) ? channelId : null,
  };
}

function videoIdNearLive(html: string): string | null {
  const liveAt = html.indexOf('"isLive":true');
  if (liveAt < 0) return null;
  const slice = html.slice(Math.max(0, liveAt - 8000), liveAt);
  const ids = [...slice.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"/g)];
  if (ids.length && YT_ID.test(ids[ids.length - 1][1])) return ids[ids.length - 1][1];
  const watches = [...slice.matchAll(/watch\?v=([A-Za-z0-9_-]{11})/g)];
  if (watches.length && YT_ID.test(watches[watches.length - 1][1])) return watches[watches.length - 1][1];
  return null;
}

function embedParams(origin?: string, captions = true): URLSearchParams {
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    playsinline: "1",
    rel: "0",
    modestbranding: "1",
    enablejsapi: "1",
    cc_load_policy: captions ? "1" : "0",
    cc_lang_pref: "en",
  });
  if (origin) params.set("origin", origin);
  return params;
}

export function youtubeVideoEmbed(videoId: string, origin?: string, captions = true): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?${embedParams(origin, captions)}`;
}

export function youtubeChannelEmbed(channelId: string, origin?: string, captions = true): string {
  const params = embedParams(origin, captions);
  params.set("channel", channelId);
  return `https://www.youtube-nocookie.com/embed/live_stream?${params}`;
}

/** Embed URL when the link already contains a video id or a `/channel/UC…` id. */
export function youtubeEmbedSrc(input: string, origin?: string, captions = true): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (isYoutubeUrl(raw) || (!raw.includes("://") && !raw.includes("/"))) {
    const videoId = youtubeVideoId(raw);
    if (videoId) return youtubeVideoEmbed(videoId, origin, captions);
  }
  const channelId = youtubeChannelId(raw);
  if (channelId) return youtubeChannelEmbed(channelId, origin, captions);
  return null;
}

export function classifyPlayback(url: string, sourceType?: string): PlaybackKind {
  const trimmed = url.trim();
  if (sourceType === "video.youtube" || isYoutubeUrl(trimmed)) return "youtube";
  if (!trimmed) return "unknown";
  const path = pathnameOf(trimmed);
  if (path.endsWith(".m3u8")) return "hls";
  if (/\.(mp4|webm|m4v|ogv|mov|ogg)$/.test(path)) return "file";
  if (path.endsWith(".mjpg") || path.endsWith(".mjpeg")) return "mjpeg";
  if (/\.(jpe?g|png|gif|webp|bmp|avif)$/.test(path)) return "image";
  return "unknown";
}

function pathnameOf(input: string): string {
  try {
    return new URL(input).pathname.toLowerCase();
  } catch {
    return input.split("?")[0].split("#")[0].toLowerCase();
  }
}

export function absolutizePlaylist(text: string, base: string): string {
  const bom = text.startsWith("\uFEFF");
  const cleaned = bom ? text.slice(1) : text;
  if (!cleaned.trimStart().startsWith("#EXTM3U")) return text;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return text;
  }
  const newline = cleaned.includes("\r\n") ? "\r\n" : "\n";
  const ending = cleaned.endsWith("\n");
  const lines = cleaned.split(/\r?\n/);
  if (ending && lines[lines.length - 1] === "") lines.pop();
  const rewritten = lines.map((line) => rewritePlaylistLine(line, baseUrl));
  const body = rewritten.join(newline) + (ending ? newline : "");
  return (bom ? "\uFEFF" : "") + body;
}

function rewritePlaylistLine(line: string, base: URL): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (trimmed.startsWith("#")) return rewriteUriAttrs(line, base);
  const lead = line.match(/^\s*/)?.[0] ?? "";
  return lead + resolveAgainst(base, trimmed);
}

function rewriteUriAttrs(line: string, base: URL): string {
  return line
    .replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${resolveAgainst(base, uri)}"`)
    .replace(/URI='([^']*)'/g, (_match, uri: string) => `URI='${resolveAgainst(base, uri)}'`);
}

function resolveAgainst(base: URL, ref: string): string {
  const value = ref.trim();
  if (!value || value.startsWith("data:")) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

export function looksLikePlaylist(data: ArrayBuffer, contentType: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes("mpegurl") || type.includes("m3u8")) return true;
  const head = new TextDecoder("utf-8")
    .decode(data.slice(0, 32))
    .replace(/^\uFEFF/, "")
    .trimStart();
  return head.startsWith("#EXTM3U");
}

export function looksLikeImage(data: ArrayBuffer, contentType: string): boolean {
  const type = contentType.toLowerCase();
  if (type.startsWith("image/")) return true;
  const bytes = new Uint8Array(data.slice(0, 16));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return true;
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

export function looksLikeVideoFile(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.startsWith("video/mp4") ||
    type.startsWith("video/webm") ||
    type.startsWith("video/ogg") ||
    type.startsWith("video/quicktime")
  );
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }
  if (Array.isArray(value) && value.every((part) => typeof part === "number")) {
    return Uint8Array.from(value).buffer;
  }
  throw new Error("Couldn't read that stream.");
}

function commandMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : "";
  if (!raw) return "Couldn't reach that stream.";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  } catch {
    // The command already returned plain text.
  }
  return raw;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message.trim()) return body.message;
  } catch {
    // Not JSON.
  }
  return fallback;
}

/** Fetch a playlist or segment. Playlists come back with absolute URLs. */
export async function fetchMedia(
  url: string,
  init?: { range?: string; signal?: AbortSignal },
): Promise<MediaBytes> {
  const target = assertHttpUrl(url);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const args = init?.range ? { url: target, range: init.range } : { url: target };
    let raw: unknown;
    try {
      raw = await invoke("fetch_media_url", args);
    } catch (err) {
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      throw new Error(commandMessage(err));
    }
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const data = toArrayBuffer(raw);
    return { data, finalUrl: target, contentType: "" };
  }

  const headers: Record<string, string> = {};
  if (init?.range) headers.range = init.range;
  const response = await fetch(`/proxy/media?u=${encodeURIComponent(target)}`, {
    headers,
    signal: init?.signal,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `The stream replied HTTP ${response.status}.`),
    );
  }
  const finalUrl = response.headers.get("x-cc-final-url") || target;
  const contentType = response.headers.get("content-type") ?? "";
  let data = await response.arrayBuffer();
  if (data.byteLength > MAX_BYTES) throw new Error("That response is too large to play.");
  if (looksLikePlaylist(data, contentType)) {
    const text = new TextDecoder("utf-8").decode(data);
    const rewritten = absolutizePlaylist(text, finalUrl);
    const encoded = new TextEncoder().encode(rewritten);
    data = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  }
  return { data, finalUrl, contentType };
}

export function withCacheBust(url: string, token: number): string {
  try {
    const next = new URL(url);
    next.searchParams.set("cc_refresh", String(token));
    return next.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}cc_refresh=${token}`;
  }
}
