/**
 * Playback for the Broadcastify Feed Owner panel.
 *
 * The relay starts muted. Unmute has to play inside the click, and a stuck
 * volume of 0 is not treated as a mute. A live relay that the audio element
 * cannot play is decoded on this computer and played in short windows.
 */

export const DIRECT_START_SEC = 0.2;
export const DIRECT_WAIT_MS = 2_000;
export const RELAY_WINDOW_SEC = 2;

export function desktopPlayback(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function applyFeedSound(
  el: { muted: boolean; volume: number; play: () => Promise<unknown> },
  hear: boolean,
): void {
  if (!hear) {
    el.muted = true;
    return;
  }
  el.muted = false;
  if (el.volume === 0) el.volume = 1;
  void Promise.resolve(el.play()).catch(() => undefined);
}

/** A zero volume after unmute is a stuck control. The mute flag is the control. */
export function nextFeedMute(el: { muted: boolean; volume: number }): {
  muted: boolean;
  volume: number;
} {
  if (!el.muted && el.volume === 0) return { muted: false, volume: 1 };
  return { muted: el.muted, volume: el.volume };
}

export function directStreamStarted(
  baseline: number,
  currentTime: number,
  errored: boolean,
): boolean {
  if (errored) return false;
  return currentTime >= baseline + DIRECT_START_SEC;
}

export async function watchDirectPlayback(options: {
  sample: () => { currentTime: number; errored: boolean };
  baseline: number;
  waitMs: number;
  cancelled: () => boolean;
}): Promise<"started" | "failed" | "cancelled"> {
  const startedAt = Date.now();
  while (!options.cancelled()) {
    const sample = options.sample();
    if (directStreamStarted(options.baseline, sample.currentTime, sample.errored)) {
      return "started";
    }
    if (sample.errored || Date.now() - startedAt >= options.waitMs) return "failed";
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return "cancelled";
}

/** Read the next window while the current one plays, so the relay does not go quiet between slices. */
export async function playDecodedWindows(options: {
  read: () => Promise<Uint8Array>;
  play: (bytes: Uint8Array) => Promise<void>;
  live: () => boolean;
}): Promise<void> {
  let pending: Promise<Uint8Array> | null = null;
  while (options.live()) {
    if (!pending) pending = options.read();
    let bytes: Uint8Array;
    try {
      bytes = await pending;
    } catch {
      pending = null;
      if (!options.live()) return;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    if (!options.live()) return;
    pending = options.read();
    try {
      await options.play(bytes);
    } catch {
      if (!options.live()) return;
    }
  }
}

export function playbackErrorText(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err && typeof err.message === "string"
          ? err.message
          : "";
  if (!raw.trim()) return "Couldn't play the relay.";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // The command already returned plain text.
  }
  return raw.trim();
}

export async function readRelayWindow(url: string, durationSec: number): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  let raw: { wavBase64?: string };
  try {
    raw = await invoke<{ wavBase64?: string }>("relay_playback_window", {
      args: { sourceUrl: url, durationSec },
    });
  } catch (err) {
    throw new Error(playbackErrorText(err));
  }
  const encoded = raw.wavBase64?.trim() ?? "";
  if (!encoded) throw new Error("The relay did not send audio this player can use.");
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
