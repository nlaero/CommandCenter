import { useEffect, useRef, useState, type RefObject } from "react";
import { applyCorrections, type AiMemory } from "../lib/aiMemory";
import { CaptionCorrection } from "./LocalAiPanel";
import { captionsVisible } from "../lib/streamCaptions";
import { playHlsAudio } from "../lib/scannerHls";
import { useStreamCaptions } from "../lib/useStreamCaptions";
import {
  useWebScannerCaptions,
  type ScannerCaptionLine,
} from "../lib/useWebScannerCaptions";
import {
  normalizeWebScannerUrl,
  scannerPlayback,
  streamHost,
  webScannerUrlError,
  type ScannerPlayback,
} from "../lib/webScanner";
import type { SourceConfig } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

function textParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function WebScannerPanel({ sourceId, source }: Props) {
  const rawUrl = textParam(source.params.url);
  const label = textParam(source.params.label) || "Web scanner";
  const captionsEnabled = source.params.enableCaptions !== false;
  const urlError = !rawUrl ? "Add a stream link in Settings." : webScannerUrlError(rawUrl);
  const streamUrl = urlError ? "" : normalizeWebScannerUrl(rawUrl);
  const playback: ScannerPlayback = streamUrl ? scannerPlayback(streamUrl) : "live";
  const [muted, setMuted] = useState(true);
  const [ccOn, setCcOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hlsLines, setHlsLines] = useState<ScannerCaptionLine[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsSeq = useRef(0);
  const showCaptions = Boolean(streamUrl) && captionsEnabled && captionsVisible(muted, ccOn);
  const generated = useStreamCaptions({
    show: showCaptions && playback === "hls",
    kind: playback === "hls" ? "hls" : null,
    url: playback === "hls" ? streamUrl : "",
    videoRef: audioRef as unknown as RefObject<HTMLVideoElement | null>,
  });
  const scanned = useWebScannerCaptions({
    active: showCaptions && playback !== "hls",
    streamUrl: playback === "hls" ? "" : streamUrl,
    sourceId,
    playback,
    durationSec: () => audioRef.current?.duration,
  });

  useEffect(() => {
    setMuted(true);
    setError(null);
    setHlsLines([]);
    const audio = audioRef.current;
    if (!audio || !streamUrl || playback === "hls") return;
    audio.muted = true;
    void audio.play().catch(() => undefined);
  }, [streamUrl, playback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || playback !== "hls" || !streamUrl) return;
    audio.muted = true;
    return playHlsAudio(audio, streamUrl, (message) => setError(message));
  }, [streamUrl, playback]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = muted;
    if (!muted && audio.volume === 0) audio.volume = 1;
  }, [muted, streamUrl, playback]);

  useEffect(() => {
    const text = generated.text?.trim();
    if (!text || playback !== "hls") return;
    setHlsLines((current) => {
      const last = current[current.length - 1];
      if (last?.text === text) return current;
      hlsSeq.current += 1;
      const time = audioRef.current?.currentTime ?? 0;
      const next = [
        ...current,
        { id: `hls-${hlsSeq.current}`, startSec: time, endSec: time, text },
      ];
      return next.length > 120 ? next.slice(next.length - 120) : next;
    });
  }, [generated.text, playback]);

  const lines = playback === "hls" ? hlsLines : scanned.lines;
  const status = playback === "hls" ? generated.status : scanned.status;
  const latest = lines[lines.length - 1] ?? null;

  function applyCorrection(memory: AiMemory) {
    if (playback === "hls") {
      setHlsLines((current) =>
        current.map((line) => ({ ...line, text: applyCorrections(line.text, memory) })),
      );
      return;
    }
    scanned.applyCorrection(memory);
  }

  return (
    <div className="incident-panel scanner-panel" data-scanner="web" data-muted={muted ? "true" : "false"}>
      <div className="incident-toolbar">
        <span className={`incident-live${error ? " is-offline" : ""}`}>
          <span className="live-dot" aria-hidden />
          {error ? "Offline" : "Live"}
        </span>
        <span className="incident-meta">{streamUrl ? streamHost(streamUrl) : "No stream"}</span>
        {captionsEnabled && streamUrl ? (
          <label className="bcfy-cc-toggle" title="Keep captions up after the sound is turned on">
            <input
              type="checkbox"
              checked={ccOn}
              onChange={(event) => setCcOn(event.target.checked)}
              aria-label="Closed captions"
            />
            <span className={`bcfy-cc-badge${ccOn ? " on" : ""}`}>CC</span>
          </label>
        ) : null}
      </div>
      <div className="incident-detail">
        <h4 className="incident-detail-title">{label}</h4>
        {urlError ? (
          <p className="bcfy-audio-hint" role="status">
            {urlError}
          </p>
        ) : (
          <div className="incident-audio">
            <div className="bcfy-audio-head">
              <div className="section-label" style={{ margin: 0 }}>
                Stream
              </div>
              <button
                type="button"
                className={`btn btn-ghost bcfy-mute${muted ? " is-muted" : ""}`}
                onClick={() => setMuted((current) => !current)}
                aria-pressed={muted}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? "Muted" : "Sound on"}
              </button>
            </div>
            <audio
              ref={audioRef}
              src={playback === "hls" ? undefined : streamUrl}
              controls
              autoPlay
              preload="none"
              muted={muted}
              aria-label={label}
              onVolumeChange={(event) => {
                const el = event.currentTarget;
                setMuted(el.muted || el.volume === 0);
              }}
              onError={() => {
                if (playback === "hls") return;
                const audio = audioRef.current;
                if (!audio?.currentSrc) return;
                setError("Couldn't play that stream. Paste a direct audio link, not a web page.");
              }}
            />
            <p className="bcfy-audio-hint">
              Starts muted. Captions are written on this computer while the sound is off. CC keeps
              them up after you turn the sound on. This window is not Feed Owner and it does not
              feed nearby alerts.
            </p>
            {error ? (
              <p className="bcfy-audio-hint" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        )}

        {showCaptions ? (
          <Captions
            lines={lines}
            latest={latest}
            status={status}
            onCorrect={applyCorrection}
          />
        ) : null}

        {!captionsEnabled && streamUrl ? (
          <p className="bcfy-captions-note" style={{ marginTop: 12 }}>
            Closed captions are off for this source. Turn on <strong>Captions</strong> in Settings.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Captions({
  lines,
  latest,
  status,
  onCorrect,
}: {
  lines: ScannerCaptionLine[];
  latest: ScannerCaptionLine | null;
  status: string | null;
  onCorrect: (memory: AiMemory) => void;
}) {
  const placeholder =
    status && status !== "Creating captions on this device…"
      ? status
      : "Creating captions on this device…";
  return (
    <div className="bcfy-captions" aria-label="Captions">
      <div className="bcfy-captions-head">
        <div className="section-label" style={{ margin: 0 }}>
          Captions
        </div>
      </div>
      <p className="bcfy-captions-note">
        Heard on this computer. They show while the sound is off, and while CC is on. Earlier lines stay in the list.
      </p>
      {latest ? (
        <div className="bcfy-caption-live" aria-live="polite">
          {latest.text}
        </div>
      ) : (
        <div className="bcfy-caption-live is-empty" aria-live="polite">
          {placeholder}
        </div>
      )}
      {latest && status && status !== "Creating captions on this device…" ? (
        <p className="bcfy-captions-note">{status}</p>
      ) : null}
      <CaptionHistory lines={lines} activeId={latest?.id ?? null} />
      {latest ? <CaptionCorrection suggestion={latest.text} onSaved={onCorrect} /> : null}
    </div>
  );
}

function CaptionHistory({ lines, activeId }: { lines: ScannerCaptionLine[]; activeId: string | null }) {
  const ref = useRef<HTMLOListElement | null>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  if (!lines.length) return null;
  return (
    <>
      <ol
        ref={ref}
        className="bcfy-caption-list bcfy-caption-history"
        aria-label="Earlier captions"
        onScroll={(event) => {
          const el = event.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          setFollow(distance < 24);
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
          <button type="button" className="btn btn-ghost" onClick={() => setFollow(true)}>
            Latest
          </button>
        </div>
      )}
    </>
  );
}
