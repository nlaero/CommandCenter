import { useEffect, useMemo, useState } from "react";
import { readLocationState } from "../lib/location";
import {
  cachedFeed,
  feedsFor,
  storeFeed,
} from "../lib/publicCameraFeeds";
import {
  PUBLIC_CAMERAS,
  applyPublicCamera,
  cameraPlaybackNote,
  formatMiles,
  mergeCameras,
  recommendationNote,
  searchCameras,
  selectedPublicCamera,
  type CameraBand,
  type CameraHit,
  type PublicCamera,
} from "../lib/publicCameras";
import { fetchMedia } from "../lib/streamMedia";

type Props = {
  params: Record<string, unknown>;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
};

const LOCATION_FIELD = { key: "location", latKey: "nearLat", lonKey: "nearLon" };

const BAND_TITLE: Record<CameraBand, string> = {
  near: "Near you",
  metro: "In the area",
  farther: "Farther out",
};

function mediaLabel(camera: PublicCamera): string {
  if (camera.media === "image") return "Still";
  if (camera.media === "youtube") return "YouTube";
  if (camera.media === "file") return "Video";
  return "Live";
}

function groups(hits: CameraHit[], searching: boolean): { title: string; hits: CameraHit[] }[] {
  if (hits.every((hit) => hit.band == null)) {
    return [{ title: searching ? "Results" : "Suggestions", hits }];
  }
  return (["near", "metro", "farther"] as const)
    .map((band) => ({ title: BAND_TITLE[band], hits: hits.filter((hit) => hit.band === band) }))
    .filter((group) => group.hits.length > 0);
}

export function PublicCamerasField({ params, disabled, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [remote, setRemote] = useState<PublicCamera[]>([]);
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const place = readLocationState(params, LOCATION_FIELD).confirmed;
  const nearLat = place?.lat;
  const nearLon = place?.lon;
  const near =
    nearLat != null && nearLon != null ? { lat: nearLat, lon: nearLon } : null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const here =
      nearLat != null && nearLon != null ? { lat: nearLat, lon: nearLon } : null;
    const feeds = feedsFor(debounced, here);
    const controller = new AbortController();
    let cancelled = false;
    const cached = feeds.flatMap((feed) => cachedFeed(feed.id) ?? []);
    setRemote(cached);
    const missing = feeds.filter((feed) => !cachedFeed(feed.id));
    if (!missing.length) {
      setLooking(false);
      setNote(null);
      return () => controller.abort();
    }
    setLooking(true);
    setNote(null);
    void (async () => {
      const found = [...cached];
      const failed: string[] = [];
      for (const feed of missing) {
        try {
          const bytes = await fetchMedia(feed.url, { signal: controller.signal });
          const parsed = feed.parse(JSON.parse(new TextDecoder().decode(bytes.data)));
          storeFeed(feed.id, parsed);
          found.push(...parsed);
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            return;
          }
          failed.push(feed.title);
        }
      }
      if (cancelled) return;
      setRemote(found);
      setLooking(false);
      setNote(failed.length ? `Couldn't reach ${failed.join(" and ")} just now. The saved list is still here.` : null);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debounced, nearLat, nearLon]);

  const pool = useMemo(() => mergeCameras(PUBLIC_CAMERAS, remote), [remote]);
  const hits = searchCameras(pool, query, near);
  const selected = selectedPublicCamera(params, pool);
  const searching = query.trim().length > 0;
  const sections = groups(hits, searching);
  const farNote = searching ? null : recommendationNote(hits, Boolean(near));

  function choose(camera: PublicCamera) {
    if (disabled || params.cameraId === camera.id) return;
    onChange(applyPublicCamera(params, camera));
  }

  return (
    <div className="camera-picker">
      <input
        type="search"
        value={query}
        placeholder="Search name, road, or city"
        aria-label="Search public cameras"
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      {looking ? <p className="camera-picker-note">Checking published catalogs…</p> : null}
      {note ? <p className="camera-picker-note">{note}</p> : null}
      {farNote ? <p className="camera-picker-note">{farNote}</p> : null}
      {hits.length === 0 ? (
        <p className="camera-picker-note">No camera matches that.</p>
      ) : (
        <div className="camera-results">
          {sections.map((section) => (
            <div key={section.title} className="camera-group">
              <p className="section-label">{section.title}</p>
              {section.hits.map((hit) => {
                const active = selected?.id === hit.camera.id;
                const miles = hit.miles == null ? "" : formatMiles(hit.miles);
                return (
                  <button
                    key={hit.camera.id}
                    type="button"
                    className={`camera-hit${active ? " is-selected" : ""}`}
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => choose(hit.camera)}
                  >
                    <strong>{hit.camera.name}</strong>
                    <span>
                      {hit.camera.place}
                      {miles ? ` · ${miles}` : ""}
                      {" · "}
                      {mediaLabel(hit.camera)}
                      {" · "}
                      {hit.camera.agency}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {searching && hits.length >= 30 ? (
            <p className="camera-picker-note">Showing 30 matches.</p>
          ) : null}
        </div>
      )}
      {selected ? (
        <div className="camera-summary">
          <strong>{selected.name}</strong>
          <span>
            {selected.place}
            {selected.agency ? ` · ${selected.agency}` : ""}
          </span>
          <span>{cameraPlaybackNote(selected.media)}</span>
          {selected.attribution ? <span>{selected.attribution}</span> : null}
        </div>
      ) : (
        <p className="camera-picker-note">Pick a camera. Its link and refresh are filled in for you.</p>
      )}
    </div>
  );
}
