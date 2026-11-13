import { useEffect, useMemo, useState } from "react";
import { getAdapter } from "../adapters/catalog";
import type { Panel, PanelRotation, SourceConfig } from "../types";
import { SourceBody } from "./SourceBody";

type Props = {
  panel: Panel;
  rotation: PanelRotation;
  sources: Record<string, SourceConfig>;
};

function clampInterval(sec: number): number {
  if (!Number.isFinite(sec)) return 30;
  return Math.min(3600, Math.max(5, Math.round(sec)));
}

export function RotatingPanel({ panel, rotation, sources }: Props) {
  const sourceIds = useMemo(
    () => rotation.sourceIds.filter((id) => Boolean(sources[id])),
    [rotation.sourceIds, sources],
  );
  const intervalSec = clampInterval(rotation.intervalSec);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [remainingMs, setRemainingMs] = useState(intervalSec * 1000);
  const [tickKey, setTickKey] = useState(0);

  const safeIndex = sourceIds.length ? index % sourceIds.length : 0;
  const activeId = sourceIds[safeIndex] ?? panel.source;
  const activeSource = sources[activeId];

  useEffect(() => {
    setIndex(0);
    setRemainingMs(intervalSec * 1000);
    setTickKey((k) => k + 1);
  }, [sourceIds.join("|"), intervalSec]);

  useEffect(() => {
    if (paused || sourceIds.length < 2) return;
    const started = Date.now();
    const total = intervalSec * 1000;
    setRemainingMs(total);
    const countdown = window.setInterval(() => {
      const left = Math.max(0, total - (Date.now() - started));
      setRemainingMs(left);
    }, 200);
    const advance = window.setTimeout(() => {
      setIndex((i) => (i + 1) % sourceIds.length);
      setTickKey((k) => k + 1);
    }, total);
    return () => {
      window.clearInterval(countdown);
      window.clearTimeout(advance);
    };
  }, [paused, sourceIds, intervalSec, tickKey]);

  function goNext() {
    if (sourceIds.length < 2) return;
    setIndex((i) => (i + 1) % sourceIds.length);
    setTickKey((k) => k + 1);
    setRemainingMs(intervalSec * 1000);
  }

  function goPrev() {
    if (sourceIds.length < 2) return;
    setIndex((i) => (i - 1 + sourceIds.length) % sourceIds.length);
    setTickKey((k) => k + 1);
    setRemainingMs(intervalSec * 1000);
  }

  const adapterName = activeSource
    ? getAdapter(activeSource.type)?.name ?? activeSource.type
    : "Missing source";
  const progress = paused ? 0 : 1 - remainingMs / (intervalSec * 1000);

  return (
    <div className="rotate-panel">
      <div className="rotate-toolbar" role="status">
        <span className="incident-live">
          <span className={`live-dot${paused ? " is-paused" : ""}`} aria-hidden />
          {paused ? "Paused" : "Rotating"}
        </span>
        <span className="rotate-slot mono">
          {safeIndex + 1}/{sourceIds.length || 1}
        </span>
        <span className="rotate-active" title={activeId}>
          {adapterName}
        </span>
        <div className="rotate-dots" aria-label="Rotation sources">
          {sourceIds.map((id, i) => (
            <button
              key={id}
              type="button"
              className={`rotate-dot${i === safeIndex ? " is-active" : ""}`}
              title={id}
              aria-label={`Show ${id}`}
              onClick={() => {
                setIndex(i);
                setTickKey((k) => k + 1);
                setRemainingMs(intervalSec * 1000);
              }}
            />
          ))}
        </div>
        <span className="rotate-countdown mono">
          {paused ? "—" : `${Math.ceil(remainingMs / 1000)}s`}
        </span>
        <div className="rotate-actions">
          <button type="button" className="btn btn-ghost rotate-btn" onClick={goPrev}>
            Prev
          </button>
          <button
            type="button"
            className="btn btn-ghost rotate-btn"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" className="btn btn-ghost rotate-btn" onClick={goNext}>
            Next
          </button>
        </div>
        <div className="rotate-progress" aria-hidden>
          <div className="rotate-progress-bar" style={{ width: `${Math.max(0, progress * 100)}%` }} />
        </div>
      </div>

      <div className="rotate-stage" key={`${activeId}-${tickKey}`}>
        {activeSource ? (
          <SourceBody sourceId={activeId} source={activeSource} />
        ) : (
          <div className="alert error" style={{ margin: 10 }}>
            Source missing: {activeId}
          </div>
        )}
      </div>
    </div>
  );
}
