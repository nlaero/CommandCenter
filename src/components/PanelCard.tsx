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
  const rotation =
    panel.rotation?.enabled && panel.rotation.sourceIds.length >= 2
      ? panel.rotation
      : null;
  const flush =
    Boolean(rotation) ||
    source?.type === "incident.opendata" ||
    source?.type === "broadcastify.owner" ||
    panel.widget === "incident" ||
    panel.widget === "broadcastify" ||
    panel.widget === "rotate";

  return (
    <article className={`panel${editMode ? " panel-editable" : ""}`}>
      <header className="panel-header">
        <div className="panel-title">{panel.title}</div>
        <div className="panel-meta">
          {rotation ? `rotate · ${rotation.intervalSec}s` : panel.widget}
        </div>
      </header>
      <div className={`panel-body${flush ? " panel-body-flush" : ""}`}>
        {rotation ? (
          <RotatingPanel panel={panel} rotation={rotation} sources={sources} />
        ) : source ? (
          <SourceBody sourceId={panel.source} source={source} />
        ) : (
          <div style={{ padding: 10 }}>
            Bound to <strong>{panel.source}</strong> — source missing from config.
          </div>
        )}
      </div>
    </article>
  );
}
