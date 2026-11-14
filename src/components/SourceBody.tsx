import { Fragment, useMemo } from "react";
import { getAdapter } from "../adapters/catalog";
import { useSourceRevision } from "../lib/sourceRefresh";
import type { SourceConfig } from "../types";
import { BroadcastifyPanel } from "./BroadcastifyPanel";
import { CallsPanel } from "./CallsPanel";
import { CameraPanel } from "./CameraPanel";
import { SafetyPanel } from "./SafetyPanel";
import { IncidentPanel } from "./IncidentPanel";
import { NewsPanel } from "./NewsPanel";
import { QuakePanel } from "./QuakePanel";
import { WeatherPanel } from "./WeatherPanel";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

/** Renders the active source inside a panel (including rotating slots). */
export function SourceBody({ sourceId, source }: Props) {
  const adapter = getAdapter(source.type);
  const revision = useSourceRevision(sourceId);
  const syncedAt = useMemo(() => new Date(), [revision]);

  if (source.type === "incident.opendata") {
    return (
      <IncidentPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "broadcastify.owner") {
    return (
      <BroadcastifyPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "broadcastify.calls") {
    return (
      <CallsPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "safety.nearby") {
    return (
      <SafetyPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "weather.openmeteo") {
    return (
      <WeatherPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "usgs.earthquake") {
    return (
      <QuakePanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "news.rss") {
    return (
      <NewsPanel sourceId={sourceId} source={source} configRevision={revision} />
    );
  }

  if (source.type === "camera.http_image" || source.type === "video.youtube") {
    return <CameraPanel source={source} />;
  }

  return (
    <div className="source-stub">
      <div className="source-stub-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          Bound
        </span>
        <span className="incident-meta">
          {source.type}
          {source.refresh ? ` · ${source.refresh}` : null}
          {revision > 0
            ? ` · refreshed ${syncedAt.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}`
            : null}
        </span>
      </div>
      <div className="source-stub-body">
        <div className="source-stub-kicker">{adapter?.name ?? source.type}</div>
        <p>
          Bound to <strong>{sourceId}</strong>
        </p>
        <p className="source-stub-note">
          {adapter?.stubNote ??
            "Live data adapter is stubbed in Phase A. Layout, Settings, and rotation are active."}
        </p>
        {Object.keys(source.params).length > 0 ? (
          <dl className="incident-dl source-stub-params">
            {Object.entries(source.params).slice(0, 6).map(([key, value]) => (
              <Fragment key={key}>
                <dt>{key}</dt>
                <dd className="mono">{formatParam(value)}</dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function formatParam(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}
