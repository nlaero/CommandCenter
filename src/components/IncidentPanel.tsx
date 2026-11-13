import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSourcePayload } from "../lib/api";
import type { Incident, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 5 * 60_000;
  const m = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!m) return 5 * 60_000;
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

export function IncidentPanel({ sourceId, source }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);

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
    // Intentionally depend on source identity + refresh, not selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params)]);

  const mapped = useMemo(
    () => (payload?.incidents ?? []).filter((i) => i.lat != null && i.lon != null),
    [payload],
  );

  const bounds = useMemo(() => {
    if (!mapped.length) return null;
    const lats = mapped.map((i) => i.lat as number);
    const lons = mapped.map((i) => i.lon as number);
    return {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };
  }, [mapped]);

  function project(lat: number, lon: number): { x: number; y: number } {
    if (!bounds) return { x: 50, y: 50 };
    const pad = 0.02;
    const latSpan = Math.max(bounds.maxLat - bounds.minLat, pad);
    const lonSpan = Math.max(bounds.maxLon - bounds.minLon, pad);
    const x = ((lon - bounds.minLon) / lonSpan) * 100;
    const y = (1 - (lat - bounds.minLat) / latSpan) * 100;
    return { x: Math.min(96, Math.max(4, x)), y: Math.min(96, Math.max(4, y)) };
  }

  return (
    <div className="incident-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          Live feed
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {payload
            ? `${payload.incidents.length} · ${formatWhen(payload.fetchedAt)}`
            : null}
        </span>
        <button
          type="button"
          className="btn btn-ghost incident-refresh"
          onClick={() => {
            void fetchSourcePayload(sourceId, source)
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
        <div className="incident-feed" role="list" aria-label="Incident alerts">
          {(payload?.incidents ?? []).map((item) => {
            const isNew = flashIds.has(item.id);
            const active = selectedId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className={`incident-alert ${severityClass(item.severity)}${
                  isNew ? " is-new" : ""
                }${active ? " is-active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="incident-alert-top">
                  <span className="incident-sev">{item.severity ?? "info"}</span>
                  <span className="incident-when">{formatWhen(item.occurredAt)}</span>
                </div>
                <div className="incident-alert-title">{item.title}</div>
                <div className="incident-alert-sub">
                  {item.address ?? item.category ?? "—"}
                  {item.audioUrl ? <span className="audio-tag">audio</span> : null}
                </div>
              </button>
            );
          })}
          {!loading && payload && payload.incidents.length === 0 ? (
            <p className="incident-empty">No incidents returned for this query.</p>
          ) : null}
        </div>

        <div className="incident-side">
          <div className="incident-map" aria-label="Map-friendly incident positions">
            {mapped.length && bounds ? (
              mapped.map((item) => {
                const { x, y } = project(item.lat as number, item.lon as number);
                return (
                  <button
                    key={`m-${item.id}`}
                    type="button"
                    className={`incident-dot ${severityClass(item.severity)}${
                      selectedId === item.id ? " is-active" : ""
                    }${flashIds.has(item.id) ? " is-new" : ""}`}
                    style={{ left: `${x}%`, top: `${y}%` }}
                    title={item.title}
                    onClick={() => setSelectedId(item.id)}
                  />
                );
              })
            ) : (
              <div className="incident-map-empty">No coordinates in this batch</div>
            )}
          </div>

          <div className="incident-detail">
            {selected ? (
              <IncidentDetail item={selected} />
            ) : (
              <p className="incident-empty">Select an alert for detail{payload?.incidents.some((i) => i.audioUrl) ? " / audio" : ""}.</p>
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

function IncidentDetail({ item }: { item: Incident }) {
  return (
    <div>
      <div className={`incident-sev ${severityClass(item.severity)}`}>
        {item.severity ?? "info"}
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
            <dt>Category</dt>
            <dd>{item.category}</dd>
          </>
        ) : null}
        {item.address ? (
          <>
            <dt>Where</dt>
            <dd>{item.address}</dd>
          </>
        ) : null}
        {item.lat != null && item.lon != null ? (
          <>
            <dt>Coords</dt>
            <dd className="mono">
              {item.lat.toFixed(5)}, {item.lon.toFixed(5)}
            </dd>
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
          <div className="section-label" style={{ marginBottom: 6 }}>
            Audio
          </div>
          {/* Global product rule: audio sources start muted on open. */}
          <audio controls preload="none" muted src={item.audioUrl}>
            <a href={item.audioUrl} target="_blank" rel="noreferrer">
              Open audio
            </a>
          </audio>
          <p className="bcfy-audio-hint">
            Starts muted. Closed captions for open-data audio clips are not wired yet — required for
            any future audio-playing source.
          </p>
        </div>
      ) : null}
      {item.detailUrl ? (
        <a className="incident-link" href={item.detailUrl} target="_blank" rel="noreferrer">
          Open source detail
        </a>
      ) : null}
    </div>
  );
}
