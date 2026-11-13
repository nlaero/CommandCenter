/**
 * Local / on-device captioning for Broadcastify Feed Owner (personal use).
 *
 * Prefer keeping archive audio on-device — do not upload clips to cloud ASR.
 * Full whisper.cpp (or similar) sidecar is not bundled yet; this module exposes
 * a stable API plus an offline stub so the panel UI can ship first.
 */

export type CaptionSegment = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
};

export type CaptionJobStatus = "idle" | "running" | "ready" | "error" | "stub";

export type CaptionResult = {
  engine: "local-stub" | "local-whisper";
  status: CaptionJobStatus;
  sourceUrl: string;
  segments: CaptionSegment[];
  note: string;
  generatedAt: string;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Deterministic stub segments for UI / smoke (no model download). */
export function stubLocalCaptions(sourceUrl: string, clipId: string): CaptionResult {
  const seed = clipId.length + sourceUrl.length;
  const base = [
    "Dispatch, unit responding.",
    "Traffic holding on the main.",
    "Copy, standing by.",
    "Clear the last.",
  ];
  const segments: CaptionSegment[] = base.map((text, i) => {
    const startSec = i * 8 + (seed % 3);
    return {
      id: `${clipId}-seg-${i}`,
      startSec,
      endSec: startSec + 7,
      text,
    };
  });
  return {
    engine: "local-stub",
    status: "stub",
    sourceUrl,
    segments,
    note:
      "Offline stub captions (personal use). On-device Whisper/local ASR not bundled yet — audio stays local; no cloud upload.",
    generatedAt: new Date().toISOString(),
  };
}

export function activeCaptionAt(
  segments: CaptionSegment[],
  timeSec: number,
): CaptionSegment | null {
  return (
    segments.find((s) => timeSec >= s.startSec && timeSec < s.endSec) ?? null
  );
}

/**
 * Request local transcription. Today: Tauri stub command or browser fixture.
 * Future: same entry point will call whisper.cpp / local ASR without leaving device.
 */
export async function transcribeArchiveLocal(args: {
  sourceUrl: string;
  clipId: string;
}): Promise<CaptionResult> {
  if (!args.sourceUrl.trim()) {
    throw new Error("audio URL required for transcription");
  }
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<CaptionResult>("transcribe_audio_local", {
        args: {
          sourceUrl: args.sourceUrl,
          clipId: args.clipId,
        },
      });
    } catch {
      // Fall through to identical stub if command unavailable in older builds.
    }
  }
  // Simulate a short local job so the panel shows running → ready.
  await new Promise((r) => setTimeout(r, 350));
  return stubLocalCaptions(args.sourceUrl, args.clipId);
}
