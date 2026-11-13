import { useEffect, useMemo, useState } from "react";
import { useAlerts } from "../lib/alerts";
import { weatherAlertsToBoardAlerts } from "../lib/boardAlerts";
import { fetchSourcePayload } from "../lib/api";
import type { ScopeView, SourceConfig, SourcePayload, WeatherPayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  /** Bumped when Settings saves this source — forces an immediate refetch. */
  configRevision?: number;
};

type OverlayMode = "radar" | "satellite" | "both" | "none";

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 10 * 60_000;
  const m = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!m) return 10 * 60_000;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "s") return Math.max(30_000, n * 1000);
  if (unit === "m") return Math.max(60_000, n * 60_000);
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

function formatHour(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(11, 16) || value;
  return d.toLocaleTimeString(undefined, { hour: "numeric" });
}

function defaultOverlay(weather: WeatherPayload | undefined): OverlayMode {
  if (!weather) return "none";
  const { showRadar, showSatellite } = weather.layers;
  if (showRadar && showSatellite) return "both";
  if (showRadar) return "radar";
  if (showSatellite) return "satellite";
  return "none";
}

export function WeatherPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [overlay, setOverlay] = useState<OverlayMode>("both");
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();

  const weather = payload?.weather;
  const imperial = (weather?.units ?? "imperial") !== "metric";

  useEffect(() => {
    let cancelled = false;

    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        setOverlay((cur) => {
          const nextDefault = defaultOverlay(next.weather);
          if (cur === "none" || !next.weather) return nextDefault;
          if (cur === "radar" && !next.weather.layers.showRadar) return nextDefault;
          if (cur === "satellite" && !next.weather.layers.showSatellite) return nextDefault;
          if (cur === "both" && !(next.weather.layers.showRadar && next.weather.layers.showSatellite)) {
            return nextDefault;
          }
          return cur;
        });
        setActiveScope((cur) => {
          const scopes = next.weather?.scopes ?? [];
          if (cur && scopes.some((s) => s.id === cur)) return cur;
          return scopes[0]?.id ?? null;
        });
        publishSourceAlerts(
          sourceId,
          weatherAlertsToBoardAlerts({
            sourceId,
            sourceType: source.type,
            sourceLabel: "Weather",
            alerts: next.weather?.alerts ?? [],
          }),
        );
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
      clearSourceAlerts(sourceId);
    };
    // Intentionally depend on source identity + Settings revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sourceId,
    source.refresh,
    source.type,
    JSON.stringify(source.params),
    configRevision,
  ]);

  const conditions = weather?.conditions;
  const scopes = weather?.scopes ?? [];
  const multiScope = scopes.length > 1;

  const focused = useMemo(
    () => scopes.find((s) => s.id === activeScope) ?? scopes[0] ?? null,
    [scopes, activeScope],
  );

  return (
    <div className="weather-panel">
      <div className="weather-toolbar">
        <span className="weather-live">
          <span className="live-dot" aria-hidden />
          Live weather
        </span>
        <span className="weather-meta">
          {loading && !payload ? "Loading…" : null}
          {payload ? formatWhen(payload.fetchedAt) : null}
        </span>
        <div className="weather-overlay-toggles" role="group" aria-label="Map overlay">
          {weather?.layers.showRadar ? (
            <button
              type="button"
              className={`btn btn-ghost weather-chip${overlay === "radar" || overlay === "both" ? " active" : ""}`}
              onClick={() =>
                setOverlay((cur) => {
                  if (cur === "both") return "satellite";
                  if (cur === "radar") return weather.layers.showSatellite ? "satellite" : "none";
                  if (cur === "satellite") return "both";
                  return "radar";
                })
              }
            >
              Radar
            </button>
          ) : null}
          {weather?.layers.showSatellite ? (
            <button
              type="button"
              className={`btn btn-ghost weather-chip${overlay === "satellite" || overlay === "both" ? " active" : ""}`}
              onClick={() =>
                setOverlay((cur) => {
                  if (cur === "both") return "radar";
                  if (cur === "satellite") return weather.layers.showRadar ? "radar" : "none";
                  if (cur === "radar") return "both";
                  return "satellite";
                })
              }
            >
              Satellite
            </button>
          ) : null}
        </div>
        <span className="weather-meta" title="NWS alerts for this source point">
          {weather?.alerts?.length
            ? `${weather.alerts.length} NWS alert${weather.alerts.length === 1 ? "" : "s"}`
            : null}
        </span>
        <button
          type="button"
          className="btn btn-ghost weather-refresh"
          onClick={() => {
            void fetchSourcePayload(sourceId, source)
              .then((next) => {
                setPayload(next);
                setError(null);
                publishSourceAlerts(
                  sourceId,
                  weatherAlertsToBoardAlerts({
                    sourceId,
                    sourceType: source.type,
                    sourceLabel: "Weather",
                    alerts: next.weather?.alerts ?? [],
                  }),
                );
              })
              .catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          Refresh
        </button>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {conditions ? (
        <div className="weather-kpi" aria-label="Current conditions">
          <div className="weather-kpi-main">
            <div className="weather-temp">
              {imperial ? Math.round(conditions.tempF) : Math.round(conditions.tempC)}
              <span className="weather-temp-unit">{imperial ? "°F" : "°C"}</span>
            </div>
            <div className="weather-desc">{conditions.description}</div>
            <div className="weather-feels">
              Feels{" "}
              {imperial
                ? `${Math.round(conditions.feelsLikeF)}°F`
                : `${Math.round(conditions.feelsLikeC)}°C`}
            </div>
          </div>
          <div className="weather-kpi-grid">
            <div>
              <span className="kpi-label">Humidity</span>
              <span className="kpi-value">{Math.round(conditions.humidity)}%</span>
            </div>
            <div>
              <span className="kpi-label">Wind</span>
              <span className="kpi-value">
                {imperial
                  ? `${Math.round(conditions.windMph)} mph`
                  : `${Math.round(conditions.windKmh)} km/h`}
              </span>
            </div>
            <div>
              <span className="kpi-label">Pressure</span>
              <span className="kpi-value">
                {conditions.pressureHpa != null
                  ? `${Math.round(conditions.pressureHpa)} hPa`
                  : "—"}
              </span>
            </div>
            <div>
              <span className="kpi-label">Coords</span>
              <span className="kpi-value mono">
                {conditions.lat.toFixed(2)}, {conditions.lon.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {weather?.hourly?.length ? (
        <div className="weather-hourly" aria-label="Next hours">
          {weather.hourly.slice(0, 8).map((h) => (
            <div className="weather-hour" key={h.time}>
              <span className="hour-time">{formatHour(h.time)}</span>
              <span className="hour-temp">
                {imperial ? Math.round(h.tempF) : Math.round(h.tempC)}°
              </span>
              <span className="hour-desc" title={h.description}>
                {h.description}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="weather-maps">
        {multiScope ? (
          <div className="weather-scope-tabs" role="tablist" aria-label="Display scopes">
            {scopes.map((scope) => (
              <button
                key={scope.id}
                type="button"
                role="tab"
                aria-selected={focused?.id === scope.id}
                className={`btn btn-ghost weather-chip${focused?.id === scope.id ? " active" : ""}`}
                onClick={() => setActiveScope(scope.id)}
              >
                {scope.label}
              </button>
            ))}
          </div>
        ) : null}

        {multiScope ? (
          <div className="weather-scope-grid">
            {scopes.map((scope) => (
              <ScopeMap
                key={scope.id}
                scope={scope}
                overlay={overlay}
                highlighted={focused?.id === scope.id}
                onFocus={() => setActiveScope(scope.id)}
              />
            ))}
          </div>
        ) : focused ? (
          <ScopeMap scope={focused} overlay={overlay} highlighted />
        ) : !loading && !error ? (
          <p className="weather-empty">No scopes configured for this source.</p>
        ) : null}
      </div>

      {payload?.attribution ? (
        <footer className="weather-footer" title={payload.note ?? undefined}>
          {payload.attribution}
          {payload.note ? ` · ${payload.note}` : null}
        </footer>
      ) : null}
    </div>
  );
}

function ScopeMap({
  scope,
  overlay,
  highlighted,
  onFocus,
}: {
  scope: ScopeView;
  overlay: OverlayMode;
  highlighted?: boolean;
  onFocus?: () => void;
}) {
  const showRadar = overlay === "radar" || overlay === "both";
  const showSat = overlay === "satellite" || overlay === "both";

  return (
    <div
      className={`weather-scope${highlighted ? " is-active" : ""}`}
      role={onFocus ? "button" : undefined}
      tabIndex={onFocus ? 0 : undefined}
      onClick={onFocus}
      onKeyDown={
        onFocus
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocus();
              }
            }
          : undefined
      }
      aria-label={`${scope.label} map`}
    >
      <div className="weather-scope-label">
        <span>{scope.label}</span>
        <span className="mono">z{scope.zoom}</span>
      </div>
      <div className="weather-scope-body">
        <div
          className="weather-tile-grid"
          style={{
            gridTemplateColumns: `repeat(${scope.gridSize}, 1fr)`,
          }}
        >
          {scope.tiles.map((tile) => (
            <div className="weather-tile" key={`${tile.z}-${tile.x}-${tile.y}`}>
              <img src={tile.baseUrl} alt="" loading="eager" draggable={false} />
              {showRadar && tile.radarUrl ? (
                <img
                  className="weather-overlay radar"
                  src={tile.radarUrl}
                  alt=""
                  loading="eager"
                  draggable={false}
                />
              ) : null}
            </div>
          ))}
        </div>
        {showSat && scope.satelliteImageUrl ? (
          <img
            className="weather-sat-still"
            src={scope.satelliteImageUrl}
            alt={`${scope.label} satellite`}
            loading="eager"
            draggable={false}
          />
        ) : null}
      </div>
    </div>
  );
}
