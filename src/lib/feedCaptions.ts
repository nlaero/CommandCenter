/**
 * Live caption history for the Broadcastify Feed Owner panel.
 *
 * The panel writes one window at a time while its feed plays. A nearby
 * public-safety source can select that feed as an audio input and read the
 * windows it has not seen yet. `streamUrl` is the relay listen URL with any
 * userinfo or password query removed, so another reader can use the audio
 * later. Caption fixes stay in the local caption store; this history only
 * keeps the corrected words.
 */

import { isPennHillsPreset, PENN_HILLS_FEED } from "./broadcastifyPreset.ts";

export const FEED_OWNER_INPUT_PREFIX = "feed-owner:";

const MAX_LINES = 120;

export type FeedCaptionLine = {
  id: string;
  /** Groups phrases that were heard in one transcription window. */
  windowId: string;
  seq: number;
  startSec: number;
  endSec: number;
  text: string;
  heardAt: string;
};

export type FeedCaptionHistory = {
  sourceId: string;
  label: string;
  feedId: string;
  streamUrl: string;
  lines: FeedCaptionLine[];
  updatedAt: string;
  revision: number;
  generation: number;
};

export type FeedCaptionWindow = {
  id: string;
  lines: FeedCaptionLine[];
};

export type TakenFeedCaptions = {
  state: "closed" | "idle" | "ready";
  note: string;
  streamUrl: string;
  windows: FeedCaptionWindow[];
};

type Session = FeedCaptionHistory & { nextSeq: number };

type Cursor = { generation: number; seq: number };

const CLOSED_NOTE =
  "Open the Feed Owner panel. Its live captions are read here while that feed plays.";

const READY_NOTE = "Captions from the Feed Owner panel. Audio stays on this computer.";

const sessions = new Map<string, Session>();
const cursors = new Map<string, Cursor>();
const listeners = new Set<() => void>();
let generationClock = 0;

export function feedOwnerInputId(sourceId: string): string {
  return `${FEED_OWNER_INPUT_PREFIX}${sourceId}`;
}

export function parseFeedOwnerInputId(deviceId: string): string | null {
  const trimmed = deviceId.trim();
  if (!trimmed.startsWith(FEED_OWNER_INPUT_PREFIX)) return null;
  const sourceId = trimmed.slice(FEED_OWNER_INPUT_PREFIX.length);
  if (!sourceId || sourceId.length > 80 || /\s/.test(sourceId)) return null;
  return sourceId;
}

export function isFeedOwnerAudio(feed: { kind: string; deviceId: string }): boolean {
  return feed.kind === "audio-in" && parseFeedOwnerInputId(feed.deviceId) !== null;
}

/** Continuous relay audio is captured from "now". A file is seeked window by window. */
export function isContinuousAudioStream(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return !/\.(mp3|m4a|aac|wav|ogg|flac|mp4|webm|m4v)$/.test(path);
  } catch {
    return true;
  }
}

export function liveCaptionWindow(
  url: string,
  index: number,
): { seekSec: number; timelineStart: number; durationSec: number } {
  const durationSec = 12;
  const start = Math.max(0, index) * durationSec;
  if (isContinuousAudioStream(url)) return { seekSec: 0, timelineStart: start, durationSec };
  return { seekSec: start, timelineStart: start, durationSec };
}

/** Relay listen URL safe to hand to another source. Credentials never stay on it. */
export function publicStreamUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key === "u" || key === "p" || /pass|token|secret|key|auth/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

export function broadcastifyAudioInputs(
  sources: Record<string, { type: string; params?: Record<string, unknown> } | undefined>,
): { id: string; label: string }[] {
  const inputs: { id: string; label: string }[] = [];
  for (const [sourceId, source] of Object.entries(sources)) {
    if (!source || source.type !== "broadcastify.owner") continue;
    const params = source.params ?? {};
    const feedId = String(params.feedId ?? "").trim();
    const name = isPennHillsPreset(params)
      ? PENN_HILLS_FEED.name
      : feedId
        ? `Feed ${feedId}`
        : "Broadcastify feed";
    inputs.push({
      id: feedOwnerInputId(sourceId),
      label: `${name} · captions`,
    });
  }
  return inputs.sort((a, b) => a.label.localeCompare(b.label));
}

export function subscribeFeedCaptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readFeedCaptionHistory(sourceId: string): FeedCaptionHistory | null {
  const session = sessions.get(sourceId);
  if (!session) return null;
  return snapshot(session);
}

export function openFeedCaptionSession(input: {
  sourceId: string;
  label: string;
  feedId: string;
  streamUrl: string;
}): number {
  const streamUrl = publicStreamUrl(input.streamUrl);
  const existing = sessions.get(input.sourceId);
  if (
    existing &&
    existing.feedId === input.feedId &&
    existing.streamUrl === streamUrl &&
    existing.label === input.label
  ) {
    return existing.generation;
  }
  generationClock += 1;
  const session: Session = {
    generation: generationClock,
    sourceId: input.sourceId,
    label: input.label,
    feedId: input.feedId,
    streamUrl,
    lines: [],
    updatedAt: new Date().toISOString(),
    revision: 0,
    nextSeq: 1,
  };
  sessions.set(input.sourceId, session);
  notify();
  return session.generation;
}

export function appendFeedCaptionWindow(
  sourceId: string,
  generation: number,
  windowId: string,
  segments: { id: string; startSec: number; endSec: number; text: string }[],
  heardAt: string,
): FeedCaptionHistory | null {
  const session = sessions.get(sourceId);
  if (!session || session.generation !== generation) return null;
  const clean = segments
    .map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ").trim() }))
    .filter((segment) => segment.text);
  if (!clean.length) return snapshot(session);
  for (const segment of clean) {
    session.lines.push({
      id: segment.id,
      windowId,
      seq: session.nextSeq,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      heardAt,
    });
    session.nextSeq += 1;
  }
  if (session.lines.length > MAX_LINES) {
    session.lines.splice(0, session.lines.length - MAX_LINES);
  }
  session.revision += 1;
  session.updatedAt = heardAt;
  notify();
  return snapshot(session);
}

export function correctFeedCaptionLines(
  sourceId: string,
  generation: number,
  lines: { id: string; text: string }[],
): FeedCaptionHistory | null {
  const session = sessions.get(sourceId);
  if (!session || session.generation !== generation) return null;
  const next = new Map(lines.map((line) => [line.id, line.text.replace(/\s+/g, " ").trim()]));
  let changed = false;
  session.lines = session.lines.map((line) => {
    const text = next.get(line.id);
    if (text == null || text === line.text) return line;
    changed = true;
    return { ...line, text };
  });
  if (!changed) return snapshot(session);
  session.revision += 1;
  session.updatedAt = new Date().toISOString();
  notify();
  return snapshot(session);
}

export function closeFeedCaptionSession(sourceId: string, generation?: number): void {
  const session = sessions.get(sourceId);
  if (!session) return;
  if (generation != null && session.generation !== generation) return;
  sessions.delete(sourceId);
  notify();
}

/**
 * Windows this consumer has not read. Idle means the panel is open and
 * nothing new arrived. Closed means the panel is not publishing.
 */
export function takeFeedCaptionWindows(consumerKey: string, sourceId: string): TakenFeedCaptions {
  const session = sessions.get(sourceId);
  if (!session) {
    return { state: "closed", note: CLOSED_NOTE, streamUrl: "", windows: [] };
  }
  const key = `${consumerKey}:${sourceId}`;
  const cursor = cursors.get(key);
  const fresh =
    cursor && cursor.generation === session.generation
      ? session.lines.filter((line) => line.seq > cursor.seq)
      : [...session.lines];
  const lastSeq = session.lines.reduce((max, line) => Math.max(max, line.seq), 0);
  cursors.set(key, { generation: session.generation, seq: lastSeq });
  if (!fresh.length) {
    return { state: "idle", note: "", streamUrl: session.streamUrl, windows: [] };
  }
  const windows: FeedCaptionWindow[] = [];
  for (const line of fresh) {
    const last = windows[windows.length - 1];
    if (last && last.id === line.windowId) last.lines.push(line);
    else windows.push({ id: line.windowId, lines: [line] });
  }
  return { state: "ready", note: READY_NOTE, streamUrl: session.streamUrl, windows };
}

export function resetFeedCaptionsForTests(): void {
  sessions.clear();
  cursors.clear();
  listeners.clear();
  generationClock = 0;
}

function snapshot(session: Session): FeedCaptionHistory {
  return {
    generation: session.generation,
    sourceId: session.sourceId,
    label: session.label,
    feedId: session.feedId,
    streamUrl: session.streamUrl,
    lines: session.lines.map((line) => ({ ...line })),
    updatedAt: session.updatedAt,
    revision: session.revision,
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}
