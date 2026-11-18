import { useEffect, useState } from "react";
import { getAdapter } from "../adapters/catalog";
import { fetchSourcePayload } from "../lib/api";
import { useAlerts } from "../lib/alerts";
import { watchItemsToBoardAlerts } from "../lib/boardAlerts";
import type { SourceConfig, SourcePayload, WatchItem } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
  configRevision?: number;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 60_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(15_000, n * 1000);
  if (unit === "h") return Math.max(60_000, n * 60 * 60_000);
  return Math.max(15_000, n * 60_000);
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

export function WatchPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();
  const name = getAdapter(source.type)?.name ?? source.type;

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    async function load() {
      try {
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        setPayload(next);
        setError(null);
        publishSourceAlerts(
          sourceId,
          watchItemsToBoardAlerts({
            sourceId,
            sourceType: source.type,
            sourceLabel: name,
            items: next.watch?.items ?? [],
          }),
        );
        const wait = Math.max(next.watch?.pollAfterMs ?? parseRefreshMs(source.refresh), 15_000);
        timer = window.setTimeout(() => void load(), wait);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = window.setTimeout(() => void load(), parseRefreshMs(source.refresh));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      clearSourceAlerts(sourceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.type, source.refresh, JSON.stringify(source.params), configRevision]);

  const watch = payload?.watch;
  const items = watch?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  return (
    <div className="incident-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          {name}
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {watch?.placeLabel ? ` ${watch.placeLabel}` : ""}
          {payload ? ` · ${formatWhen(payload.fetchedAt)}` : ""}
        </span>
      </div>
      {error ? <div className="alert error">{error}</div> : null}
      {watch?.headline ? <p className="incident-alert-title">{watch.headline}</p> : null}
      {watch?.status ? <p className="help">{watch.status}</p> : null}
      <div className="incident-layout">
        <div className="incident-feed" role="list" aria-label={name}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`incident-alert sev-${item.severity ?? "info"}${selected?.id === item.id ? " is-active" : ""}`}
              onClick={() => setSelectedId(item.id)}
            >
              <div className="incident-alert-top">
                <span className="incident-sev">{item.severity ?? "info"}</span>
                <span className="incident-when">{formatWhen(item.occurredAt)}</span>
              </div>
              <div className="incident-alert-title">{item.title}</div>
              {item.summary ? <div className="incident-alert-sub">{item.summary}</div> : null}
            </button>
          ))}
          {!loading && items.length === 0 ? (
            <p className="incident-empty">{watch?.status ?? "Nothing in range right now."}</p>
          ) : null}
        </div>
        <div className="incident-side">
          <div className="incident-detail">
            {selected ? <WatchDetail item={selected} /> : <p className="incident-empty">Select a row.</p>}
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

function WatchDetail({ item }: { item: WatchItem }) {
  return (
    <div>
      <h4 className="incident-detail-title">{item.title}</h4>
      <dl className="incident-dl">
        {item.area ? (
          <>
            <dt>Area</dt>
            <dd>{item.area}</dd>
          </>
        ) : null}
        {item.category ? (
          <>
            <dt>Kind</dt>
            <dd>{item.category}</dd>
          </>
        ) : null}
        {item.occurredAt ? (
          <>
            <dt>When</dt>
            <dd>{formatWhen(item.occurredAt)}</dd>
          </>
        ) : null}
        {item.endsAt ? (
          <>
            <dt>Until</dt>
            <dd>{formatWhen(item.endsAt)}</dd>
          </>
        ) : null}
        {(item.metrics ?? []).map((metric) => (
          <span key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </span>
        ))}
        {item.body ? (
          <>
            <dt>Detail</dt>
            <dd>{item.body}</dd>
          </>
        ) : null}
      </dl>
      {item.detailUrl ? (
        <a className="incident-link" href={item.detailUrl} target="_blank" rel="noreferrer">
          Open source
        </a>
      ) : null}
    </div>
  );
}
