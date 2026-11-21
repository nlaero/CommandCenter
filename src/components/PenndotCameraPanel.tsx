import { useEffect, useState } from "react";
import { fetchSourcePayload } from "../lib/api";
import {
  cameraCount,
  cameraGridColumns,
  cameraRotateSec,
  camerasRotate,
  visibleCameras,
} from "../lib/penndotCameras";
import type { SourceConfig, SourcePayload, TrafficCamera } from "../types";
import { TrafficStill } from "./TrafficStill";

type Props = {
  sourceId: string;
  source: SourceConfig;
  configRevision?: number;
};

function parseRefreshMs(refresh?: string): number {
  if (!refresh) return 2 * 60_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 2 * 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "s") return Math.max(30_000, n * 1000);
  if (unit === "m") return Math.max(60_000, n * 60_000);
  return Math.max(60_000, n * 60 * 60_000);
}

export function PenndotCameraPanel({ sourceId, source, configRevision = 0 }: Props) {
  const [payload, setPayload] = useState<SourcePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [stamp, setStamp] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load(isPoll: boolean) {
      try {
        if (!isPoll) setLoading(true);
        const next = await fetchSourcePayload(sourceId, source);
        if (cancelled) return;
        setPayload(next);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load(false);
    const timer = window.setInterval(() => void load(true), parseRefreshMs(source.refresh));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Settings save remounts the panel and bumps configRevision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const cameras = payload?.traffic?.cameras ?? [];
  const count = cameraCount(source.params.cameraCount);
  const rotate = camerasRotate(source.params.rotateCameras) && cameras.length > count;
  const seconds = cameraRotateSec(source.params.cameraRotateSec);
  const placeKey = cameras.map((camera) => camera.id).join("|");

  useEffect(() => {
    setIndex(0);
  }, [placeKey, count]);

  useEffect(() => {
    if (!rotate) return;
    const timer = window.setInterval(() => setIndex((current) => current + 1), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [rotate, seconds, placeKey, count]);

  useEffect(() => {
    const timer = window.setInterval(() => setStamp(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = visibleCameras(cameras, count, index, rotate);
  const columns = cameraGridColumns(visible.length);
  const rows = Math.max(1, Math.ceil(visible.length / columns));
  const radius = payload?.traffic?.radiusMi;

  return (
    <div className="penndot-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          PennDOT
        </span>
        <span className="incident-meta">
          {loading && !payload ? "Loading…" : null}
          {payload?.traffic?.label ? `${payload.traffic.label} · ` : null}
          {radius ? `${radius} mi · ` : null}
          {cameras.length
            ? rotate
              ? `Rotating ${visible.length} of ${cameras.length} every ${seconds}s`
              : `${visible.length} of ${cameras.length} on screen`
            : null}
        </span>
      </div>
      {error ? <div className="alert error">{error}</div> : null}
      {visible.length ? (
        <div
          className="penndot-grid"
          data-count={visible.length}
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {visible.map((camera) => (
            <CameraCell key={camera.id} camera={camera} stamp={stamp} />
          ))}
        </div>
      ) : (
        <p className="incident-empty">
          {loading ? "Looking for cameras…" : "No PennDOT cameras are inside this distance."}
        </p>
      )}
      {payload?.note ? <footer className="traffic-foot">{payload.note}</footer> : null}
    </div>
  );
}

function CameraCell({ camera, stamp }: { camera: TrafficCamera; stamp: number }) {
  const [viewIndex, setViewIndex] = useState(0);
  const [broken, setBroken] = useState(false);
  const view = camera.views[viewIndex] ?? camera.views[0];
  const place = [camera.road, camera.county].filter(Boolean).join(" · ");
  return (
    <figure className="penndot-cell">
      {view && !broken ? (
        <TrafficStill
          key={view.id}
          src={`${view.imageUrl}?t=${Math.floor(stamp / 60_000)}`}
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="traffic-video-fit">
          <div className="penndot-missing">This camera did not return a picture.</div>
        </div>
      )}
      <figcaption>
        <span className="penndot-name">{camera.name}</span>
        {place ? <span className="penndot-place">{place}</span> : null}
        {camera.views.length > 1 ? (
          <span className="penndot-views" role="group" aria-label={`${camera.name} views`}>
            {camera.views.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`btn btn-ghost${index === viewIndex ? " active" : ""}`}
                onClick={() => {
                  setBroken(false);
                  setViewIndex(index);
                }}
              >
                {item.label}
              </button>
            ))}
          </span>
        ) : view ? (
          <span className="penndot-place">{view.label}</span>
        ) : null}
      </figcaption>
    </figure>
  );
}
