import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeCaptionAt,
  transcribeArchiveLocal,
  type CaptionResult,
  type CaptionSegment,
} from "../lib/captions";
import { fetchSourcePayload } from "../lib/api";
import type { Incident, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 60_000;
  const m = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "s") return Math.max(15_000, n * 1000);
  if (unit === "m") return Math.max(30_000, n * 60_000);
  return Math.max(60_000, n * 60 * 60_000);
}

function formatWhen(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityClass(severity?: Incident["severity"]): string {
  if (severity === "alert") return "sev-alert";
  if (severity === "warn") return "sev-warn";
  return "sev-info";
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function captionsEnabled(source: SourceConfig): boolean {
  return source.params.enableCaptions === true;
}

export function BroadcastifyPanel({ sourceId, source }: Props) {
  const configuredDay =
    typeof source.params.archiveDay === "string" ? source.params.archiveDay.trim() : "";
  const [day, setDay] = useState(configuredDay);
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [showCaptions, setShowCaptions] = useState(() => captionsEnabled(source));
  const [captionCache, setCaptionCache] = useState<Record<string, CaptionResult>>({});
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const captionsOn = captionsEnabled(source);

  useEffect(() => {
    setDay(configuredDay);
  }, [configuredDay]);

  useEffect(() => {
    setShowCaptions(captionsOn);
  }, [captionsOn]);

  const selected = useMemo(
    () => payload?.incidents.find((i) => i.id === selectedId) ?? null,
    [payload, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    let flashTimer: number | undefined;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const overrides: Record<string, unknown> = {};
        if (day.trim()) overrides.archiveDay = day.trim();
        const next = await fetchSourcePayload(sourceId, source, overrides);
        if (cancelled) return;
        const incoming: string[] = [];
        if (primed.current) {
          for (const item of next.incidents) {
            if (!knownIds.current.has(item.id)) incoming.push(item.id);
          }
        } else {
          primed.current = true;
        }
        knownIds.current = new Set(next.incidents.map((i) => i.id));
        setPayload(next);
        setError(null);
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          if (flashTimer) window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => setFlashIds(new Set()), 8_000);
          setSelectedId((cur) => cur ?? incoming[0]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(false);
    const ms = parseRefreshMs(source.refresh);
    const timer = window.setInterval(() => void load(true), ms);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (flashTimer) window.clearTimeout(flashTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), day]);

  const feed = payload?.feed;
  const list = payload?.incidents ?? [];

  function pickDayFromItem(item: Incident) {
    if (item.category === "archive-day") {
      const match = item.id.match(/^archive-day-(\d{4}-\d{2}-\d{2})$/);
      if (match) {
        setDay(match[1]);
        setSelectedId(null);
        return;
      }
    }
    setSelectedId(item.id);
  }

  async function runCaptions(item: Incident) {
    if (!item.audioUrl) return;
    setCaptionCache((prev) => ({
      ...prev,
      [item.id]: {
        engine: "local-stub",
        status: "running",
        sourceUrl: item.audioUrl!,
        segments: prev[item.id]?.segments ?? [],
        note: "Running local transcription…",
        generatedAt: new Date().toISOString(),
      },
    }));
    try {
      const result = await transcribeArchiveLocal({
        sourceUrl: item.audioUrl,
        clipId: item.id,
      });
      setCaptionCache((prev) => ({ ...prev, [item.id]: result }));
    } catch (err) {
      setCaptionCache((prev) => ({
        ...prev,
        [item.id]: {
          engine: "local-stub",
          status: "error",
          sourceUrl: item.audioUrl!,
          segments: [],
          note: err instanceof Error ? err.message : String(err),
          generatedAt: new Date().toISOString(),
        },
      }));
    }
  }

  return (
    <div className="incident-panel bcfy-panel">
      <div className="incident-toolbar">
        <span className={`incident-live${feed && !feed.online ? " is-offline" : ""}`}>
          <span className="live-dot" aria-hidden />
          {feed ? (feed.online ? "Feed online" : "Feed offline") : "Feed Owner"}
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {feed?.listeners != null ? `${feed.listeners} listening` : null}
          {payload ? ` · ${formatWhen(payload.fetchedAt)}` : null}
        </span>
        {captionsOn ? (
          <label className="bcfy-cc-toggle" title="Closed captions (local / on-device preferred)">
            <input
              type="checkbox"
              checked={showCaptions}
              onChange={(e) => setShowCaptions(e.target.checked)}
            />
            <span className={`bcfy-cc-badge${showCaptions ? " on" : ""}`}>CC</span>
          </label>
        ) : null}
        <label className="bcfy-day">
          <span>Day</span>
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            max={todayIso()}
          />
        </label>
        <button
          type="button"
          className="btn btn-ghost incident-refresh"
          onClick={() => {
            const overrides: Record<string, unknown> = {};
            if (day.trim()) overrides.archiveDay = day.trim();
            void fetchSourcePayload(sourceId, source, overrides)
              .then((next) => {
                setPayload(next);
                setError(null);
              })
              .catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="incident-layout">
        <div className="incident-feed" role="list" aria-label="Feed status and archives">
          {list.map((item) => {
            const isNew = flashIds.has(item.id);
            const active = selectedId === item.id;
            const hasCc = Boolean(captionCache[item.id]?.segments.length);
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className={`incident-alert ${severityClass(item.severity)}${
                  isNew ? " is-new" : ""
                }${active ? " is-active" : ""}`}
                onClick={() => pickDayFromItem(item)}
              >
                <div className="incident-alert-top">
                  <span className="incident-sev">
                    {item.category === "archive-day"
                      ? "day"
                      : item.category === "archive"
                        ? "archive"
                        : (item.severity ?? "status")}
                  </span>
                  <span className="incident-when">{formatWhen(item.occurredAt)}</span>
                </div>
                <div className="incident-alert-title">{item.title}</div>
                <div className="incident-alert-sub">
                  {item.address ?? item.description ?? item.category ?? "—"}
                  {item.audioUrl ? <span className="audio-tag">audio</span> : null}
                  {hasCc ? <span className="audio-tag cc-tag">cc</span> : null}
                </div>
              </button>
            );
          })}
          {!loading && payload && list.length === 0 ? (
            <p className="incident-empty">No feed/archive rows returned.</p>
          ) : null}
        </div>

        <div className="incident-side">
          <div className="incident-map bcfy-status" aria-label="Feed status">
            {feed ? (
              <div className="bcfy-status-card">
                <div className={`bcfy-pill${feed.online ? " on" : " off"}`}>
                  {feed.online ? "ONLINE" : "OFFLINE"}
                </div>
                <div className="bcfy-status-title">
                  {feed.descr ?? `Feed ${feed.feedId}`}
                </div>
                <div className="bcfy-status-meta">
                  <span>ID {feed.feedId}</span>
                  {feed.genre ? <span>{feed.genre}</span> : null}
                  {feed.bitrate != null ? <span>{feed.bitrate} kbps</span> : null}
                  {feed.county || feed.state ? (
                    <span>
                      {[feed.county, feed.state].filter(Boolean).join(", ")}
                    </span>
                  ) : null}
                  {captionsOn ? <span>captions on</span> : null}
                </div>
              </div>
            ) : (
              <div className="incident-map-empty">Awaiting feed status…</div>
            )}
          </div>

          <div className="incident-detail">
            {selected ? (
              <ArchiveDetail
                item={selected}
                onPickDay={pickDayFromItem}
                captionsEnabled={captionsOn && showCaptions}
                caption={captionCache[selected.id] ?? null}
                onTranscribe={() => void runCaptions(selected)}
              />
            ) : (
              <p className="incident-empty">
                Select a status or archive row
                {day ? ` for ${day}` : " (or pick a day to load clips)"}.
              </p>
            )}
          </div>
        </div>
      </div>

      {payload?.attribution ? (
        <footer className="incident-footer" title={payload.note ?? undefined}>
          {payload.attribution}
          {payload.note ? ` · ${payload.note}` : null}
        </footer>
      ) : null}
    </div>
  );
}

function ArchiveDetail({
  item,
  onPickDay,
  captionsEnabled,
  caption,
  onTranscribe,
}: {
  item: Incident;
  onPickDay: (item: Incident) => void;
  captionsEnabled: boolean;
  caption: CaptionResult | null;
  onTranscribe: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [timeSec, setTimeSec] = useState(0);
  const [muted, setMuted] = useState(true);
  const active = caption ? activeCaptionAt(caption.segments, timeSec) : null;

  // Global product rule: audio starts muted on open (each clip selection).
  useEffect(() => {
    setMuted(true);
    setTimeSec(0);
    const el = audioRef.current;
    if (el) {
      el.muted = true;
      el.pause();
      el.currentTime = 0;
    }
  }, [item.id, item.audioUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  return (
    <div>
      <div className={`incident-sev ${severityClass(item.severity)}`}>
        {item.category ?? item.severity ?? "info"}
      </div>
      <h4 className="incident-detail-title">{item.title}</h4>
      <dl className="incident-dl">
        {item.occurredAt ? (
          <>
            <dt>When</dt>
            <dd>{formatWhen(item.occurredAt)}</dd>
          </>
        ) : null}
        {item.category ? (
          <>
            <dt>Kind</dt>
            <dd>{item.category}</dd>
          </>
        ) : null}
        {item.address ? (
          <>
            <dt>Day</dt>
            <dd className="mono">{item.address}</dd>
          </>
        ) : null}
        {item.description ? (
          <>
            <dt>Detail</dt>
            <dd>{item.description}</dd>
          </>
        ) : null}
        <dt>Id</dt>
        <dd className="mono">{item.id}</dd>
      </dl>
      {item.category === "archive-day" ? (
        <button type="button" className="btn btn-primary" onClick={() => onPickDay(item)}>
          Load clips for this day
        </button>
      ) : null}
      {item.audioUrl ? (
        <div className="incident-audio">
          <div className="bcfy-audio-head">
            <div className="section-label" style={{ margin: 0 }}>
              Archive audio (personal use only)
            </div>
            <button
              type="button"
              className={`btn btn-ghost bcfy-mute${muted ? " is-muted" : ""}`}
              onClick={() => setMuted((m) => !m)}
              aria-pressed={muted}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "Muted" : "Sound on"}
            </button>
          </div>
          <audio
            ref={audioRef}
            controls
            preload="none"
            muted={muted}
            src={item.audioUrl}
            onVolumeChange={(e) => {
              // Keep React state in sync if the user toggles mute via native controls.
              setMuted(e.currentTarget.muted || e.currentTarget.volume === 0);
            }}
            onTimeUpdate={(e) => setTimeSec(e.currentTarget.currentTime)}
          >
            <a href={item.audioUrl} target="_blank" rel="noreferrer">
              Open audio
            </a>
          </audio>
          <p className="bcfy-audio-hint">Starts muted on open — unmute explicitly to hear audio.</p>
        </div>
      ) : null}

      {captionsEnabled && item.audioUrl ? (
        <CaptionsPane
          caption={caption}
          active={active}
          busy={caption?.status === "running"}
          onTranscribe={onTranscribe}
        />
      ) : null}

      {!captionsEnabled && item.audioUrl ? (
        <p className="bcfy-captions-note" style={{ marginTop: 12 }}>
          Closed captions are off for this source. Enable <strong>Captions / transcription</strong> in
          Settings (required capability for audio sources).
        </p>
      ) : null}

      {item.detailUrl ? (
        <a className="incident-link" href={item.detailUrl} target="_blank" rel="noreferrer">
          Open link
        </a>
      ) : null}
    </div>
  );
}

function CaptionsPane({
  caption,
  active,
  busy,
  onTranscribe,
}: {
  caption: CaptionResult | null;
  active: CaptionSegment | null;
  busy: boolean;
  onTranscribe: () => void;
}) {
  return (
    <div className="bcfy-captions" aria-label="Captions">
      <div className="bcfy-captions-head">
        <div className="section-label" style={{ margin: 0 }}>
          Captions
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={onTranscribe}
        >
          {busy ? "Transcribing…" : caption?.segments.length ? "Re-run local" : "Transcribe local"}
        </button>
      </div>
      <p className="bcfy-captions-note">
        {caption?.note ??
          "Local/on-device preferred for personal use. Whisper sidecar not bundled yet — offline stub first (no cloud upload)."}
      </p>
      {active ? (
        <div className="bcfy-caption-live" aria-live="polite">
          {active.text}
        </div>
      ) : (
        <div className="bcfy-caption-live is-empty">
          {caption?.segments.length
            ? "Play audio to follow captions…"
            : "Run local transcription to generate captions for this clip."}
        </div>
      )}
      {caption?.segments.length ? (
        <ol className="bcfy-caption-list">
          {caption.segments.map((seg) => (
            <li
              key={seg.id}
              className={active?.id === seg.id ? "is-active" : undefined}
            >
              <span className="mono">
                {formatClock(seg.startSec)}–{formatClock(seg.endSec)}
              </span>
              <span>{seg.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
