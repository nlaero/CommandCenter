import { useEffect, useMemo, useRef, useState } from "react";
import { useAlerts } from "../lib/alerts";
import { incidentsToBoardAlerts } from "../lib/boardAlerts";
import { fetchSourcePayload } from "../lib/api";
import { closeCallClips, publishCallClips } from "../lib/safetyListen";
import type { Incident, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  configRevision?: number;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 60_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(30_000, n * 1000);
  if (unit === "m") return Math.max(30_000, n * 60_000);
  return Math.max(60_000, n * 60 * 60_000);
}

function formatWhen(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source: SourceConfig): string {
  const label = typeof source.params.label === "string" ? source.params.label.trim() : "";
  return label || "Broadcastify Calls";
}

export function CallsPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();
  const label = sourceLabel(source);

  function publishCalls(next: SourcePayload) {
    publishSourceAlerts(
      sourceId,
      incidentsToBoardAlerts({
        sourceId,
        sourceType: source.type,
        sourceLabel: label,
        incidents: next.incidents.slice(0, 8),
      }),
    );
  }

  const selected = useMemo(
    () => payload?.incidents.find((item) => item.id === selectedId) ?? null,
    [payload, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    let flashTimer: number | undefined;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        const incoming: string[] = [];
        if (primed.current) {
          for (const item of next.incidents) {
            if (!knownIds.current.has(item.id)) incoming.push(item.id);
          }
        } else {
          primed.current = true;
        }
        knownIds.current = new Set(next.incidents.map((item) => item.id));
        setPayload(next);
        setError(null);
        publishCallClips(sourceId, next.incidents);
        publishCalls(next);
        setSelectedId((current) => {
          if (current && next.incidents.some((item) => item.id === current)) return current;
          return next.incidents[0]?.id ?? current;
        });
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          if (flashTimer) window.clearTimeout(flashTimer);
          flashTimer = window.setTimeout(() => setFlashIds(new Set()), 8_000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(false);
    const timer = window.setInterval(() => void load(true), parseRefreshMs(source.refresh));
    return () => {
      cancelled = true;
      closeCallClips(sourceId);
      window.clearInterval(timer);
      if (flashTimer) window.clearTimeout(flashTimer);
      clearSourceAlerts(sourceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const list = payload?.incidents ?? [];

  return (
    <div className="incident-panel bcfy-panel calls-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          Calls
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {payload ? `${list.length} clips · ${formatWhen(payload.fetchedAt)}` : null}
        </span>
        <button
          type="button"
          className="btn btn-ghost incident-refresh"
          onClick={() => {
            void fetchSourcePayload(sourceId, source)
              .then((next) => {
                setPayload(next);
                setError(null);
                publishCallClips(sourceId, next.incidents);
                publishCalls(next);
              })
              .catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="incident-layout">
        <div className="incident-feed" role="list" aria-label="Broadcastify call clips">
          {list.map((item) => {
            const active = selectedId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className={`incident-alert sev-info${flashIds.has(item.id) ? " is-new" : ""}${
                  active ? " is-active" : ""
                }`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="incident-alert-top">
                  <span className="incident-sev">clip</span>
                  <span className="incident-when">{formatWhen(item.occurredAt)}</span>
                </div>
                <div className="incident-alert-title">{item.title}</div>
                <div className="incident-alert-sub">
                  {item.address ?? item.description ?? "Call"}
                  {item.audioUrl ? <span className="audio-tag">audio</span> : null}
                </div>
              </button>
            );
          })}
          {!loading && payload && list.length === 0 ? (
            <p className="incident-empty">No call clips in this window.</p>
          ) : null}
        </div>

        <div className="incident-detail">
          {selected ? (
            <CallDetail item={selected} />
          ) : (
            <p className="incident-empty">Select a call to play its clip.</p>
          )}
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

function CallDetail({ item }: { item: Incident }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    setMuted(true);
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
      <div className="incident-sev sev-info">call</div>
      <h4 className="incident-detail-title">{item.title}</h4>
      <dl className="incident-dl">
        {item.occurredAt ? (
          <>
            <dt>When</dt>
            <dd>{formatWhen(item.occurredAt)}</dd>
          </>
        ) : null}
        {item.address ? (
          <>
            <dt>Group</dt>
            <dd>{item.address}</dd>
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
      {item.audioUrl ? (
        <div className="incident-audio">
          <div className="bcfy-audio-head">
            <div className="section-label" style={{ margin: 0 }}>
              Clip audio
            </div>
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
          <audio
            ref={audioRef}
            controls
            preload="none"
            muted={muted}
            src={item.audioUrl}
            onVolumeChange={(event) => {
              setMuted(event.currentTarget.muted || event.currentTarget.volume === 0);
            }}
          >
            <a href={item.audioUrl} target="_blank" rel="noreferrer">
              Open clip
            </a>
          </audio>
          <p className="bcfy-audio-hint">Starts muted. Unmute to hear this clip.</p>
        </div>
      ) : (
        <p className="bcfy-audio-hint">This call has no clip URL.</p>
      )}
    </div>
  );
}
