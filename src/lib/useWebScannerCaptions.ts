import { useEffect, useRef, useState } from "react";
import { applyCorrections, type AiMemory } from "./aiMemory";
import { captionFailureText, transcribeMediaLocal } from "./captions";
import { cleanCaptionText } from "./streamCaptions";
import { scannerCaptionWindow, type ScannerPlayback } from "./webScanner";

const RETRY_MS = 4_000;
const MAX_LINES = 120;

export type ScannerCaptionLine = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
};

/**
 * On-device captions for a web scanner stream.
 * Lines stay in this panel. They are not written to the Feed Owner caption
 * history that nearby alerts read.
 */
export function useWebScannerCaptions(options: {
  active: boolean;
  streamUrl: string;
  sourceId: string;
  playback: ScannerPlayback;
  durationSec?: () => number | undefined;
}): {
  lines: ScannerCaptionLine[];
  status: string | null;
  running: boolean;
  applyCorrection: (memory: AiMemory) => void;
} {
  const { active, streamUrl, sourceId, playback } = options;
  const activeRef = useRef(active);
  activeRef.current = active;
  const durationRef = useRef(options.durationSec);
  durationRef.current = options.durationSec;
  const linesRef = useRef<ScannerCaptionLine[]>([]);
  const [lines, setLines] = useState<ScannerCaptionLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  function publish(next: ScannerCaptionLine[]) {
    linesRef.current = next;
    setLines(next);
  }

  useEffect(() => {
    linesRef.current = [];
    setLines([]);
    setStatus(null);
    setRunning(false);
    if (!streamUrl.trim() || playback === "hls") return;

    let cancelled = false;
    let windowIndex = 0;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const loop = async () => {
      while (!cancelled) {
        if (!activeRef.current) {
          setRunning(false);
          await wait(300);
          continue;
        }
        const plan = scannerCaptionWindow(streamUrl, windowIndex);
        if (playback === "file") {
          const duration = durationRef.current?.();
          if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
            if (windowIndex > 0) {
              await wait(300);
              continue;
            }
          } else if (plan.seekSec >= duration - 0.25) {
            setRunning(false);
            break;
          }
        }
        setRunning(true);
        setStatus("Creating captions on this device…");
        try {
          const result = await transcribeMediaLocal({
            sourceUrl: streamUrl,
            clipId: `${sourceId}-scanner-${windowIndex}`,
            timelineStart: plan.timelineStart,
            seekSec: plan.seekSec,
            durationSec: plan.durationSec,
          });
          if (cancelled) return;
          if (result.status === "needs-model") {
            setRunning(false);
            setStatus(result.note);
            await wait(20_000);
            continue;
          }
          const segments = result.segments
            .map((segment, index) => ({
              id: `${sourceId}-w${windowIndex}-${segment.id || index}`,
              startSec: segment.startSec,
              endSec: segment.endSec,
              text: cleanCaptionText(segment.text),
            }))
            .filter((segment) => segment.text);
          if (!segments.length) {
            setStatus(linesRef.current.length ? null : "No speech in that window.");
          } else {
            const next = [...linesRef.current, ...segments];
            publish(next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next);
            setStatus(null);
          }
          windowIndex += 1;
        } catch (err) {
          if (cancelled) return;
          setStatus(captionFailureText(err));
          setRunning(false);
          await wait(RETRY_MS);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
    };
  }, [streamUrl, sourceId, playback]);

  function applyCorrection(memory: AiMemory) {
    const next = linesRef.current.map((line) => ({
      ...line,
      text: applyCorrections(line.text, memory),
    }));
    publish(next);
  }

  return { lines, status, running, applyCorrection };
}
