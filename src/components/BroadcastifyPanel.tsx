import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeCaptionAt,
  captionFailureText,
  transcribeArchiveLocal,
  type CaptionResult,
  type CaptionSegment,
} from "../lib/captions";
import type { FeedCaptionLine } from "../lib/feedCaptions";
import { captionsVisible } from "../lib/streamCaptions";
import { useLiveFeedCaptions } from "../lib/useLiveFeedCaptions";
import { CaptionCorrection, withCorrections } from "./LocalAiPanel";
import { useAlerts } from "../lib/alerts";
import { incidentsToBoardAlerts } from "../lib/boardAlerts";
import { isPennHillsPreset, PENN_HILLS_FEED } from "../lib/broadcastifyPreset";
import { fetchSourcePayload } from "../lib/api";
import type { AiMemory } from "../lib/aiMemory";
import type { Incident, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  /** Bumped when Settings saves this source — forces an immediate refetch. */
  configRevision?: number;
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
  return source.params.enableCaptions !== false;
}

export function BroadcastifyPanel({ sourceId, source, configRevision = 0 }: Props) {
  const configuredDay =
    typeof source.params.archiveDay === "string" ? source.params.archiveDay.trim() : "";
  const [day, setDay] = useState(configuredDay);
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [ccOn, setCcOn] = useState(false);
  const [captionCache, setCaptionCache] = useState<Record<string, CaptionResult>>({});
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  const captionsOn = captionsEnabled(source);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();

  function publishIncidents(next: SourcePayload) {
    // Archive clips can surface in the alerts pane. Feed status stays on this panel
    // (a live relay URL would otherwise sit in the pane for the whole session).
    publishSourceAlerts(
      sourceId,
      incidentsToBoardAlerts({
        sourceId,
        sourceType: source.type,
        sourceLabel: isPennHillsPreset(source.params) ? PENN_HILLS_FEED.name : "Broadcastify",
        incidents: next.incidents.filter(
          (item) =>
            item.category !== "archive-day" &&
            item.category !== "feed-status" &&
            !item.id.startsWith("feed-status-"),
        ),
      }),
    );
  }

  useEffect(() => {
    setDay(configuredDay);
  }, [configuredDay]);

  useEffect(() => {
    if (!captionsOn) setCcOn(false);
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
        publishIncidents(next);
        setSelectedId((cur) => {
          if (cur && next.incidents.some((item) => item.id === cur)) return cur;
          const status = next.incidents.find((item) => item.id.startsWith("feed-status-"));
          return status?.id ?? incoming[0] ?? cur;
        });
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          if (flashTimer) window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => setFlashIds(new Set()), 8_000);
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
      clearSourceAlerts(sourceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceId,
    source.refresh,
    source.type,
    JSON.stringify(source.params),
    day,
    configRevision,
  ]);

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
          note: captionFailureText(err),
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
          <label className="bcfy-cc-toggle" title="Keep captions up after the sound is turned on">
            <input
              type="checkbox"
              checked={ccOn}
              onChange={(e) => setCcOn(e.target.checked)}
            />
            <span className={`bcfy-cc-badge${ccOn ? " on" : ""}`}>CC</span>
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
                        : item.category === "feed-status"
                          ? item.severity === "alert"
                            ? "offline"
                            : "live"
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
                  {feed.relay ? <span>{feed.relay}</span> : null}
                  {captionsOn ? <span>captions on</span> : null}
                </div>
                {!feed.streamUrl ? (
                  <p className="bcfy-audio-hint">
                    Live audio uses the relay and mount from the Feed Owner API.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="incident-map-empty">Awaiting feed status…</div>
            )}
          </div>

          <div className="incident-detail">
            {selected ? (
              <ArchiveDetail
                sourceId={sourceId}
                feedLabel={
                  isPennHillsPreset(source.params)
                    ? PENN_HILLS_FEED.name
                    : (feed?.descr ?? "Broadcastify")
                }
                feedId={feed?.feedId ?? ""}
                item={selected}
                feedOnline={feed?.online === true}
                onPickDay={pickDayFromItem}
                captionsEnabled={captionsOn}
                ccOn={ccOn}
                caption={captionCache[selected.id] ?? null}
                onCaption={(next) =>
                  setCaptionCache((cache) => ({ ...cache, [selected.id]: next }))
                }
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
  sourceId,
  feedLabel,
  feedId,
  item,
  feedOnline,
  onPickDay,
  captionsEnabled,
  ccOn,
  caption,
  onCaption,
  onTranscribe,
}: {
  sourceId: string;
  feedLabel: string;
  feedId: string;
  item: Incident;
  feedOnline: boolean;
  onPickDay: (item: Incident) => void;
  captionsEnabled: boolean;
  ccOn: boolean;
  caption: CaptionResult | null;
  onCaption: (caption: CaptionResult) => void;
  onTranscribe: () => void;
}) {
  const live = item.category === "feed-status" && feedOnline && Boolean(item.audioUrl);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [timeSec, setTimeSec] = useState(0);
  const [muted, setMuted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const showCaptionUi = captionsEnabled && captionsVisible(muted, ccOn);
  const active = caption ? activeCaptionAt(caption.segments, timeSec) : null;
  const liveCaptions = useLiveFeedCaptions({
    active: live && captionsEnabled,
    playing,
    sourceId,
    label: feedLabel,
    feedId,
    streamUrl: live ? (item.audioUrl ?? "") : "",
    durationSec: () => audioRef.current?.duration,
  });

  // Global product rule: audio starts muted on open (each clip selection).
  useEffect(() => {
    setMuted(true);
    setTimeSec(0);
    setPlaying(false);
    const el = audioRef.current;
    if (!el) return;
    el.muted = true;
    if (live) {
      // Captions read the relay URL on this computer. They still run when the
      // muted player cannot start, which is the default until the user unmutes.
      void el.play().then(() => setPlaying(true)).catch(() => setPlaying(true));
      return;
    }
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      // The element may not have metadata yet.
    }
  }, [item.id, item.audioUrl, live]);

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
            <dd>
              {item.category === "feed-status"
                ? feedOnline
                  ? "Live"
                  : "Offline"
                : item.category === "archive-day"
                  ? "Archive day"
                  : item.category === "archive"
                    ? "Archive"
                    : item.category}
            </dd>
          </>
        ) : null}
        {item.address ? (
          <>
            <dt>{item.category === "feed-status" ? "Place" : "Day"}</dt>
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
      {item.category === "feed-status" && item.audioUrl && !feedOnline ? (
        <p className="bcfy-audio-hint">
          Feed is offline, so live audio stays stopped. The relay URL is kept for the next time
          the feed is up. Playback starts muted.
        </p>
      ) : null}
      {item.audioUrl && (item.category !== "feed-status" || feedOnline) ? (
        <div className="incident-audio">
          <div className="bcfy-audio-head">
            <div className="section-label" style={{ margin: 0 }}>
              {item.category === "feed-status"
                ? "Live audio"
                : "Archive audio (personal use only)"}
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
            autoPlay={live}
            preload="none"
            muted={muted}
            src={item.audioUrl}
            onPlay={() => setPlaying(true)}
            onPlaying={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
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
          <p className="bcfy-audio-hint">
            {item.category === "feed-status"
              ? "Starts muted. Captions keep running while the sound is off. This URL is the relay and mount from the Feed Owner API."
              : "Starts muted on open — unmute explicitly to hear audio."}
          </p>
        </div>
      ) : null}

      {showCaptionUi && live ? (
        <LiveCaptions
          lines={liveCaptions.lines}
          status={liveCaptions.status}
          running={liveCaptions.running}
          playing={playing}
          onCorrect={liveCaptions.applyCorrection}
        />
      ) : null}

      {showCaptionUi && !live && item.audioUrl && (item.category !== "feed-status" || feedOnline) ? (
        <CaptionsPane
          caption={caption}
          active={active}
          busy={caption?.status === "running"}
          onCaption={onCaption}
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
  onCaption,
  onTranscribe,
}: {
  caption: CaptionResult | null;
  active: CaptionSegment | null;
  busy: boolean;
  onCaption: (caption: CaptionResult) => void;
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
          "Audio stays on this computer. Install Tiny English from Settings → Local AI to transcribe here."}
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
      {caption?.segments.length ? (
        <CaptionCorrection
          suggestion={active?.text ?? caption.segments[0]?.text ?? ""}
          onSaved={(memory) =>
            onCaption({
              ...caption,
              segments: withCorrections(caption.segments, memory),
            })
          }
        />
      ) : null}
    </div>
  );
}

function LiveCaptions({
  lines,
  status,
  running,
  playing,
  onCorrect,
}: {
  lines: FeedCaptionLine[];
  status: string | null;
  running: boolean;
  playing: boolean;
  onCorrect: (memory: AiMemory) => void;
}) {
  const latest = lines[lines.length - 1] ?? null;
  const empty =
    status && status !== "Creating captions on this device…"
      ? status
      : running || playing
        ? "Creating captions on this device…"
        : "Starting the feed…";
  return (
    <div className="bcfy-captions" aria-label="Captions">
      <div className="bcfy-captions-head">
        <div className="section-label" style={{ margin: 0 }}>
          Live captions
        </div>
      </div>
      <p className="bcfy-captions-note">
        Heard on this computer while the feed plays. Earlier lines stay in the list. A fix stays on
        this computer.
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
      {latest && status && status !== "Creating captions on this device…" ? (
        <p className="bcfy-captions-note">{status}</p>
      ) : null}
      <CaptionHistory lines={lines} activeId={latest?.id ?? null} />
      {latest ? <CaptionCorrection suggestion={latest.text} onSaved={onCorrect} /> : null}
    </div>
  );
}

function CaptionHistory({ lines, activeId }: { lines: FeedCaptionLine[]; activeId: string | null }) {
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

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
