import { useEffect, useRef, useState } from "react";
import { getAdapter } from "../adapters/catalog";
import { useAlerts } from "../lib/alerts";
import { spaceAlertsToBoardAlerts } from "../lib/boardAlerts";
import { fetchSourcePayload } from "../lib/api";
import { confirmedPlaceLabel, formatCoords, readCoords } from "../lib/location";
import {
  HAM_SOLAR_TYPE,
  SPACE_MIN_POLL_MS,
  listHamPairs,
  showAuroraMap,
  spaceAlertsForBoard,
  spaceIndices,
  spacePollMs,
  formatIndex,
  type BandCondition,
  type HamPair,
} from "../lib/spaceWeather";
import type { AuroraPoint, Hemisphere, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  sources: Record<string, SourceConfig>;
  configRevision?: number;
};

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

function scaleText(letter: string, scale?: { level: number; text: string }): string {
  if (!scale) return "—";
  return `${letter}${scale.level} ${scale.text}`;
}

function conditionLabel(condition: BandCondition): string {
  if (condition === "aurora") return "Aurora";
  if (condition === "fair") return "Fair";
  if (condition === "poor") return "Poor";
  return "Quiet";
}

export function SpacePanel({ sourceId, source, sources, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();
  const place = confirmedPlaceLabel(source.params);
  const saved = readCoords(source.params);
  const space = payload?.space;
  const showMap = showAuroraMap(source.params.showAurora);
  const hamCataloged = Boolean(getAdapter(HAM_SOLAR_TYPE));
  const pairs = listHamPairs(sources, spaceIndices(space));

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        publishSourceAlerts(
          sourceId,
          spaceAlertsToBoardAlerts({
            sourceId,
            sourceType: source.type,
            sourceLabel: "Space weather",
            alerts: spaceAlertsForBoard(next.space?.alerts ?? []),
          }),
        );
        const wait = spacePollMs(source.refresh, next.space?.pollAfterMs);
        timer = window.setTimeout(() => void load(true), wait);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        timer = window.setTimeout(() => void load(true), SPACE_MIN_POLL_MS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      clearSourceAlerts(sourceId);
    };
    // Settings save remounts the panel. reloadToken is the manual refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.type, source.refresh, JSON.stringify(source.params), configRevision, reloadToken]);

  const messages = (space?.alerts ?? []).filter((alert) => !alert.id.startsWith("scale-")).slice(0, 8);

  return (
    <div className="space-panel">
      <div className="weather-toolbar">
        <span className="weather-live">
          <span className="live-dot" aria-hidden />
          {loading && !space ? "Loading" : "NOAA SWPC"}
        </span>
        <span className="weather-meta">
          {place ?? (saved ? formatCoords(saved.lat, saved.lon) : "Place not confirmed")}
          {space?.auroraForecastAt ? ` · forecast ${formatWhen(space.auroraForecastAt)}` : ""}
        </span>
        <button
          type="button"
          className="btn btn-ghost weather-refresh"
          onClick={() => setReloadToken((n) => n + 1)}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {space ? (
        <>
          <div className="space-kpis weather-kpi-grid" aria-label="Space weather indices">
            <Index label="Kp" value={space.kp == null ? "—" : formatIndex(space.kp)} detail={formatWhen(space.kpTime)} />
            <Index
              label="Kp now"
              value={space.estimatedKp == null ? "—" : formatIndex(space.estimatedKp)}
              detail={formatWhen(space.estimatedKpTime)}
            />
            <Index label="G" value={scaleText("G", space.scales?.geomagnetic)} />
            <Index label="S" value={scaleText("S", space.scales?.solar)} />
            <Index label="R" value={scaleText("R", space.scales?.radio)} />
            <Index label="X-ray" value={space.xrayClass ?? "—"} detail={formatWhen(space.xrayTime)} />
            <Index
              label="10.7 cm"
              value={space.solarFlux == null ? "—" : `${Math.round(space.solarFlux)} sfu`}
              detail={formatWhen(space.solarFluxTime)}
            />
            <Index
              label="Aurora"
              value={space.auroraChance == null ? "—" : `${Math.round(space.auroraChance)}%`}
              detail="Nearest OVATION point"
            />
          </div>

          {showMap ? (
            <AuroraMap
              points={space.auroraPoints}
              lat={space.lat}
              lon={space.lon}
              hemisphere={space.hemisphere}
              missing={space.auroraChance == null}
            />
          ) : null}

          {hamCataloged || pairs.length > 0 ? (
            <HamPairing pairs={pairs} cataloged={hamCataloged} />
          ) : null}

          <div className="space-alerts" aria-label="Space weather messages">
            {messages.length === 0 ? (
              <p className="weather-empty">No SWPC messages in the latest file.</p>
            ) : (
              messages.map((alert) => (
                <article key={alert.id} className={`space-alert sev-${alert.severity}`}>
                  <div className="space-alert-title">{alert.title}</div>
                  <div className="space-alert-meta">
                    <span className="mono">{alert.code}</span>
                    <span>{formatWhen(alert.issuedAt)}</span>
                  </div>
                  {alert.summary ? <p>{alert.summary}</p> : null}
                </article>
              ))
            )}
          </div>
        </>
      ) : loading ? (
        <p className="weather-empty">Loading NOAA SWPC…</p>
      ) : null}

      {payload?.attribution ? (
        <footer className="weather-footer" title={payload.note ?? undefined}>
          {payload.attribution}
          {payload.note ? ` · ${payload.note}` : null}
        </footer>
      ) : null}
    </div>
  );
}

function Index({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {detail && detail !== "—" ? <span className="space-detail">{detail}</span> : null}
    </div>
  );
}

function HamPairing({ pairs, cataloged }: { pairs: HamPair[]; cataloged: boolean }) {
  return (
    <section className="space-pair" aria-label="Ham propagation pairing">
      <div className="space-pair-kicker">Paired with Ham propagation / solar</div>
      {pairs.length === 0 ? (
        <p>
          {cataloged
            ? "Save Ham propagation / solar and set its bands. This panel marks those bands from the current G and R scales. Storm impact only."
            : "No ham solar source is saved on this computer."}
        </p>
      ) : (
        pairs.map((pair) => (
          <div key={pair.sourceId} className="space-pair-source">
            <div className="space-pair-id mono">{pair.sourceId}</div>
            <p>{pair.summary}</p>
            {pair.bands.length === 0 ? (
              <p>No bands are set on that source. Example: 80m, 40m, 20m, 2m.</p>
            ) : (
              <ul className="space-bands">
                {pair.bands.map((band) => (
                  <li key={band.band} className={`space-band cond-${band.condition}`} title={band.note}>
                    <span>{band.band}</span>
                    <span>{conditionLabel(band.condition)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function AuroraMap({
  points,
  lat,
  lon,
  hemisphere,
  missing,
}: {
  points: AuroraPoint[];
  lat: number;
  lon: number;
  hemisphere: Hemisphere;
  missing: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inView = hemisphere === "both" || (hemisphere === "north" ? lat >= 0 : lat <= 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const full = Math.max(240, wrap.clientWidth);
      const polar = hemisphere !== "both";
      const height = polar
        ? Math.max(168, Math.min(220, full))
        : Math.max(120, Math.min(160, Math.round(full * 0.28)));
      const width = polar ? Math.min(full, height) : full;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0b0d10";
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.max(40, Math.min(cx, cy) - 10);
      const project = (pointLat: number, pointLon: number) => {
        if (!polar) {
          const min = -90;
          const max = 90;
          return {
            x: ((pointLon + 180) / 360) * width,
            y: ((max - pointLat) / (max - min)) * height,
            span: Math.max(2, width / 180),
          };
        }
        const pole = hemisphere === "south" ? -90 : 90;
        const reach = ((pole - pointLat) / pole) * radius;
        const theta = (pointLon * Math.PI) / 180;
        return {
          x: cx + reach * Math.sin(theta),
          y: cy - reach * Math.cos(theta),
          span: Math.max(3, 12 * (Math.abs(reach) / radius)),
        };
      };

      ctx.strokeStyle = "#1e2430";
      ctx.lineWidth = 1;
      if (polar) {
        for (const line of [30, 60]) {
          const ring = project(hemisphere === "south" ? -line : line, 0);
          const ringR = Math.hypot(ring.x - cx, ring.y - cy);
          ctx.beginPath();
          ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (const point of points) {
        const { x, y, span } = project(point.lat, point.lon);
        ctx.fillStyle = auroraColor(point.chance);
        ctx.fillRect(x - span / 2, y - span / 2, span, span);
      }

      if (inView) {
        const { x, y } = project(lat, lon);
        ctx.fillStyle = "#0b0d10";
        ctx.strokeStyle = "#3d9cf0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [points, lat, lon, hemisphere, inView]);

  return (
    <div className="space-map">
      <div ref={wrapRef} className="space-map-canvas">
        <canvas ref={canvasRef} role="img" aria-label="OVATION aurora forecast" />
      </div>
      <div className="space-legend">
        <span>OVATION chance</span>
        <span className="space-swatch cond-quiet">5–9</span>
        <span className="space-swatch cond-fair">10–29</span>
        <span className="space-swatch cond-poor">30+</span>
        <span className="space-you">Your place</span>
        <span>{hemisphere === "south" ? "South pole at center" : hemisphere === "north" ? "North pole at center" : "Both hemispheres"}</span>
      </div>
      {missing ? <p className="weather-empty">Aurora forecast did not load.</p> : null}
      {!inView ? (
        <p className="weather-empty">
          This map is the other hemisphere. The chance above is still for your place.
        </p>
      ) : null}
    </div>
  );
}

function auroraColor(chance: number): string {
  if (chance >= 30) return "rgba(232, 93, 76, 0.92)";
  if (chance >= 10) return "rgba(230, 184, 77, 0.88)";
  return "rgba(60, 179, 113, 0.8)";
}
