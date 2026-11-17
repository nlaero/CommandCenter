/**
 * Direct web-scanner audio. A stream the user is allowed to play.
 * Broadcastify pages, relays, and Calls links stay in those sources.
 * This module does not publish caption windows for nearby alerts.
 */

import { isYoutubeUrl } from "./streamMedia.ts";

export type ScannerPlayback = "hls" | "file" | "live";

const WINDOW_SEC = 12;
const FILE_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|webm|m4v)$/;

export function webScannerUrlError(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "Enter the stream link.";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Enter an http or https stream link.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Enter an http or https stream link.";
  }
  if (url.username || url.password) {
    return "Don't put a username or password in the stream link. It would be saved in the board file.";
  }
  if (isYoutubeUrl(trimmed)) {
    return "YouTube stays in the YouTube Live source.";
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isBroadcastifyHost(host)) {
    return "Broadcastify links stay in Feed Owner or Calls. This source plays a direct audio stream from a server you are allowed to use.";
  }
  const path = url.pathname.toLowerCase();
  if (/\.(html?|php|asp|aspx)$/.test(path)) {
    return "That looks like a web page. Paste the direct audio stream.";
  }
  if (/\.(pls|asx|wpl|xspf)$/.test(path)) {
    return "That file is a playlist, not the audio. Open it and paste the stream link inside.";
  }
  return null;
}

export function normalizeWebScannerUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = "";
  return url.toString();
}

export function scannerPlayback(input: string): ScannerPlayback {
  const path = pathnameOf(input);
  if (path.endsWith(".m3u8")) return "hls";
  if (FILE_EXT.test(path)) return "file";
  return "live";
}

/** A file is seeked window by window. A live mount is read from now. */
export function scannerCaptionWindow(
  input: string,
  index: number,
): { seekSec: number; timelineStart: number; durationSec: number } {
  const start = Math.max(0, index) * WINDOW_SEC;
  if (scannerPlayback(input) === "file") {
    return { seekSec: start, timelineStart: start, durationSec: WINDOW_SEC };
  }
  return { seekSec: 0, timelineStart: start, durationSec: WINDOW_SEC };
}

export function streamHost(input: string): string {
  try {
    return new URL(input.trim()).host;
  } catch {
    return "";
  }
}

function pathnameOf(input: string): string {
  try {
    return new URL(input.trim()).pathname.toLowerCase();
  } catch {
    return input.split("?")[0].split("#")[0].toLowerCase();
  }
}

function isBroadcastifyHost(host: string): boolean {
  const name = host.replace(/^www\./, "");
  return (
    name === "broadcastify.com" ||
    name.endsWith(".broadcastify.com") ||
    name === "bcfy.io" ||
    name.endsWith(".bcfy.io")
  );
}
