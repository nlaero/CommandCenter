import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSourcePayload } from "../lib/api";
import type { NewsStory, SourceConfig, SourcePayload } from "../types";

type Props = {
  sourceId: string;
  source: SourceConfig;
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

function formatWait(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

export function NewsPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const knownIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const timerRef = useRef<number>(0);
  const loadRef = useRef<(manual: boolean) => void>(() => {});

  const stories = payload?.news?.stories ?? [];
  const selected = useMemo(
    () => stories.find((story) => story.id === selectedId) ?? null,
    [stories, selectedId],
  );

  useEffect(() => {
    let cancelled = false;

    async function load(manual: boolean) {
      window.clearTimeout(timerRef.current);
      try {
        if (!manual && !primed.current) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        const batch = next.news?.stories ?? [];
        const incoming: string[] = [];
        if (primed.current) {
          for (const story of batch) {
            if (!knownIds.current.has(story.id)) incoming.push(story.id);
          }
        } else {
          primed.current = true;
          if (batch[0]) setSelectedId(batch[0].id);
        }
        knownIds.current = new Set(batch.map((story) => story.id));
        setPayload(next);
        setError(null);
        if (incoming.length) {
          setFlashIds(new Set(incoming));
          window.setTimeout(() => {
            if (!cancelled) setFlashIds(new Set());
          }, 8_000);
          setSelectedId((current) => current ?? incoming[0]);
        }
        const wait = Math.max(1000, next.news?.pollAfterMs ?? 15 * 60_000);
        timerRef.current = window.setTimeout(() => void load(false), wait);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        timerRef.current = window.setTimeout(() => void load(false), 15 * 60_000);
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
    };
    // Settings save remounts the panel and bumps configRevision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const news = payload?.news;
  const failed = news?.feeds.filter((feed) => feed.error) ?? [];
  const cached = Boolean(news && news.feeds.length && news.feeds.every((feed) => feed.fromCache || feed.notModified));

  return (
    <div className="incident-panel news-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          News
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {news
            ? `${news.stories.length} · ${formatWhen(payload?.fetchedAt)} · next ${formatWait(news.pollAfterMs)}`
            : null}
          {cached ? " · cache" : null}
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
      {!error && failed.length && stories.length === 0 ? (
        <div className="alert error">
          {failed.map((feed) => `${feed.name}: ${feed.error}`).join(" ")}
        </div>
      ) : null}
      {!error && failed.length && stories.length > 0 ? (
        <div className="alert warn">
          {failed.map((feed) => `${feed.name}: ${feed.error}`).join(" ")}
        </div>
      ) : null}

      <div className="incident-layout">
        <div className="incident-feed" role="list" aria-label="News stories">
          {stories.map((story) => {
            const isNew = flashIds.has(story.id);
            const active = selectedId === story.id;
            return (
              <button
                key={story.id}
                type="button"
                role="listitem"
                className={`incident-alert sev-info${isNew ? " is-new" : ""}${active ? " is-active" : ""}`}
                onClick={() => setSelectedId(story.id)}
              >
                <div className="incident-alert-top">
                  <span className="news-scope">{story.scope}</span>
                  <span className="incident-when">{formatWhen(story.publishedAt)}</span>
                </div>
                <div className="incident-alert-title">{story.title}</div>
                <div className="incident-alert-sub">{story.outlet}</div>
              </button>
            );
          })}
          {!loading && payload && stories.length === 0 ? (
            <p className="incident-empty">No stories in these feeds.</p>
          ) : null}
        </div>
        <div className="incident-side">
          <div className="incident-detail">
            {selected ? (
              <StoryDetail story={selected} />
            ) : (
              <p className="incident-empty">Select a story.</p>
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

function StoryDetail({ story }: { story: NewsStory }) {
  return (
    <div>
      <div className="news-scope">{story.scope}</div>
      <h4 className="incident-detail-title">{story.title}</h4>
      <dl className="incident-dl">
        <dt>Outlet</dt>
        <dd>{story.outlet}</dd>
        {story.publishedAt ? (
          <>
            <dt>When</dt>
            <dd>{formatWhen(story.publishedAt)}</dd>
          </>
        ) : null}
        {story.summary ? (
          <>
            <dt>Summary</dt>
            <dd>{story.summary}</dd>
          </>
        ) : null}
      </dl>
      {story.url ? (
        <a className="incident-link" href={story.url} target="_blank" rel="noreferrer">
          Open story
        </a>
      ) : null}
    </div>
  );
}
