import { useEffect, useMemo, useRef, useState } from "react";
import { applyCorrections, readLocalMemory } from "../lib/aiMemory";
import { useAlerts } from "../lib/alerts";
import { incidentsToBoardAlerts } from "../lib/boardAlerts";
import { activeCaptionAt, type CaptionSegment } from "../lib/captions";
import { confirmedPlaceLabel, readCoords } from "../lib/location";
import {
  SPEAKER_GAP,
  feedProblem,
  foldTransmission,
  formatMiles,
  formatRadioTranscript,
  insideRadius,
  learnPerson,
  loadKnownPeople,
  milesBetween,
  nextIncidentId,
  personFromVoice,
  personPhrase,
  clampRadius,
  readFeeds,
  readPreparedTransmission,
  saveKnownPeople,
  stateFullName,
  transcriptText,
  type KnownPerson,
  type OpenIncident,
  type SafetyFeed,
} from "../lib/safety";
import { isFeedOwnerAudio, subscribeFeedCaptions } from "../lib/feedCaptions";
import { listenSafetyFeed, listensOnDevice, placeHeardAddress, type SafetyWindow } from "../lib/safetyListen";
import type { Incident, SourceConfig } from "../types";
import { CaptionCorrection, withCorrections } from "./LocalAiPanel";

type Props = {
  sourceId: string;
  source: SourceConfig;
  configRevision?: number;
};

type RadioTx = {
  id: string;
  at: string;
  text: string;
  callingUnitId: string | null;
  personId: string | null;
  audioUrl: string | null;
  segments: CaptionSegment[];
};

type Hit = {
  id: string;
  nearby: boolean;
  miles: number;
  feedName: string;
  units: OpenIncident["units"];
  transmissions: RadioTx[];
  incident: Incident;
  note: string;
};

function monitorMs(refresh?: string): number {
  if (!refresh) return 60_000;
  const match = refresh.trim().match(/^(\d+)\s*([smh])$/i);
  if (!match) return 60_000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 60 * 60_000;
  return Math.max(45_000, ms);
}

function severityClass(severity?: Incident["severity"]): string {
  if (severity === "alert") return "sev-alert";
  if (severity === "warn") return "sev-warn";
  return "sev-info";
}

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

export function SafetyPanel({ sourceId, source, configRevision = 0 }: Props) {
  const feeds = useMemo(() => readFeeds(source.params.feeds), [source.params]);
  const radius = clampRadius(source.params.radiusMi) ?? 10;
  const home = readCoords(source.params);
  const place = confirmedPlaceLabel(source.params) ?? (home ? "Saved location" : null);
  const captionsOn = source.params.enableCaptions !== false;
  const [hits, setHits] = useState<Hit[]>([]);
  const [lines, setLines] = useState<Record<string, string>>({});
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [showCaptions, setShowCaptions] = useState(captionsOn);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [people, setPeople] = useState<KnownPerson[]>(() => loadKnownPeople());
  const { publishSourceAlerts, clearSourceAlerts } = useAlerts();

  useEffect(() => {
    setShowCaptions(captionsOn);
  }, [captionsOn]);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let samplePlayed = false;
    let known = new Set<string>();
    let current: Hit[] = [];
    let flashTimer: number | undefined;

    function publish(list: Hit[]) {
      publishSourceAlerts(
        sourceId,
        incidentsToBoardAlerts({
          sourceId,
          sourceType: source.type,
          sourceLabel: "Nearby public safety",
          incidents: list.filter((hit) => hit.nearby).map((hit) => hit.incident),
        }),
      );
    }

    function remember(next: Hit[]) {
      current = next;
      if (cancelled) return;
      setHits(next);
      publish(next);
      const incoming = next.filter((hit) => !known.has(hit.id)).map((hit) => hit.id);
      known = new Set(next.map((hit) => hit.id));
      if (incoming.length) {
        setFlashIds(new Set(incoming));
        if (flashTimer) window.clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => setFlashIds(new Set()), 8_000);
      }
      setSelectedId((cur) => {
        if (cur && next.some((hit) => hit.id === cur)) return cur;
        return next.find((hit) => hit.nearby)?.id ?? next[0]?.id ?? null;
      });
    }

    async function consider(feed: SafetyFeed, heard: SafetyWindow) {
      if (heard.engine === "preview") setPreviewNote(heard.note);
      const text = transcriptText(heard.segments);
      const read = readPreparedTransmission(text, (value) => applyCorrections(value, readLocalMemory()));
      const open = current.map((hit) => ({ id: hit.id, units: hit.units }));
      const createId = read.heardAddress
        ? nextIncidentId(
            feed.id,
            {
              dispatchType: read.dispatchType ?? "Dispatch",
              heardAddress: read.heardAddress,
            },
            open,
          )
        : `${feed.id}:unplaced`;
      const folded = foldTransmission(open, read, createId);
      if (!text || !home || folded.action === "ignored" || !folded.incidentId) {
        if (heard.audioUrl) URL.revokeObjectURL(heard.audioUrl);
        if (!cancelled) {
          setLines((prev) => ({
            ...prev,
            [feed.id]: !text
              ? heard.note || "No words in that window."
              : read.callingUnitId
                ? `${read.callingUnitId} is not on an open incident.`
                : "No street address in that window.",
          }));
        }
        return;
      }

      const voiceKey = voiceKeyOf(heard.segments);
      let roster = loadKnownPeople();
      const learned = learnPerson(roster, voiceKey, read.callingUnitId);
      if (learned !== roster) {
        roster = learned;
        saveKnownPeople(roster);
      }
      setPeople(roster);
      const personId = personFromVoice(voiceKey, roster);
      const tx: RadioTx = {
        id: `${folded.incidentId}:${Date.now()}:${current.reduce((sum, hit) => sum + hit.transmissions.length, 0)}`,
        at: new Date().toISOString(),
        text,
        callingUnitId: read.callingUnitId,
        personId,
        audioUrl: heard.audioUrl,
        segments: heard.segments,
      };

      if (folded.action === "created") {
        const placed = read.heardAddress
          ? await placeHeardAddress(read.heardAddress, feed.county, feed.state)
          : null;
        if (cancelled) {
          if (heard.audioUrl) URL.revokeObjectURL(heard.audioUrl);
          return;
        }
        if (!placed || !read.heardAddress) {
          if (heard.audioUrl) URL.revokeObjectURL(heard.audioUrl);
          setLines((prev) => ({
            ...prev,
            [feed.id]: `Could not place "${read.heardAddress ?? "that call"}" in ${feed.county} County, ${stateFullName(feed.state)}.`,
          }));
          return;
        }
        const miles = milesBetween(home, placed);
        const nearby = insideRadius(miles, radius);
        const units = folded.open.find((item) => item.id === folded.incidentId)?.units ?? [];
        const transmissions = [tx];
        const where = `${placed.label} · ${formatMiles(miles)}${nearby ? "" : ` · outside ${radius} mi`}`;
        const incident = incidentFrom({
          id: folded.incidentId,
          feedName: feed.name,
          miles,
          units,
          transmissions,
          roster,
          title: `${read.dispatchType ?? "Dispatch"} · ${read.heardAddress}`,
          category: read.dispatchType ?? "Dispatch",
          severity: read.severity ?? "warn",
          where,
          lat: placed.lat,
          lon: placed.lon,
          at: tx.at,
        });
        remember(
          dropOld([
            ...current,
            {
              id: folded.incidentId,
              nearby,
              miles,
              feedName: feed.name,
              units,
              transmissions,
              incident,
              note: heard.note,
            },
          ]),
        );
        setLines((prev) => ({
          ...prev,
          [feed.id]: `${incident.category} · ${unitLine(units)}${nearby ? "" : " · outside your radius"}`,
        }));
        return;
      }

      const unitsById = new Map(folded.open.map((item) => [item.id, item.units]));
      const next = current.map((hit) => {
        const units = unitsById.get(hit.id) ?? hit.units;
        if (hit.id !== folded.incidentId) return { ...hit, units };
        const transmissions = [...hit.transmissions, tx];
        return {
          ...hit,
          units,
          transmissions,
          incident: incidentFrom({
            id: hit.id,
            feedName: hit.feedName,
            miles: hit.miles,
            units,
            transmissions,
            roster,
            title: hit.incident.title,
            category: hit.incident.category ?? "Dispatch",
            severity: hit.incident.severity ?? "warn",
            where: hit.incident.address ?? "",
            lat: hit.incident.lat ?? 0,
            lon: hit.incident.lon ?? 0,
            at: hit.incident.occurredAt ?? tx.at,
          }),
        };
      });
      remember(next);
      const joined = next.find((hit) => hit.id === folded.incidentId);
      setLines((prev) => ({
        ...prev,
        [feed.id]: joined
          ? `${joined.incident.category ?? "Dispatch"} · ${unitLine(joined.units)}`
          : heard.note,
      }));
    }

    let ownerWaiting = false;

    async function cycle() {
      if (running || cancelled || !home) return;
      const onDevice = listensOnDevice();
      if (!onDevice && samplePlayed) return;
      running = true;
      try {
        for (let index = 0; index < feeds.length; index += 1) {
          const feed = feeds[index];
          if (!feed || cancelled) return;
          if (!onDevice && index > 0 && !isFeedOwnerAudio(feed)) {
            setLines((prev) => ({
              ...prev,
              [feed.id]: "Browser preview plays the sample on the first feed so the same unit is not dispatched twice.",
            }));
            continue;
          }
          const problem = feedProblem(feed);
          if (problem) {
            setLines((prev) => ({ ...prev, [feed.id]: problem }));
            continue;
          }
          setListeningId(feed.id);
          if (!isFeedOwnerAudio(feed)) {
            setLines((prev) => ({ ...prev, [feed.id]: "Listening…" }));
          }
          try {
            const windows = await listenSafetyFeed(feed);
            if (!windows.length && isFeedOwnerAudio(feed)) {
              if (!cancelled) {
                setLines((prev) => ({
                  ...prev,
                  [feed.id]:
                    prev[feed.id] && prev[feed.id] !== "Listening…"
                      ? prev[feed.id]
                      : "Waiting for live captions from the Feed Owner panel.",
                }));
              }
              continue;
            }
            if (cancelled) {
              for (const heard of windows) {
                if (heard.audioUrl) URL.revokeObjectURL(heard.audioUrl);
              }
              return;
            }
            for (const heard of windows) {
              if (cancelled) return;
              await consider(feed, heard);
            }
          } catch (err) {
            if (!cancelled) {
              setLines((prev) => ({
                ...prev,
                [feed.id]: err instanceof Error ? err.message : String(err),
              }));
            }
          } finally {
            if (!cancelled) setListeningId((cur) => (cur === feed.id ? null : cur));
          }
        }
        if (!cancelled && !onDevice) samplePlayed = true;
      } finally {
        running = false;
        if (ownerWaiting && !cancelled) {
          ownerWaiting = false;
          void readOwners();
        }
      }
    }

    async function readOwners() {
      if (!feeds.some((feed) => isFeedOwnerAudio(feed))) return;
      if (running || cancelled || !home) {
        ownerWaiting = true;
        return;
      }
      running = true;
      try {
        for (const feed of feeds) {
          if (!feed || cancelled || !isFeedOwnerAudio(feed)) continue;
          const problem = feedProblem(feed);
          if (problem) {
            setLines((prev) => ({ ...prev, [feed.id]: problem }));
            continue;
          }
          try {
            const windows = await listenSafetyFeed(feed);
            for (const heard of windows) {
              if (cancelled) return;
              await consider(feed, heard);
            }
          } catch (err) {
            if (!cancelled) {
              setLines((prev) => ({
                ...prev,
                [feed.id]: err instanceof Error ? err.message : String(err),
              }));
            }
          }
        }
      } finally {
        running = false;
        if (ownerWaiting && !cancelled) {
          ownerWaiting = false;
          void readOwners();
        }
      }
    }

    void cycle();
    const timer = window.setInterval(() => void cycle(), monitorMs(source.refresh));
    const unsubscribe = subscribeFeedCaptions(() => {
      void readOwners();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
      if (flashTimer) window.clearTimeout(flashTimer);
      for (const hit of current) {
        for (const tx of hit.transmissions) {
          if (tx.audioUrl) URL.revokeObjectURL(tx.audioUrl);
        }
      }
      clearSourceAlerts(sourceId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, source.refresh, source.type, JSON.stringify(source.params), configRevision]);

  const ordered = useMemo(() => {
    return [...hits].sort((a, b) => {
      if (a.nearby !== b.nearby) return a.nearby ? -1 : 1;
      return Date.parse(b.incident.occurredAt ?? "") - Date.parse(a.incident.occurredAt ?? "");
    });
  }, [hits]);
  const selected = ordered.find((hit) => hit.id === selectedId) ?? null;

  function correctHit(hit: Hit, txId: string, segments: CaptionSegment[]) {
    const text = transcriptText(segments);
    const read = readPreparedTransmission(text, (value) => applyCorrections(value, readLocalMemory()));
    setHits((prev) => {
      const next = prev.map((item) => {
        if (item.id !== hit.id) return item;
        const transmissions = item.transmissions.map((tx) =>
          tx.id === txId ? { ...tx, segments, text, callingUnitId: read.callingUnitId } : tx,
        );
        return {
          ...item,
          transmissions,
          incident: incidentFrom({
            id: item.id,
            feedName: item.feedName,
            miles: item.miles,
            units: item.units,
            transmissions,
            roster: people,
            title: item.incident.title,
            category: item.incident.category ?? "Dispatch",
            severity: item.incident.severity ?? "warn",
            where: item.incident.address ?? "",
            lat: item.incident.lat ?? 0,
            lon: item.incident.lon ?? 0,
            at: item.incident.occurredAt ?? transmissions[0]?.at ?? "",
          }),
        };
      });
      publishSourceAlerts(
        sourceId,
        incidentsToBoardAlerts({
          sourceId,
          sourceType: source.type,
          sourceLabel: "Nearby public safety",
          incidents: next.filter((item) => item.nearby).map((item) => item.incident),
        }),
      );
      return next;
    });
  }

  return (
    <div className="incident-panel safety-panel">
      <div className="incident-toolbar">
        <span className="incident-live">
          <span className="live-dot" aria-hidden />
          {listeningId ? "Listening" : "Nearby"}
        </span>
        <span className="incident-meta">
          {place ? `${place} · ${radius} mi` : "Location missing"}
          {feeds.length ? ` · ${feeds.length} feed${feeds.length === 1 ? "" : "s"}` : ""}
        </span>
        {captionsOn ? (
          <label className="bcfy-cc-toggle" title="Closed captions">
            <input
              type="checkbox"
              checked={showCaptions}
              onChange={(event) => setShowCaptions(event.target.checked)}
            />
            <span className={`bcfy-cc-badge${showCaptions ? " on" : ""}`}>CC</span>
          </label>
        ) : null}
      </div>

      {!home ? (
        <div className="alert error">
          This source has no confirmed location. Open Settings and find the place again.
        </div>
      ) : null}

      <div className="incident-layout">
        <div className="incident-feed" role="list" aria-label="Nearby public safety alerts">
          {ordered.map((hit) => (
            <button
              key={hit.id}
              type="button"
              role="listitem"
              className={`incident-alert ${severityClass(hit.incident.severity)}${
                flashIds.has(hit.id) ? " is-new" : ""
              }${selectedId === hit.id ? " is-active" : ""}${hit.nearby ? "" : " is-outside"}`}
              onClick={() => setSelectedId(hit.id)}
            >
              <div className="incident-alert-top">
                <span className={`incident-sev ${severityClass(hit.incident.severity)}`}>
                  {hit.incident.category ?? hit.incident.severity}
                </span>
                <span className="incident-when">{formatWhen(hit.incident.occurredAt)}</span>
              </div>
              <div className="incident-alert-title">{hit.incident.title}</div>
              <div className="incident-alert-sub">
                {hit.feedName}
                {` · ${unitLine(hit.units)}`}
                {` · ${hit.transmissions.length} transmission${hit.transmissions.length === 1 ? "" : "s"}`}
                {hit.incident.audioUrl ? <span className="audio-tag">audio</span> : null}
                {hit.incident.transcript ? <span className="audio-tag cc-tag">cc</span> : null}
              </div>
            </button>
          ))}
          {ordered.length === 0 ? (
            <p className="incident-empty">
              {home
                ? `Listening for a dispatch with a street address inside ${radius} miles.`
                : "Set a location and at least one feed in Settings."}
            </p>
          ) : null}
        </div>

        <div className="incident-side">
          <div className="safety-status" aria-label="Feeds">
            {feeds.length === 0 ? (
              <div className="incident-map-empty">Add a feed in Settings.</div>
            ) : (
              feeds.map((feed) => (
                <div className="safety-status-row" key={feed.id}>
                  <div className="safety-status-name">
                    {feed.name || "Untitled feed"}
                    <span className={`bcfy-pill${listeningId === feed.id ? " on" : ""}`}>
                      {feed.kind === "audio-in" ? "AUDIO IN" : "ONLINE"}
                    </span>
                  </div>
                  <div className="bcfy-status-meta">
                    <span>
                      {feed.county ? `${feed.county} County` : "County missing"}
                      {feed.state ? `, ${stateFullName(feed.state)}` : ""}
                    </span>
                  </div>
                  <p className="bcfy-audio-hint">{lines[feed.id] ?? "Waiting for the next window."}</p>
                </div>
              ))
            )}
            {previewNote ? <p className="bcfy-captions-note">{previewNote}</p> : null}
          </div>
          <div className="incident-detail">
            {selected ? (
              <SafetyDetail
                hit={selected}
                people={people}
                captionsOn={captionsOn && showCaptions}
                onCorrect={(txId, segments) => correctHit(selected, txId, segments)}
              />
            ) : (
              <p className="incident-empty">Select an alert for the transcript and audio.</p>
            )}
          </div>
        </div>
      </div>
      <footer className="incident-footer">
        Captions are read on this computer. A street is placed in the feed's county and state.
        A unit stays on that incident while dispatched, responding, or on scene, and leaves it when
        cleared, available, or off the scene. A unit is not a person. Audio starts muted.
      </footer>
    </div>
  );
}

function SafetyDetail({
  hit,
  people,
  captionsOn,
  onCorrect,
}: {
  hit: Hit;
  people: KnownPerson[];
  captionsOn: boolean;
  onCorrect: (txId: string, segments: CaptionSegment[]) => void;
}) {
  const item = hit.incident;
  return (
    <div>
      <div className={`incident-sev ${severityClass(item.severity)}`}>
        {item.category ?? item.severity}
      </div>
      <h4 className="incident-detail-title">{item.title}</h4>
      <dl className="incident-dl">
        <dt>Feed</dt>
        <dd>{hit.feedName}</dd>
        {item.occurredAt ? (
          <>
            <dt>When</dt>
            <dd>{formatWhen(item.occurredAt)}</dd>
          </>
        ) : null}
        {item.address ? (
          <>
            <dt>Where</dt>
            <dd>{item.address}</dd>
          </>
        ) : null}
        {item.lat != null && item.lon != null ? (
          <>
            <dt>Coords</dt>
            <dd className="mono">
              {item.lat.toFixed(5)}, {item.lon.toFixed(5)}
            </dd>
          </>
        ) : null}
        <dt>Units</dt>
        <dd>{unitLine(hit.units)}</dd>
      </dl>
      <div className="section-label">Transmissions</div>
      {hit.transmissions.map((tx) => {
        const person = people.find((item) => item.id === tx.personId) ?? null;
        return (
          <TransmissionBlock
            key={tx.id}
            tx={tx}
            personLabel={personPhrase(person)}
            captionsOn={captionsOn}
            onCorrect={(segments) => onCorrect(tx.id, segments)}
          />
        );
      })}
      <p className="bcfy-captions-note">{SPEAKER_GAP}</p>
      {!captionsOn ? (
        <p className="bcfy-captions-note">
          Closed captions are off for this source. Turn Captions on in Settings. The transcript
          above stays with the alert.
        </p>
      ) : null}
    </div>
  );
}

function TransmissionBlock({
  tx,
  personLabel,
  captionsOn,
  onCorrect,
}: {
  tx: RadioTx;
  personLabel: string | null;
  captionsOn: boolean;
  onCorrect: (segments: CaptionSegment[]) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [timeSec, setTimeSec] = useState(0);
  const active = activeCaptionAt(tx.segments, timeSec);

  useEffect(() => {
    setMuted(true);
    setTimeSec(0);
    const el = audioRef.current;
    if (!el) return;
    el.muted = true;
    el.pause();
    try {
      el.currentTime = 0;
    } catch {
      /* The clip may not be seekable yet. */
    }
  }, [tx.id, tx.audioUrl]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  return (
    <section className="safety-tx">
      <div className="safety-tx-meta">
        <span>{tx.callingUnitId ? `Unit ${tx.callingUnitId}` : "Unit not named"}</span>
        <span>{personLabel ? `Person: ${personLabel}` : "Person: not learned"}</span>
      </div>
      <pre className="alerts-detail-text">{tx.text}</pre>
      {tx.audioUrl ? (
        <div className="incident-audio">
          <div className="bcfy-audio-head">
            <div className="section-label" style={{ margin: 0 }}>
              Audio
            </div>
            <button
              type="button"
              className={`btn btn-ghost bcfy-mute${muted ? " is-muted" : ""}`}
              onClick={() => setMuted((value) => !value)}
              aria-pressed={muted}
            >
              {muted ? "Muted" : "Sound on"}
            </button>
          </div>
          <audio
            ref={audioRef}
            controls
            preload="none"
            muted={muted}
            src={tx.audioUrl}
            onVolumeChange={(event) => {
              const el = event.currentTarget;
              setMuted(el.muted || el.volume === 0);
            }}
            onTimeUpdate={(event) => setTimeSec(event.currentTarget.currentTime)}
          >
            <a href={tx.audioUrl}>Open audio</a>
          </audio>
          <p className="bcfy-audio-hint">Starts muted. Unmute in the player to listen.</p>
        </div>
      ) : null}
      {captionsOn && tx.segments.length ? (
        <div className="bcfy-captions" aria-label="Captions">
          <ol className="bcfy-caption-list">
            {tx.segments.map((segment) => (
              <li key={segment.id} className={active?.id === segment.id ? "is-active" : undefined}>
                <span className="mono">
                  {formatClock(segment.startSec)}–{formatClock(segment.endSec)}
                </span>
                <span>{segment.text}</span>
              </li>
            ))}
          </ol>
          <CaptionCorrection
            suggestion={active?.text ?? tx.segments[0]?.text ?? ""}
            onSaved={(memory) => onCorrect(withCorrections(tx.segments, memory))}
          />
        </div>
      ) : null}
    </section>
  );
}

function voiceKeyOf(segments: CaptionSegment[]): string | null {
  for (const segment of segments) {
    const key = segment.speaker?.trim();
    if (key) return key;
  }
  return null;
}

function unitLine(units: OpenIncident["units"]): string {
  if (!units.length) return "no unit still assigned";
  return units
    .map((unit) => `${unit.id} ${unit.status === "on-scene" ? "on scene" : unit.status}`)
    .join(", ");
}

function dropOld(list: Hit[]): Hit[] {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  return list.filter((hit) => {
    const at = Date.parse(hit.incident.occurredAt ?? "");
    return !Number.isFinite(at) || at >= cutoff;
  });
}

function incidentFrom(input: {
  id: string;
  feedName: string;
  miles: number;
  units: OpenIncident["units"];
  transmissions: RadioTx[];
  roster: KnownPerson[];
  title: string;
  category: string;
  severity: Incident["severity"];
  where: string;
  lat: number;
  lon: number;
  at: string;
}): Incident {
  const byId = new Map(input.roster.map((person) => [person.id, person]));
  const latest = [...input.transmissions].reverse().find((tx) => tx.audioUrl);
  return {
    id: input.id,
    title: input.title,
    category: input.category,
    description: `${input.feedName} · ${formatMiles(input.miles)} from you · ${unitLine(input.units)}`,
    occurredAt: input.at,
    address: input.where,
    lat: input.lat,
    lon: input.lon,
    audioUrl: latest?.audioUrl ?? undefined,
    severity: input.severity,
    transcript: formatRadioTranscript(
      input.transmissions.map((tx) => ({
        callingUnitId: tx.callingUnitId,
        personLabel: personPhrase(tx.personId ? (byId.get(tx.personId) ?? null) : null),
        text: tx.text,
      })),
    ),
  };
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
