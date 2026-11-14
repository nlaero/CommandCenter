import type { CaptionSegment } from "./captions";
import { fetchSourcePayload } from "./api";
import { parseCallsInputId, parseFeedOwnerInputId, takeFeedCaptionWindows } from "./feedCaptions";
import { describeError, findLocations } from "./location";
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
  const callsId = feed.kind === "audio-in" ? parseCallsInputId(feed.deviceId) : null;
  if (callsId) return callsWindows(feed.id, callsId);
  if (!isTauri()) return browserPreview(feed);
  return [await transcribeInput(feed.kind, feed.url.trim() || null, feed.deviceId.trim() || null)];
}

type CallClip = { id: string; audioUrl: string; transcript: string };

const callSessions = new Map<string, CallClip[]>();
const callSeen = new Map<string, Set<string>>();
const HEARD_CALLS_KEY = "command-center.calls-heard.v1";

/** Clips the Calls panel already loaded. Nearby alerts read these before asking the API again. */
export function publishCallClips(
  sourceId: string,
  incidents: { id: string; audioUrl?: string; transcript?: string }[],
): void {
  const clips: CallClip[] = [];
  for (const item of incidents) {
    const audioUrl = item.audioUrl?.trim() ?? "";
    if (!item.id || !audioUrl) continue;
    clips.push({ id: item.id, audioUrl, transcript: item.transcript?.trim() ?? "" });
  }
  callSessions.set(sourceId, clips);
}

export function closeCallClips(sourceId: string): void {
  callSessions.delete(sourceId);
}

export function resetCallClipsForTests(): void {
  callSessions.clear();
  callSeen.clear();
}

function heardCallKeys(): Set<string> {
  try {
    if (typeof sessionStorage === "undefined") return new Set();
    const raw = sessionStorage.getItem(HEARD_CALLS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function rememberHeardCall(key: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const keys = heardCallKeys();
    keys.add(key);
    const list = [...keys].slice(-200);
    sessionStorage.setItem(HEARD_CALLS_KEY, JSON.stringify(list));
  } catch {
    /* The clip can be read again next time the app opens. */
  }
}

function wasHeard(key: string): boolean {
  return heardCallKeys().has(key);
}

async function callsWindows(consumerId: string, sourceId: string): Promise<SafetyWindow[]> {
  const published = callSessions.get(sourceId);
  const clips = published ?? (await fetchCallClips(sourceId));
  if (!clips) return [];
  const seen = callSeen.get(`${consumerId}:${sourceId}`) ?? new Set<string>();
  const pending = clips.filter((clip) => !seen.has(clip.id) && !wasHeard(`${sourceId}:${clip.id}`));
  const clip = pending[pending.length - 1];
  if (!clip) return [];
  seen.add(clip.id);
  callSeen.set(`${consumerId}:${sourceId}`, seen);
  let heard: SafetyWindow;
  try {
    if (clip.transcript) {
      heard = {
        engine: "local-whisper",
        status: "ready",
        note: "Call clip from the Calls source. Audio stays on this computer.",
        segments: [
          {
            id: `${clip.id}-words`,
            startSec: 0,
            endSec: 0,
            text: clip.transcript,
          },
        ],
        audioUrl: clip.audioUrl,
      };
    } else if (!isTauri()) {
      heard = {
        engine: "local-whisper",
        status: "empty",
        note: "This Calls source has audio. The desktop app captions the clip on this computer.",
        segments: [],
        audioUrl: clip.audioUrl,
      };
    } else {
      heard = await transcribeInput("online", clip.audioUrl, null);
    }
  } catch (err) {
    throw new Error(describeError(err, "Could not caption that call clip."));
  }
  if (heard.segments.length || clip.transcript) rememberHeardCall(`${sourceId}:${clip.id}`);
  return [heard];
}

async function fetchCallClips(sourceId: string): Promise<CallClip[] | null> {
  try {
    const payload = await fetchSourcePayload(sourceId);
    const clips: CallClip[] = [];
    for (const item of payload.incidents) {
      const audioUrl = item.audioUrl?.trim() ?? "";
      if (!audioUrl) continue;
      clips.push({
        id: item.id,
        audioUrl,
        transcript: item.transcript?.trim() ?? "",
      });
    }
    return clips;
  } catch (err) {
    throw new Error(describeError(err, "Could not read that Calls source."));
  }
}

async function transcribeInput(
  kind: string,
  url: string | null,
  deviceId: string | null,
): Promise<SafetyWindow> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawWindow>("listen_safety_feed", {
    args: { kind, url, deviceId },
  });
  const segments = (raw.segments ?? []).map((segment) => ({
    id: segment.id,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    speaker: segment.speaker?.trim() || null,
  }));
  let audioUrl: string | null = null;
  if (raw.clipId && (segments.length || raw.status === "needs-model")) {
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
  return { engine, status, note: raw.note, segments, audioUrl };
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
