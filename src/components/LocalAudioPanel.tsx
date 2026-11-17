import { useEffect, useRef, useState } from "react";
import { applyCorrections, readLocalMemory } from "../lib/aiMemory";
import { captionFailureText } from "../lib/captionFailure";
import {
  LOCAL_AUDIO_WINDOW_SEC,
  PREVIEW_CAPTIONS,
  appendCaptionLines,
  captionFollowAfterScroll,
  captionListAtLatest,
  captionsWithMemory,
  classifyLocalInput,
  listenLocalAudio,
  localInputKindLabel,
  previewToneWav,
  type LocalCaptionLine,
} from "../lib/localAudio";
import { captionsVisible } from "../lib/streamCaptions";
import type { SourceConfig } from "../types";
import { CaptionCorrection } from "./LocalAiPanel";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function LocalAudioPanel({ sourceId, source }: Props) {
  const deviceId = String(source.params.deviceId ?? "").trim();
  const deviceLabel = String(source.params.deviceLabel ?? "").trim();
  const storedKind = String(source.params.inputKind ?? "");
  const kind =
    storedKind === "jack" || storedKind === "bluetooth"
      ? storedKind
      : classifyLocalInput(deviceId, deviceLabel || deviceId);
  const captionsOn = source.params.enableCaptions !== false;
  const desktop = isDesktop();
  const [muted, setMuted] = useState(true);
  const [ccOn, setCcOn] = useState(false);
  const [lines, setLines] = useState<LocalCaptionLine[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const linesRef = useRef<LocalCaptionLine[]>([]);
  const mutedRef = useRef(true);
  mutedRef.current = muted;
  const showCaptions = captionsOn && captionsVisible(muted, ccOn);
  const latest = lines[lines.length - 1] ?? null;

  useEffect(() => {
    setMuted(true);
    setCcOn(false);
  }, [deviceId, sourceId]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = muted;
    if (!muted) void el.play().catch(() => undefined);
  }, [muted, clipUrl]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !clipUrl) return;
    el.muted = mutedRef.current;
    void el.play().catch(() => undefined);
  }, [clipUrl]);

  useEffect(() => {
    linesRef.current = [];
    setLines([]);
    setStatus(null);
    setRunning(false);
    if (!deviceId || !kind) return;
    let cancelled = false;

    if (!desktop) {
      const tone = URL.createObjectURL(new Blob([previewToneWav()], { type: "audio/wav" }));
      setClipUrl(tone);
      let origin = 0;
      for (let index = 0; index < 16; index += 1) {
        const text = PREVIEW_CAPTIONS[index % PREVIEW_CAPTIONS.length] ?? "";
        const result = appendCaptionLines(
          linesRef.current,
          [{ text, startSec: 0, endSec: 3 }],
          origin,
          `${sourceId}-preview-${index}`,
          (value) => applyCorrections(value, readLocalMemory()),
        );
        linesRef.current = result.lines;
        origin += 4;
      }
      setLines(linesRef.current);
      let index = 16;
      const timer = window.setInterval(() => {
        if (cancelled) return;
        const text = PREVIEW_CAPTIONS[index % PREVIEW_CAPTIONS.length] ?? "";
        const origin = index * 4;
        const idPrefix = `${sourceId}-preview-${index}`;
        index += 1;
        setLines((current) => {
          const correct = (value: string) => applyCorrections(value, readLocalMemory());
          const result = appendCaptionLines(
            captionsWithMemory(current, correct),
            [{ text, startSec: 0, endSec: 3 }],
            origin,
            idPrefix,
            correct,
          );
          linesRef.current = result.lines;
          return result.lines;
        });
      }, 900);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
        URL.revokeObjectURL(tone);
      };
    }

    let cursor = 0;
    let windowIndex = 0;
    const owned: string[] = [];

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const loop = async () => {
      while (!cancelled) {
        setRunning(true);
        setStatus((current) => current ?? "Creating captions on this device…");
        try {
          const heard = await listenLocalAudio(deviceId);
          if (cancelled) return;
          if (heard.audioUrl) {
            owned.push(heard.audioUrl);
            setClipUrl((prev) => {
              if (prev && prev !== heard.audioUrl) URL.revokeObjectURL(prev);
              return heard.audioUrl;
            });
          }
          const origin = cursor;
          const idPrefix = `${sourceId}-live-${windowIndex}`;
          let added = 0;
          setLines((current) => {
            const correct = (value: string) => applyCorrections(value, readLocalMemory());
            const result = appendCaptionLines(
              captionsWithMemory(current, correct),
              heard.segments,
              origin,
              idPrefix,
              correct,
            );
            added = result.added;
            linesRef.current = result.lines;
            return result.lines;
          });
          cursor += heard.durationSec || LOCAL_AUDIO_WINDOW_SEC;
          windowIndex += 1;
          if (heard.status === "needs-model") {
            setRunning(false);
            setStatus(heard.note);
            await wait(20_000);
            continue;
          }
          if (heard.status === "error") {
            setRunning(false);
            setStatus(heard.note);
            await wait(4_000);
            continue;
          }
          setRunning(false);
          setStatus(added ? null : heard.note || "No speech in that window.");
        } catch (err) {
          if (cancelled) return;
          setRunning(false);
          setStatus(captionFailureText(err));
          await wait(4_000);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
      for (const url of owned) URL.revokeObjectURL(url);
    };
  }, [desktop, deviceId, kind, sourceId]);

  const empty =
    status && status !== "Creating captions on this device…"
      ? status
      : running || deviceId
        ? "Creating captions on this device…"
        : "Choose a jack or Bluetooth input in Settings.";

  return (
    <div className="incident-panel bcfy-panel local-audio-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          {kind ? localInputKindLabel(kind) : "Local audio"}
        </span>
        <span className="incident-meta">{deviceLabel || "No input selected"}</span>
        {captionsOn ? (
          <label className="bcfy-cc-toggle" title="Keep captions up after the sound is turned on">
            <input type="checkbox" checked={ccOn} onChange={(event) => setCcOn(event.target.checked)} />
            <span className={`bcfy-cc-badge${ccOn ? " on" : ""}`}>CC</span>
          </label>
        ) : null}
        <button
          type="button"
          className={`btn btn-ghost bcfy-mute${muted ? " is-muted" : ""}`}
          onClick={() => setMuted((value) => !value)}
          aria-pressed={muted}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted ? "Muted" : "Sound on"}
        </button>
      </div>
      <div className="incident-detail">
        <audio
          ref={audioRef}
          controls
          preload="auto"
          muted={muted}
          loop={!desktop}
          src={clipUrl ?? undefined}
          onVolumeChange={(event) => {
            const el = event.currentTarget;
            setMuted(el.muted || el.volume === 0);
          }}
        />
        <p className="bcfy-audio-hint">
          Starts muted. Unmute to hear the latest window. Captions keep running while the sound is off.
        </p>
        {showCaptions ? (
          <div className="bcfy-captions" aria-label="Captions">
            <div className="bcfy-captions-head">
              <div className="section-label" style={{ margin: 0 }}>
                Live captions
              </div>
            </div>
            <p className="bcfy-captions-note">
              {desktop
                ? "Heard on this computer with Tiny English. A fix stays here and applies the next time those words appear."
                : "Browser preview. The desktop app records this jack or Bluetooth input and captions it with Tiny English on this computer. A fix stays here and applies the next time those words appear."}
            </p>
            {latest ? (
              <div className="bcfy-caption-live" aria-live="polite">
                {latest.text}
              </div>
            ) : (
              <div className="bcfy-caption-live is-empty" aria-live="polite">
                {empty}
              </div>
            )}
            {latest && status ? <p className="bcfy-captions-note">{status}</p> : null}
            <CaptionHistory lines={lines} activeId={latest?.id ?? null} />
            {latest ? (
              <CaptionCorrection
                suggestion={latest.text}
                onSaved={(memory) => {
                  setLines((current) => {
                    const next = captionsWithMemory(current, (value) => applyCorrections(value, memory));
                    linesRef.current = next;
                    return next;
                  });
                }}
              />
            ) : null}
          </div>
        ) : (
          <p className="bcfy-captions-note">
            {captionsOn
              ? "Captions are hidden while the sound is on. Turn CC on to keep them up."
              : "Captions are off for this source. Turn Captions on in Settings."}
          </p>
        )}
      </div>
    </div>
  );
}

function CaptionHistory({ lines, activeId }: { lines: LocalCaptionLine[]; activeId: string | null }) {
  const ref = useRef<HTMLOListElement | null>(null);
  const programmatic = useRef(false);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !follow) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    window.setTimeout(() => {
      programmatic.current = false;
    }, 60);
  }, [lines, follow]);

  if (!lines.length) return null;

  return (
    <>
      <ol
        ref={ref}
        className="bcfy-caption-list bcfy-caption-history local-caption-list"
        aria-label="Caption lines"
        data-follow={follow ? "on" : "off"}
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(
            captionFollowAfterScroll({
              following: follow,
              userScrolled: !programmatic.current,
              atLatest: captionListAtLatest(el.scrollTop, el.scrollHeight, el.clientHeight),
            }),
          );
        }}
      >
        {lines.map((line) => (
          <li key={line.id} className={line.id === activeId ? "is-active" : undefined}>
            <span className="mono">{formatClock(line.startSec)}</span>
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
      {follow ? null : (
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setFollow(true)}
          >
            Latest
          </button>
        </div>
      )}
    </>
  );
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
