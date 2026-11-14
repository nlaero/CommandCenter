/**
 * Local audio captions for a jack or Bluetooth input on this computer.
 *
 * The desktop app records a short window and transcribes it with Tiny English.
 * Caption fixes stay in the local caption store and apply the next time those
 * words are heard. This source does not read or write Broadcastify history,
 * and it does not publish nearby alerts.
 */

import { cleanCaptionText } from "./streamCaptions.ts";

export const LOCAL_AUDIO_WINDOW_SEC = 12;
export const MAX_CAPTION_LINES = 120;
const FOLLOW_SLACK_PX = 24;

export type LocalInputKind = "jack" | "bluetooth";

export type LocalAudioInput = {
  id: string;
  label: string;
  kind: LocalInputKind;
};

export type LocalCaptionLine = {
  id: string;
  startSec: number;
  endSec: number;
  /** Words before this computer's caption fixes, so a later fix is applied once. */
  source: string;
  text: string;
};

export type LocalAudioWindow = {
  engine: "local-whisper" | "local-stub";
  status: "ready" | "needs-model" | "empty" | "error";
  note: string;
  durationSec: number;
  segments: { id: string; startSec: number; endSec: number; text: string }[];
  audioUrl: string | null;
};

export const PREVIEW_INPUTS: LocalAudioInput[] = [
  { id: "preview-jack", label: "Line in (jack)", kind: "jack" },
  { id: "preview-bluetooth", label: "Bluetooth headset", kind: "bluetooth" },
];

export const PREVIEW_CAPTIONS = [
  "Scanner check, channel clear.",
  "Traffic holding on the local channel.",
  "Copy, channel clear.",
  "Standing by.",
  "Local channel, channel clear.",
];

type RawWindow = {
  engine?: string;
  status?: string;
  note?: string;
  durationSec?: number;
  segments?: { id?: string; startSec?: number; endSec?: number; text?: string }[];
  audioBase64?: string;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isPreviewInput(id: string): boolean {
  return PREVIEW_INPUTS.some((item) => item.id === id);
}

/**
 * Jack and Bluetooth only. A speaker monitor and a microphone array are not inputs.
 * Bluetooth is chosen before jack so a Bluetooth headset is not labeled as a jack.
 */
export function classifyLocalInput(id: string, label: string): LocalInputKind | null {
  const text = `${id} ${label}`.toLowerCase();
  if (text.includes(".monitor")) return null;
  if (
    text.includes("bluez") ||
    text.includes("bluetooth") ||
    text.includes("hands-free") ||
    text.includes("handsfree") ||
    text.includes("a2dp")
  ) {
    return "bluetooth";
  }
  if (
    text.includes("analog") ||
    text.includes("line in") ||
    text.includes("line-in") ||
    text.includes("line_in") ||
    text.includes("aux") ||
    text.includes("jack") ||
    (text.includes("microphone") && !text.includes("array") && !text.includes("virtual"))
  ) {
    return "jack";
  }
  return null;
}

export function localInputKindLabel(kind: string | null): string {
  if (kind === "bluetooth") return "Bluetooth";
  if (kind === "jack") return "Jack";
  return "Input";
}

export function localAudioSaveError(params: Record<string, unknown>): string | null {
  const id = String(params.deviceId ?? "").trim();
  const label = String(params.deviceLabel ?? id).trim();
  const kind = classifyLocalInput(id, label);
  if (!id || (kind !== "jack" && kind !== "bluetooth")) {
    return "Choose a jack or Bluetooth input.";
  }
  return null;
}

/** The list is on the latest line when the user is within a few pixels of the bottom. */
export function captionListAtLatest(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  if (scrollHeight <= clientHeight + 1) return true;
  return scrollHeight - scrollTop - clientHeight < FOLLOW_SLACK_PX;
}

/**
 * Scrolling away pauses auto-follow. Jumping back to the latest line turns it on.
 * A programmatic scroll does not change follow.
 */
export function captionFollowAfterScroll(input: {
  following: boolean;
  userScrolled: boolean;
  atLatest: boolean;
}): boolean {
  if (!input.userScrolled) return input.following;
  return input.atLatest;
}

/** Recompute visible lines from the original words. `correct` is the caption store on this computer. */
export function captionsWithMemory(
  lines: LocalCaptionLine[],
  correct: (text: string) => string,
): LocalCaptionLine[] {
  return lines.map((line) => {
    const text = cleanCaptionText(correct(line.source));
    if (!text || text === line.text) return line;
    return { ...line, text };
  });
}

export function appendCaptionLines(
  lines: LocalCaptionLine[],
  segments: { text: string; startSec: number; endSec: number }[],
  originSec: number,
  idPrefix: string,
  correct: (text: string) => string = (text) => text,
): { lines: LocalCaptionLine[]; added: number } {
  const next = [...lines];
  let added = 0;
  segments.forEach((segment, index) => {
    const source = segment.text.replace(/\s+/g, " ").trim();
    const text = cleanCaptionText(correct(source));
    if (!text) return;
    const startSec = roundSec(originSec + segment.startSec);
    const endSec = roundSec(originSec + Math.max(segment.endSec, segment.startSec));
    next.push({
      id: `${idPrefix}-${index}`,
      startSec,
      endSec,
      source,
      text,
    });
    added += 1;
  });
  if (next.length > MAX_CAPTION_LINES) {
    return { lines: next.slice(next.length - MAX_CAPTION_LINES), added };
  }
  return { lines: next, added };
}

export async function listLocalAudioInputs(): Promise<LocalAudioInput[]> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const listed = await invoke<LocalAudioInput[]>("list_local_audio_inputs");
    return listed.filter((item) => item.kind === "jack" || item.kind === "bluetooth");
  }
  return browserInputs();
}

export async function refreshLocalAudioInputs(): Promise<LocalAudioInput[]> {
  if (!isTauri() && typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      /* The list still shows whatever the browser already labeled. */
    }
  }
  return listLocalAudioInputs();
}

export async function listenLocalAudio(deviceId: string): Promise<LocalAudioWindow> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawWindow>("listen_local_audio", {
    args: { deviceId },
  });
  const segments = (raw.segments ?? [])
    .map((segment, index) => ({
      id: segment.id || `seg-${index}`,
      startSec: typeof segment.startSec === "number" ? segment.startSec : 0,
      endSec: typeof segment.endSec === "number" ? segment.endSec : 0,
      text: segment.text ?? "",
    }))
    .filter((segment) => segment.text.trim());
  const status =
    raw.status === "ready" || raw.status === "needs-model" || raw.status === "empty" || raw.status === "error"
      ? raw.status
      : segments.length
        ? "ready"
        : "empty";
  return {
    engine: raw.engine === "local-whisper" ? "local-whisper" : "local-stub",
    status,
    note: raw.note ?? "",
    durationSec:
      typeof raw.durationSec === "number" && raw.durationSec > 0 ? raw.durationSec : LOCAL_AUDIO_WINDOW_SEC,
    segments,
    audioUrl: raw.audioBase64 ? wavObjectUrl(raw.audioBase64) : null,
  };
}

export function previewToneWav(): Uint8Array {
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
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.02 * 32767;
    view.setInt16(44 + i * 2, sample, true);
  }
  return new Uint8Array(buffer);
}

async function browserInputs(): Promise<LocalAudioInput[]> {
  const found: LocalAudioInput[] = [];
  if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const device of devices) {
        if (device.kind !== "audioinput") continue;
        const id = device.deviceId;
        const label = device.label || "";
        const kind = classifyLocalInput(id, label);
        if (!id || !kind || found.some((item) => item.id === id)) continue;
        found.push({
          id,
          label: label || (kind === "bluetooth" ? "Bluetooth input" : "Jack input"),
          kind,
        });
      }
    } catch {
      /* Permission can wait until Refresh. */
    }
  }
  return found.length ? found : PREVIEW_INPUTS;
}

function wavObjectUrl(base64: string): string | null {
  if (typeof atob !== "function" || typeof URL === "undefined" || typeof Blob === "undefined") return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

function roundSec(value: number): number {
  return Math.round(value * 10) / 10;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
