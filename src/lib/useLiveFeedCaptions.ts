import { useEffect, useRef, useState } from "react";
import { applyCorrections, type AiMemory } from "./aiMemory";
import {
  appendFeedCaptionWindow,
  closeFeedCaptionSession,
  correctFeedCaptionLines,
  isContinuousAudioStream,
  liveCaptionWindow,
  openFeedCaptionSession,
  type FeedCaptionLine,
} from "./feedCaptions";
import { captionFailureText, transcribeMediaLocal } from "./captions";
import { cleanCaptionText } from "./streamCaptions";

const RETRY_MS = 4_000;

export function useLiveFeedCaptions(options: {
  active: boolean;
  playing: boolean;
  sourceId: string;
  label: string;
  feedId: string;
  streamUrl: string;
  durationSec?: () => number | undefined;
}): {
  lines: FeedCaptionLine[];
  status: string | null;
  running: boolean;
  applyCorrection: (memory: AiMemory) => void;
} {
  const { active, playing, sourceId, label, feedId, streamUrl } = options;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const durationRef = useRef(options.durationSec);
  durationRef.current = options.durationSec;
  const generationRef = useRef(0);
  const [lines, setLines] = useState<FeedCaptionLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!active || !streamUrl.trim()) {
      setLines([]);
      setStatus(null);
      setRunning(false);
      return;
    }
    const generation = openFeedCaptionSession({ sourceId, label, feedId, streamUrl });
    generationRef.current = generation;
    setLines([]);
    let cancelled = false;
    let windowIndex = 0;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const loop = async () => {
      while (!cancelled) {
        if (!playingRef.current) {
          setRunning(false);
          await wait(300);
          continue;
        }
        const plan = liveCaptionWindow(streamUrl, windowIndex);
        if (!isContinuousAudioStream(streamUrl)) {
          const duration = durationRef.current?.();
          if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && plan.seekSec >= duration - 0.25) {
            setRunning(false);
            break;
          }
        }
        setRunning(true);
        setStatus((current) => current ?? "Creating captions on this device…");
        try {
          const result = await transcribeMediaLocal({
            sourceUrl: streamUrl,
            clipId: `${sourceId}-live-${windowIndex}`,
            timelineStart: plan.timelineStart,
            seekSec: plan.seekSec,
            durationSec: plan.durationSec,
          });
          if (cancelled || generationRef.current !== generation) return;
          if (result.status === "needs-model") {
            setRunning(false);
            setStatus(result.note);
            await wait(20_000);
            continue;
          }
          const segments = result.segments
            .map((segment) => ({ ...segment, text: cleanCaptionText(segment.text) }))
            .filter((segment) => segment.text);
          const heardAt = new Date().toISOString();
          const history = appendFeedCaptionWindow(
            sourceId,
            generation,
            `${sourceId}-live-${windowIndex}`,
            segments,
            heardAt,
          );
          if (history && !cancelled) {
            setLines(history.lines);
            setStatus(segments.length ? null : "No speech in that window.");
          }
          windowIndex += 1;
        } catch (err) {
          if (cancelled) return;
          const message = captionFailureText(err);
          setStatus(message);
          setRunning(false);
          await wait(RETRY_MS);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
      closeFeedCaptionSession(sourceId, generation);
    };
  }, [active, sourceId, label, feedId, streamUrl]);

  function applyCorrection(memory: AiMemory) {
    setLines((current) => {
      const next = current.map((line) => ({ ...line, text: applyCorrections(line.text, memory) }));
      correctFeedCaptionLines(
        sourceId,
        generationRef.current,
        next.map((line) => ({ id: line.id, text: line.text })),
      );
      return next;
    });
  }

  return { lines, status, running, applyCorrection };
}
