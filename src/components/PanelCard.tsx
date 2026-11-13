import type { Panel, SourceConfig } from "../types";
import { getAdapter } from "../adapters/catalog";
import { IncidentPanel } from "./IncidentPanel";

type Props = {
  panel: Panel;
  source?: SourceConfig;
  editMode?: boolean;
};

export function PanelCard({ panel, source, editMode }: Props) {
  const adapter = source ? getAdapter(source.type) : undefined;
  const isIncident = source?.type === "incident.opendata" || panel.widget === "incident";

  return (
    <article className={`panel${editMode ? " panel-editable" : ""}`}>
      <header className="panel-header">
        <div className="panel-title">{panel.title}</div>
        <div className="panel-meta">{panel.widget}</div>
      </header>
      <div className={`panel-body${isIncident ? " panel-body-flush" : ""}`}>
        {isIncident && source ? (
          <IncidentPanel sourceId={panel.source} source={source} />
        ) : (
          <>
            <div>
              Bound to <strong>{panel.source}</strong>
              {source ? ` · ${source.type}` : null}
            </div>
            <div style={{ marginTop: 8 }}>
              {adapter?.stubNote ??
                "Live data adapter is stubbed in Phase A. Layout and persistence are active."}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
