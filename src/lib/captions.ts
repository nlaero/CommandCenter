/**
 * Local / on-device captioning for Broadcastify Feed Owner (personal use).
 *
 * Prefer keeping archive audio on-device — do not upload clips to cloud ASR.
 * The desktop app runs the installed Tiny English model. Caption fixes sync
 * through the signed-in server and are applied to the text. Audio is not uploaded.
 */

import { applyCorrections, readLocalMemory } from "./aiMemory";

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
      "Local AI is not installed. Settings → Local AI downloads Tiny English onto this computer. Audio stays here.",
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
 * Request local transcription. The desktop app runs Tiny English when it is
 * installed. The browser preview applies the same caption fixes to placeholder text.
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
      // Fall through to the placeholder if this build has no local model command.
    }
  }
  await new Promise((r) => setTimeout(r, 350));
  return applyMemory(stubLocalCaptions(args.sourceUrl, args.clipId));
}

function applyMemory(result: CaptionResult): CaptionResult {
  const memory = readLocalMemory();
  return {
    ...result,
    segments: result.segments.map((segment) => ({
      ...segment,
      text: applyCorrections(segment.text, memory),
    })),
  };
}
