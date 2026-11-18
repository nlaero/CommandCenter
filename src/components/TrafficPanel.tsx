import { Fragment, useEffect, useRef, useState } from "react";
import { useAlerts } from "../lib/alerts";
import { trafficEventsToBoardAlerts } from "../lib/boardAlerts";
import { fetchSourcePayload } from "../lib/api";
import { project, unproject, zoomToFit } from "../lib/traffic";
import type { SourceConfig, SourcePayload, TrafficBounds, TrafficEvent, TrafficKind } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  /** Bumped when Settings saves this source — forces an immediate refetch. */
  configRevision?: number;
};

type View = { lat: number; lon: number; zoom: number };

const TILE = 256;

const ESRI_BASE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile";
const ESRI_LABELS =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile";

function esriTile(layer: string, z: number, x: number, y: number): string {
  return `${layer}/${z}/${y}/${x}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 2 * 60_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 2 * 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(30_000, n * 1000);
  if (unit === "m") return Math.max(60_000, n * 60_000);
  return Math.max(60_000, n * 60 * 60_000);
}

function formatWhen(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function severityClass(severity: TrafficEvent["severity"]): string {
  if (severity === "alert") return "sev-alert";
  if (severity === "warn") return "sev-warn";
  return "sev-info";
}

function kindLabel(kind: TrafficKind): string {
  if (kind === "closure") return "closed";
  if (kind === "roadwork") return "work";
  if (kind === "condition") return "road";
  if (kind === "delay") return "delay";
  return "incident";
}

export function TrafficPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<View | null>(null);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();

  const traffic = payload?.traffic;
  const events = traffic?.events ?? [];
  const selected = events.find((event) => event.id === selectedId) ?? null;
  const placeKey = traffic ? `${traffic.lat.toFixed(4)},${traffic.lon.toFixed(4)}` : "";

  useEffect(() => {
    setCamera(null);
    setSelectedId(null);
  }, [placeKey]);

  useEffect(() => {
    let cancelled = false;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        publishSourceAlerts(
          sourceId,
          trafficEventsToBoardAlerts({
            sourceId,
            sourceType: source.type,
            sourceLabel: next.traffic?.label || "Traffic",
            events: next.traffic?.events ?? [],
          }),
        );
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
      window.clearInterval(timer);
      clearSourceAlerts(sourceId);
    };
    // Settings save remounts the panel and bumps configRevision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const travelCount = events.filter((event) => event.affectsTravel).length;
  const partials = (traffic?.feeds ?? []).filter((feed) => feed.status === "live" && feed.detail);

  return (
    <div className="traffic-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          Region
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {traffic
            ? `${traffic.label ? `${traffic.label} · ` : ""}${traffic.radiusMi}-mile region · ${events.length} listed · ${travelCount} affecting travel`
            : null}
          {payload ? ` · ${formatWhen(payload.fetchedAt)}` : null}
        </span>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="traffic-layout">
        <div className="incident-feed" role="list" aria-label="Road incidents and conditions">
          {events.map((event) => {
            const active = selectedId === event.id;
            return (
              <button
                key={event.id}
                type="button"
                role="listitem"
                className={`incident-alert traffic-row ${severityClass(event.severity)}${active ? " is-active" : ""}`}
                onClick={() => setSelectedId(event.id)}
              >
                <span className={`traffic-kind ${severityClass(event.severity)}`}>{kindLabel(event.kind)}</span>
                <span className="quake-row-copy">
                  <span className="incident-alert-top">
                    <span className="incident-sev">
                      {event.feedName}
                      {event.affectsTravel ? " · travel" : ""}
                    </span>
                    <span className="incident-when">{formatWhen(event.updatedAt)}</span>
                  </span>
                  <span className="incident-alert-title">{event.title}</span>
                  {event.road || event.direction ? (
                    <span className="traffic-road">
                      {[event.road, event.direction].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                  {active && event.summary ? <span className="traffic-summary">{event.summary}</span> : null}
                  {active && event.detailUrl ? (
                    <a
                      className="incident-link"
                      href={event.detailUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(click) => click.stopPropagation()}
                    >
                      Open source
                    </a>
                  ) : null}
                </span>
              </button>
            );
          })}
          {!loading && traffic && events.length === 0 ? (
            <p className="incident-empty">
              {traffic.feeds.some((feed) => feed.status === "live")
                ? "Nothing in this region is slowing travel right now."
                : traffic.feeds.some((feed) => feed.status === "needs-credentials")
                  ? "Incidents appear here once the free feed credentials are saved."
                  : "No live incidents for this region."}
            </p>
          ) : null}
        </div>

        <div className="quake-map-wrap traffic-map-wrap">
          {traffic ? (
            <TrafficMap
              bounds={traffic.bounds}
              home={{ lat: traffic.lat, lon: traffic.lon, label: traffic.label }}
              events={events}
              selectedId={selected?.id ?? null}
              camera={camera}
              onCamera={setCamera}
              onSelect={setSelectedId}
            />
          ) : (
            <div className="quake-map" aria-label="Traffic map" />
          )}
        </div>
      </div>

      {partials.map((feed) => (
        <p key={feed.id} className="traffic-partial">
          {feed.detail}
        </p>
      ))}

      {payload ? (
        <footer className="traffic-foot">
          {payload.attribution}
          {payload.note ? ` · ${payload.note}` : null}
        </footer>
      ) : null}
    </div>
  );
}

function TrafficMap({
  bounds,
  home,
  events,
  selectedId,
  camera,
  onCamera,
  onSelect,
}: {
  bounds: TrafficBounds;
  home: { lat: number; lon: number; label?: string };
  events: TrafficEvent[];
  selectedId: string | null;
  camera: View | null;
  onCamera: (view: View | null) => void;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 360, h: 280 });
  const drag = useRef<{ x: number; y: number; lat: number; lon: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) setSize({ w: rect.width, h: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitted = zoomToFit(bounds, size.w, size.h);
  const view = camera ?? fitted;
  const zoom = view.zoom;
  const centerPx = project(view.lat, view.lon, zoom);
  const left = centerPx.x - size.w / 2;
  const top = centerPx.y - size.h / 2;
  const n = 2 ** zoom;
  const x0 = Math.floor(left / TILE) - 1;
  const x1 = Math.floor((left + size.w) / TILE) + 1;
  const y0 = Math.floor(top / TILE) - 1;
  const y1 = Math.floor((top + size.h) / TILE) + 1;
  const tiles: { key: string; x: number; y: number; left: number; top: number }[] = [];
  for (let y = y0; y <= y1; y += 1) {
    if (y < 0 || y >= n) continue;
    for (let x = x0; x <= x1; x += 1) {
      const wrapped = ((x % n) + n) % n;
      tiles.push({
        key: `${zoom}/${x}/${y}`,
        x: wrapped,
        y,
        left: x * TILE - left,
        top: y * TILE - top,
      });
    }
  }

  const homePx = project(home.lat, home.lon, zoom);
  const northPx = project(bounds.north, home.lon, zoom);
  const eastPx = project(home.lat, bounds.east, zoom);
  const ring = {
    cx: homePx.x - left,
    cy: homePx.y - top,
    rx: Math.abs(eastPx.x - homePx.x),
    ry: Math.abs(northPx.y - homePx.y),
  };

  function zoomBy(delta: number) {
    onCamera({ ...view, zoom: clamp(zoom + delta, 3, 12) });
  }

  return (
    <div
      ref={ref}
      className={`quake-map${dragging ? " is-dragging" : ""}`}
      aria-label="Traffic map for the 80-mile region"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, lat: view.lat, lon: view.lon };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const origin = project(start.lat, start.lon, zoom);
        const next = unproject(origin.x - (event.clientX - start.x), origin.y - (event.clientY - start.y), zoom);
        onCamera({ lat: next.lat, lon: next.lon, zoom });
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
    >
      {tiles.map((tile) => (
        <Fragment key={tile.key}>
          <img
            className="quake-tile"
            alt=""
            draggable={false}
            src={esriTile(ESRI_BASE, zoom, tile.x, tile.y)}
            style={{ left: tile.left, top: tile.top }}
          />
          <img
            className="quake-tile quake-tile-labels"
            alt=""
            draggable={false}
            src={esriTile(ESRI_LABELS, zoom, tile.x, tile.y)}
            style={{ left: tile.left, top: tile.top }}
          />
        </Fragment>
      ))}
      <svg className="traffic-ring" aria-hidden>
        <ellipse cx={ring.cx} cy={ring.cy} rx={ring.rx} ry={ring.ry} />
      </svg>
      <span
        className="traffic-home"
        style={{ left: ring.cx, top: ring.cy }}
        title={home.label || "Confirmed place"}
      />
      {events.map((event) => {
        const px = project(event.lat, event.lon, zoom);
        const x = px.x - left;
        const y = px.y - top;
        if (x < -24 || y < -24 || x > size.w + 24 || y > size.h + 24) return null;
        const focused = event.id === selectedId;
        return (
          <button
            key={event.id}
            type="button"
            className={`quake-marker ${severityClass(event.severity)}${focused ? " is-focus" : ""}`}
            style={{ left: x, top: y }}
            title={event.title}
            aria-label={event.title}
            onPointerDown={(pointer) => pointer.stopPropagation()}
            onClick={() => onSelect(event.id)}
          />
        );
      })}
      <div className="quake-zoom" role="group" aria-label="Map zoom">
        <button
          type="button"
          className="btn btn-ghost"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => zoomBy(1)}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => zoomBy(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="btn btn-ghost traffic-region-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onCamera(null)}
        >
          Region
        </button>
      </div>
      <div className="quake-map-attrib">
        Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap · z{zoom}
      </div>
    </div>
  );
}
