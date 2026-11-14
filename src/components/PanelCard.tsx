import { useSourceRevision } from "../lib/sourceRefresh";
import type { Panel, SourceConfig } from "../types";
import { RotatingPanel } from "./RotatingPanel";
import { SourceBody } from "./SourceBody";

type Props = {
  panel: Panel;
  source?: SourceConfig;
  sources: Record<string, SourceConfig>;
  editMode?: boolean;
};

export function PanelCard({ panel, source, sources, editMode }: Props) {
  const revision = useSourceRevision(panel.source);
  const rotation =
    panel.rotation?.enabled && panel.rotation.sourceIds.length >= 2
      ? panel.rotation
      : null;
  const cameraTitle =
    (source?.type === "camera.http_image" || source?.type === "video.youtube") &&
    typeof source.params.label === "string"
      ? source.params.label.trim()
      : "";
  const flush =
    Boolean(rotation) ||
    source?.type === "incident.opendata" ||
    source?.type === "broadcastify.owner" ||
    source?.type === "broadcastify.calls" ||
    source?.type === "weather.openmeteo" ||
    source?.type === "usgs.earthquake" ||
    source?.type === "camera.http_image" ||
    source?.type === "video.youtube" ||
    panel.widget === "incident" ||
    panel.widget === "broadcastify" ||
    panel.widget === "calls" ||
    panel.widget === "weather" ||
    panel.widget === "quake" ||
    panel.widget === "video" ||
    panel.widget === "rotate";

  return (
    <article className={`panel${editMode ? " panel-editable" : ""}`}>
      <header className="panel-header">
        <div className="panel-title">{cameraTitle || panel.title}</div>
        <div className="panel-meta">
          {rotation ? `rotate · ${rotation.intervalSec}s` : panel.widget}
        </div>
      </header>
      <div className={`panel-body${flush ? " panel-body-flush" : ""}`}>
        {rotation ? (
          <RotatingPanel panel={panel} rotation={rotation} sources={sources} />
        ) : source ? (
          // Remount on Settings save so every source type (live + stub) refetches.
          <SourceBody
            key={`${panel.source}-r${revision}`}
            sourceId={panel.source}
            source={source}
          />
        ) : (
          <div style={{ padding: 10 }}>
            Bound to <strong>{panel.source}</strong> — source missing from config.
          </div>
        )}
      </div>
    </article>
  );
}
