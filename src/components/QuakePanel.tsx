import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { publishSourceAlerts } from "../lib/alertsBus";
import { fetchSourcePayload } from "../lib/api";
import type { QuakeEvent, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  /** Bumped when Settings saves this source — forces an immediate refetch. */
  configRevision?: number;
};

type View = { lat: number; lon: number; zoom: number };

const TILE = 256;
const MAX_LAT = 85.05112878;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function zoomFor(event: QuakeEvent): number {
  const mag = event.mag ?? 0;
  if (event.tsunami || mag >= 7) return 4;
  if (mag >= 5 || event.eventType === "landslide" || event.eventType === "volcanic eruption") {
    return 5;
  }
  if (mag >= 3) return 6;
  return 7;
}

function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const clamped = clamp(lat, -MAX_LAT, MAX_LAT);
  const sin = Math.sin((clamped * Math.PI) / 180);
  const scale = TILE * 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const y =
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function unproject(x: number, y: number, zoom: number): { lat: number; lon: number } {
  const scale = TILE * 2 ** zoom;
  let lon = (x / scale) * 360 - 180;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clamp(lat, -MAX_LAT, MAX_LAT), lon };
}

function lerpLon(from: number, to: number, t: number): number {
  const delta = (((to - from + 540) % 360) + 360) % 360 - 180;
  let lon = from + delta * t;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return lon;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
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

function severityClass(severity?: QuakeEvent["severity"]): string {
  if (severity === "alert") return "sev-alert";
  if (severity === "warn") return "sev-warn";
  return "sev-info";
}

const ESRI_BASE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile";
const ESRI_LABELS =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile";

/** Esri map tiles are {z}/{y}/{x}. CARTO's keyless raster endpoint now returns an API-key placeholder. */
function esriTile(layer: string, z: number, x: number, y: number): string {
  return `${layer}/${z}/${y}/${x}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function QuakePanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef<View | null>(null);
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const moveGen = useRef(0);
  const timerRef = useRef(0);
  const loadRef = useRef<(manual: boolean) => void>(() => {});

  const events = payload?.quake?.events ?? [];
  const selected = useMemo(
    () => events.find((event) => event.id === selectedId) ?? null,
    [events, selectedId],
  );
  const autoPan = source.params.autoPan !== false;

  function setMapView(next: View) {
    viewRef.current = next;
    setView(next);
  }

  function panTo(lat: number, lon: number, zoom: number, gen: number): Promise<void> {
    const from = viewRef.current;
    if (!from) {
      setMapView({ lat, lon, zoom });
      return Promise.resolve();
    }
    const start = { ...from, zoom };
    setMapView(start);
    const began = performance.now();
    const duration = 1000;
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (moveGen.current !== gen) {
          resolve();
          return;
        }
        const t = Math.min(1, (now - began) / duration);
        const eased = easeInOut(t);
        setMapView({
          lat: start.lat + (lat - start.lat) * eased,
          lon: lerpLon(start.lon, lon, eased),
          zoom,
        });
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function tour(ids: string[], batch: QuakeEvent[]) {
    const gen = moveGen.current;
    for (const id of ids) {
      if (moveGen.current !== gen) return;
      const event = batch.find((item) => item.id === id);
      if (!event) continue;
      setSelectedId(id);
      await panTo(event.lat, event.lon, zoomFor(event), gen);
      await sleep(1400);
    }
  }

  function focusEvent(event: QuakeEvent) {
    moveGen.current += 1;
    const gen = moveGen.current;
    setSelectedId(event.id);
    void panTo(event.lat, event.lon, zoomFor(event), gen);
  }

  useEffect(() => {
    let cancelled = false;

    async function load(manual: boolean) {
      window.clearTimeout(timerRef.current);
      try {
        if (!manual && !primed.current) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        const batch = next.quake?.events ?? [];
        const incoming: string[] = [];
        if (primed.current) {
          for (const event of batch) {
            if (!knownIds.current.has(event.id)) incoming.push(event.id);
          }
        } else {
          primed.current = true;
          if (!viewRef.current && batch[0]) {
            setMapView({
              lat: batch[0].lat,
              lon: batch[0].lon,
              zoom: zoomFor(batch[0]),
            });
            setSelectedId(batch[0].id);
          }
        }
        knownIds.current = new Set(batch.map((event) => event.id));
        setPayload(next);
        setError(null);
        publishSourceAlerts(sourceId, next.alerts ?? []);
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          window.setTimeout(() => {
            if (!cancelled) setFlashIds(new Set());
          }, 8_000);
          if (source.params.autoPan !== false) {
            void tour(incoming.slice(0, 6), batch);
          }
        }
        const wait = Math.max(1000, next.quake?.pollAfterMs ?? 60_000);
        timerRef.current = window.setTimeout(() => void load(false), wait);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        timerRef.current = window.setTimeout(() => void load(false), 60_000);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadRef.current = (manual: boolean) => {
      void load(manual);
    };
    void load(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timerRef.current);
      moveGen.current += 1;
      publishSourceAlerts(sourceId, []);
    };
    // Settings save remounts the panel (PanelCard key) and bumps configRevision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const quake = payload?.quake;
  const pollSec = quake ? Math.max(1, Math.round(quake.pollAfterMs / 1000)) : null;
  const cacheLabel = quake?.notModified ? "304" : quake?.fromCache ? "cache" : null;

  return (
    <div className="incident-panel quake-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          USGS
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {quake
            ? `${quake.events.length}${
                quake.totalCount && quake.totalCount > quake.events.length
                  ? `/${quake.totalCount}`
                  : ""
              } · ${formatWhen(payload?.fetchedAt)}`
            : null}
          {pollSec ? ` · every ${pollSec}s` : null}
          {cacheLabel ? ` · ${cacheLabel}` : null}
        </span>
        <button
          type="button"
          className="btn btn-ghost incident-refresh"
          onClick={() => loadRef.current(true)}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      <div className="quake-layout">
        <div className="incident-feed" role="list" aria-label="USGS earthquakes and other events">
          {events.map((event) => {
            const active = selectedId === event.id;
            return (
              <button
                key={event.id}
                type="button"
                role="listitem"
                className={`incident-alert quake-row ${severityClass(event.severity)}${
                  flashIds.has(event.id) ? " is-new" : ""
                }${active ? " is-active" : ""}`}
                onClick={() => focusEvent(event)}
              >
                <span className={`quake-mag ${severityClass(event.severity)}`}>
                  {event.mag == null ? "—" : event.mag.toFixed(1)}
                </span>
                <span className="quake-row-copy">
                  <span className="incident-alert-top">
                    <span className="incident-sev">
                      {event.tsunami ? "tsunami" : event.eventType}
                      {event.alert ? ` · ${event.alert}` : ""}
                    </span>
                    <span className="incident-when">{formatWhen(event.occurredAt)}</span>
                  </span>
                  <span className="incident-alert-title">{event.title}</span>
                </span>
              </button>
            );
          })}
          {!loading && payload && events.length === 0 ? (
            <p className="incident-empty">No events in this USGS feed.</p>
          ) : null}
        </div>

        <div className="quake-map-wrap">
          <QuakeMap
            view={view}
            events={events}
            selectedId={selectedId}
            flashIds={flashIds}
            onSelect={focusEvent}
            onDragStart={() => {
              moveGen.current += 1;
            }}
            onDrag={(lat, lon) => {
              const zoom = viewRef.current?.zoom ?? view?.zoom ?? 5;
              setMapView({ lat, lon, zoom });
            }}
            onZoom={(zoom) => {
              moveGen.current += 1;
              const current = viewRef.current;
              if (!current) return;
              setMapView({ ...current, zoom });
            }}
          />
          <div className="quake-detail">
            {selected ? (
              <QuakeDetail event={selected} />
            ) : (
              <p className="incident-empty">
                {autoPan
                  ? "Select an event to pan the map. New earthquakes, tsunami flags, and other events pan here as they arrive."
                  : "Select an event to pan the map. Auto-pan is off for this source."}
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

function QuakeDetail({ event }: { event: QuakeEvent }) {
  return (
    <div>
      <div className="quake-detail-head">
        <span className={`quake-mag ${severityClass(event.severity)}`}>
          {event.mag == null ? "—" : event.mag.toFixed(1)}
        </span>
        <div>
          <div className={`incident-sev ${severityClass(event.severity)}`}>
            {event.tsunami ? "tsunami" : event.eventType}
            {event.alert ? ` · pager ${event.alert}` : ""}
            {event.notable ? " · alerts" : ""}
          </div>
          <h4 className="incident-detail-title">{event.title}</h4>
        </div>
      </div>
      <dl className="incident-dl">
        <dt>When</dt>
        <dd>{formatWhen(event.occurredAt)}</dd>
        {event.place ? (
          <>
            <dt>Where</dt>
            <dd>{event.place}</dd>
          </>
        ) : null}
        <dt>Coords</dt>
        <dd className="mono">
          {event.lat.toFixed(2)}, {event.lon.toFixed(2)}
        </dd>
        {event.depthKm != null ? (
          <>
            <dt>Depth</dt>
            <dd className="mono">{event.depthKm.toFixed(1)} km</dd>
          </>
        ) : null}
        {event.magType ? (
          <>
            <dt>Mag type</dt>
            <dd className="mono">{event.magType}</dd>
          </>
        ) : null}
        {event.felt != null ? (
          <>
            <dt>Felt</dt>
            <dd>{event.felt} reports</dd>
          </>
        ) : null}
        {event.mmi != null ? (
          <>
            <dt>MMI</dt>
            <dd className="mono">{event.mmi.toFixed(1)}</dd>
          </>
        ) : null}
        <dt>Tsunami</dt>
        <dd>{event.tsunami ? "Yes" : "No"}</dd>
      </dl>
      {event.url ? (
        <a className="incident-link" href={event.url} target="_blank" rel="noreferrer">
          Open USGS event
        </a>
      ) : null}
    </div>
  );
}

function QuakeMap({
  view,
  events,
  selectedId,
  flashIds,
  onSelect,
  onDragStart,
  onDrag,
  onZoom,
}: {
  view: View | null;
  events: QuakeEvent[];
  selectedId: string | null;
  flashIds: Set<string>;
  onSelect: (event: QuakeEvent) => void;
  onDragStart: () => void;
  onDrag: (lat: number, lon: number) => void;
  onZoom: (zoom: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 360, h: 280 });
  const drag = useRef<{ x: number; y: number; lat: number; lon: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ w: rect.width, h: rect.height });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoom = view?.zoom ?? 2;
  const center = view ?? { lat: 20, lon: 0, zoom: 2 };
  // Keep the focused point above the detail card.
  const biasY = 36;
  const centerPx = project(center.lat, center.lon, zoom);
  const left = centerPx.x - size.w / 2;
  const top = centerPx.y - size.h / 2 + biasY;
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

  return (
    <div
      ref={ref}
      className={`quake-map${drag.current ? " is-dragging" : ""}`}
      aria-label="Earthquake map"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onDragStart();
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          lat: center.lat,
          lon: center.lon,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const origin = project(start.lat, start.lon, zoom);
        const next = unproject(
          origin.x - (event.clientX - start.x),
          origin.y - (event.clientY - start.y),
          zoom,
        );
        onDrag(next.lat, next.lon);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
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
            className={`quake-marker ${severityClass(event.severity)}${
              event.tsunami ? " is-tsunami" : ""
            }${event.eventType !== "earthquake" ? " is-other" : ""}${
              focused ? " is-focus" : ""
            }${flashIds.has(event.id) ? " is-new" : ""}`}
            style={{ left: x, top: y }}
            title={event.title}
            aria-label={event.title}
            onPointerDown={(pointer) => pointer.stopPropagation()}
            onClick={() => onSelect(event)}
          >
            {focused ? (
              <span className="quake-marker-mag">
                {event.mag == null ? event.eventType.slice(0, 3) : event.mag.toFixed(1)}
              </span>
            ) : null}
          </button>
        );
      })}
      <div className="quake-zoom" role="group" aria-label="Map zoom">
        <button
          type="button"
          className="btn btn-ghost"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onZoom(clamp(zoom + 1, 2, 9))}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onZoom(clamp(zoom - 1, 2, 9))}
        >
          −
        </button>
      </div>
      <div className="quake-map-attrib">
        Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap · z{zoom}
      </div>
    </div>
  );
}
