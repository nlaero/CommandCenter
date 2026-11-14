import type { CaptionSegment } from "./captions";
import { parseFeedOwnerInputId, takeFeedCaptionWindows } from "./feedCaptions";
import { findLocations } from "./location";
import {
  choosePlacement,
  placeQuery,
  PREVIEW_TRANSMISSIONS,
  type PlacedCall,
  type SafetyFeed,
} from "./safety";

const placeCache = new Map<string, PlacedCall>();

/** Geocode the street inside the feed's county and state. Successes are cached. */
export async function placeHeardAddress(
  heard: string,
  county: string,
  state: string,
): Promise<PlacedCall | null> {
  const query = placeQuery(heard, county, state);
  const cached = placeCache.get(query);
  if (cached) return cached;
  try {
    const matches = await findLocations({ provider: "address", address: query });
    const placed = choosePlacement(matches, county, state, heard);
    if (placed) placeCache.set(query, placed);
    return placed;
  } catch {
    return null;
  }
}

export type SafetyWindow = {
  engine: "local-whisper" | "local-stub" | "preview";
  status: "ready" | "needs-model" | "preview" | "error" | "empty";
  note: string;
  segments: CaptionSegment[];
  audioUrl: string | null;
};

type RawWindow = {
  engine: string;
  status: string;
  note: string;
  clipId?: string | null;
  segments?: { id: string; startSec: number; endSec: number; text: string; speaker?: string | null }[];
};

export const BROWSER_PREVIEW_NOTE =
  "Browser preview. The desktop app transcribes each window with Tiny English on this computer. This preview runs that reader on a sample: Engine 12 responding and on scene stay one incident, Engine 12 clears, and the next response is a new incident. The person on the unit is not learned from the unit ID.";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function listAudioInputs(): Promise<{ id: string; label: string }[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const listed = await invoke<{ id: string; label: string }[]>("list_audio_inputs");
    return listed.length ? listed : [{ id: "default", label: "Default input" }];
  }
  const list = [{ id: "default", label: "Default input" }];
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const device of devices) {
        if (device.kind !== "audioinput") continue;
        const id = device.deviceId || "default";
        if (list.some((item) => item.id === id)) continue;
        list.push({ id, label: device.label || "Audio input" });
      }
    } catch {
      /* Permission can wait until the desktop app records. */
    }
  }
  return list;
}

/** Desktop listens to every feed. The browser plays the sample on the first feed only. */
export function listensOnDevice(): boolean {
  return isTauri();
}

export async function listenSafetyFeed(feed: SafetyFeed): Promise<SafetyWindow[]> {
  const ownerId = feed.kind === "audio-in" ? parseFeedOwnerInputId(feed.deviceId) : null;
  if (ownerId) return feedOwnerWindows(feed.id, ownerId);
  if (!isTauri()) return browserPreview(feed);
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawWindow>("listen_safety_feed", {
    args: {
      kind: feed.kind,
      url: feed.url.trim() || null,
      deviceId: feed.deviceId.trim() || null,
    },
  });
  const segments = (raw.segments ?? []).map((segment) => ({
    id: segment.id,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    speaker: segment.speaker?.trim() || null,
  }));
  let audioUrl: string | null = null;
  if (raw.clipId && segments.length) {
    const clip = await invoke<{ base64: string }>("safety_clip", {
      args: { clipId: raw.clipId },
    });
    audioUrl = wavObjectUrl(clip.base64);
  }
  const engine = raw.engine === "local-whisper" ? "local-whisper" : "local-stub";
  const status =
    raw.status === "ready" || raw.status === "needs-model" || raw.status === "error"
      ? raw.status
      : segments.length
        ? "ready"
        : "empty";
  return [
    {
      engine,
      status,
      note: raw.note,
      segments,
      audioUrl,
    },
  ];
}

/** Empty when the panel is open and no new caption window has arrived. */
function feedOwnerWindows(consumerId: string, sourceId: string): SafetyWindow[] {
  const taken = takeFeedCaptionWindows(consumerId, sourceId);
  if (taken.state === "idle") return [];
  if (taken.state === "closed" || !taken.windows.length) {
    return [
      {
        engine: "local-whisper",
        status: "empty",
        note: taken.note,
        segments: [],
        audioUrl: null,
      },
    ];
  }
  return taken.windows.map((window) => ({
    engine: "local-whisper" as const,
    status: "ready" as const,
    note: taken.note,
    segments: window.lines.map((line) => ({
      id: line.id,
      startSec: line.startSec,
      endSec: line.endSec,
      text: line.text,
    })),
    audioUrl: taken.streamUrl || null,
  }));
}

function browserPreview(feed: SafetyFeed): SafetyWindow[] {
  return PREVIEW_TRANSMISSIONS.map((lines, index) => ({
    engine: "preview",
    status: "preview",
    note: BROWSER_PREVIEW_NOTE,
    segments: lines.map((text, line) => ({
      id: `${feed.id}-tx-${index}-seg-${line}`,
      startSec: line * 4,
      endSec: line * 4 + 4,
      text,
      speaker: null,
    })),
    audioUrl: URL.createObjectURL(new Blob([previewWav()], { type: "audio/wav" })),
  }));
}

function wavObjectUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** One quiet second so the muted player has a real clip in the browser preview. */
function previewWav(): Uint8Array {
  const sampleRate = 8000;
  const samples = sampleRate;
  const dataSize = samples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.05 * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
