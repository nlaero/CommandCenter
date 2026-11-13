import { Fragment } from "react";
import { getAdapter } from "../adapters/catalog";
import type { SourceConfig } from "../types";
import { BroadcastifyPanel } from "./BroadcastifyPanel";
import { IncidentPanel } from "./IncidentPanel";

type Props = {
  sourceId: string;
  source: SourceConfig;
};

/** Renders the active source inside a panel (including rotating slots). */
export function SourceBody({ sourceId, source }: Props) {
  const adapter = getAdapter(source.type);

  if (source.type === "incident.opendata") {
    return <IncidentPanel sourceId={sourceId} source={source} />;
  }

  if (source.type === "broadcastify.owner") {
    return <BroadcastifyPanel sourceId={sourceId} source={source} />;
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
