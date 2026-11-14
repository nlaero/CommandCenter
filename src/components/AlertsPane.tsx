import { useEffect, useRef, useState } from "react";
import { CaptionCorrection, withCorrections } from "./LocalAiPanel";
import {
  activeCaptionAt,
  transcribeArchiveLocal,
  type CaptionResult,
} from "../lib/captions";
import { useAlerts } from "../lib/alerts";
import type { BoardAlert } from "../types";

function severityClass(severity: BoardAlert["severity"]): string {
  if (severity === "alert") return "sev-alert";
  if (severity === "warn") return "sev-warn";
  return "sev-info";
}

function formatWhen(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AlertsPane() {
  const {
    prefs,
    visible,
    published,
    open,
    setOpen,
    selected,
    openAlert,
    closeAlert,
    ignoreTemporary,
    ignorePersistent,
    clearVisible,
    togglePin,
  } = useAlerts();

  const count = visible.length;
  const ignoredCount = published.length - visible.length;
  const visibleKey = visible.map((alert) => alert.id).join("\n");
  const [hideInSec, setHideInSec] = useState<number | null>(null);

  useEffect(() => {
    if (!open || prefs.pinned || prefs.autoHideSec <= 0 || selected) {
      setHideInSec(null);
      return;
    }
    const total = prefs.autoHideSec;
    const started = Date.now();
    setHideInSec(total);
    const timer = window.setInterval(() => {
      const left = total - Math.floor((Date.now() - started) / 1000);
      if (left <= 0) {
        setHideInSec(null);
        setOpen(false);
        return;
      }
      setHideInSec(left);
    }, 250);
    return () => window.clearInterval(timer);
  }, [open, prefs.pinned, prefs.autoHideSec, visibleKey, selected, setOpen]);

  const overlay = open && !prefs.pinned;

  return (
    <aside
      className={`alerts-pane${open ? " is-open" : ""}${prefs.pinned ? " is-pinned" : ""}${
        overlay ? " is-overlay" : ""
      }`}
      aria-label="Board alerts"
    >
      <button
        type="button"
        className={`alerts-tab${count > 0 ? " has-alerts" : ""}`}
        onClick={() => setOpen(!open)}
        title={open ? "Collapse alerts" : "Expand alerts"}
        aria-expanded={open}
      >
        <span className="alerts-tab-label">Alerts</span>
        {count > 0 ? <span className="alerts-tab-count">{count}</span> : null}
      </button>

      <div className="alerts-drawer" hidden={!open}>
        <header className="alerts-header">
          <div>
            <div className="alerts-title">Alerts</div>
            <div className="alerts-meta">
              {count === 0
                ? "No active alerts from board windows"
                : `${count} from active sources`}
              {ignoredCount > 0 ? ` · ${ignoredCount} ignored` : ""}
            </div>
          </div>
          <div className="alerts-header-actions">
            <button
              type="button"
              className={`btn btn-ghost alerts-chip${prefs.pinned ? " active" : ""}`}
              onClick={togglePin}
              title={
                prefs.pinned
                  ? "Unpin. New alerts cover the panels instead of resizing them."
                  : "Pin open. Panels shrink so they sit beside the pane."
              }
            >
              {prefs.pinned ? "Pinned" : "Pin"}
            </button>
            <button
              type="button"
              className="btn btn-ghost alerts-chip"
              onClick={() => setOpen(false)}
              disabled={prefs.pinned}
              title={prefs.pinned ? "Unpin to collapse" : "Collapse"}
            >
              Collapse
            </button>
          </div>
        </header>

        <div className="alerts-toolbar">
          <button
            type="button"
            className="btn alerts-clear"
            onClick={clearVisible}
            disabled={count === 0}
            title="Dismiss these alerts for this session. New ones still show up."
          >
            Clear alerts
          </button>
          {hideInSec != null ? (
            <span className="alerts-hide-note">Hides in {hideInSec}s</span>
          ) : prefs.pinned ? (
            <span className="alerts-hide-note is-muted">Pinned</span>
          ) : prefs.autoHideSec > 0 ? null : (
            <span className="alerts-hide-note is-muted">Stays open</span>
          )}
        </div>

        <div className="alerts-list" role="list">
          {visible.length === 0 ? (
            <p className="alerts-empty">
              Alerts appear here from source windows on this board (NWS watches and
              warnings, notable USGS earthquakes and tsunami flags, or crime / scanner
              incidents). Configure a source in Settings and add it to the board to feed
              this pane.
            </p>
          ) : (
            visible.map((alert) => (
              <button
                key={alert.id}
                type="button"
                className={`alerts-item incident-alert ${severityClass(alert.severity)}${
                  selected?.id === alert.id ? " is-active" : ""
                }`}
                role="listitem"
                onClick={() => openAlert(alert.id)}
              >
                <div className="incident-alert-top">
                  <span className={`incident-sev ${severityClass(alert.severity)}`}>
                    {(alert.category ?? alert.severity).toUpperCase()}
                  </span>
                  <span className="incident-when">{formatWhen(alert.occurredAt)}</span>
                </div>
                <div className="incident-alert-title">{alert.title}</div>
                <div className="incident-alert-sub">
                  {alert.sourceLabel}
                  {alert.area || alert.address ? ` · ${alert.area ?? alert.address}` : ""}
                  {alert.audioUrl ? <span className="audio-tag">audio</span> : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {selected ? (
        <AlertDetailModal
          alert={selected}
          onClose={closeAlert}
          onIgnoreSession={() => ignoreTemporary(selected.id)}
          onIgnoreSettings={() => ignorePersistent(selected.id)}
        />
      ) : null}
    </aside>
  );
}

function AlertDetailModal({
  alert,
  onClose,
  onIgnoreSession,
  onIgnoreSettings,
}: {
  alert: BoardAlert;
  onClose: () => void;
  onIgnoreSession: () => void;
  onIgnoreSettings: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [timeSec, setTimeSec] = useState(0);
  const [caption, setCaption] = useState<CaptionResult | null>(null);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionError, setCaptionError] = useState<string | null>(null);

  useEffect(() => {
    setTimeSec(0);
    setCaption(
      alert.transcript
        ? {
            engine: "local-stub",
            status: "ready",
            sourceUrl: alert.audioUrl ?? "",
            segments: [
              {
                id: `${alert.id}-tx`,
                startSec: 0,
                endSec: 9999,
                text: alert.transcript,
              },
            ],
            note: "Transcript supplied by the source.",
            generatedAt: new Date().toISOString(),
          }
        : null,
    );
    setCaptionBusy(false);
    setCaptionError(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.muted = true;
    }
  }, [alert.id, alert.audioUrl, alert.transcript]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function runTranscription() {
    if (!alert.audioUrl) return;
    setCaptionBusy(true);
    setCaptionError(null);
    try {
      const result = await transcribeArchiveLocal({
        sourceUrl: alert.audioUrl,
        clipId: alert.id,
      });
      setCaption(result);
    } catch (err) {
      setCaptionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCaptionBusy(false);
    }
  }

  const active = caption ? activeCaptionAt(caption.segments, timeSec) : null;
  const bodyText = alert.body ?? alert.summary;

  return (
    <div
      className="alerts-detail-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="alerts-detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="alerts-detail-title"
      >
        <header className="alerts-detail-header">
          <div>
            <div className={`incident-sev ${severityClass(alert.severity)}`}>
              {(alert.category ?? alert.severity).toUpperCase()}
            </div>
            <h3 id="alerts-detail-title" className="alerts-detail-title">
              {alert.title}
            </h3>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="alerts-detail-body">
          <dl className="incident-dl">
            <dt>Source</dt>
            <dd>
              {alert.sourceLabel}
              <span className="alerts-detail-source-meta">
                {" "}
                · {alert.sourceType} · {alert.sourceId}
              </span>
            </dd>
            {alert.occurredAt ? (
              <>
                <dt>When</dt>
                <dd>{formatWhen(alert.occurredAt)}</dd>
              </>
            ) : null}
            {alert.endsAt ? (
              <>
                <dt>Until</dt>
                <dd>{formatWhen(alert.endsAt)}</dd>
              </>
            ) : null}
            {alert.area || alert.address ? (
              <>
                <dt>Where</dt>
                <dd>{alert.area ?? alert.address}</dd>
              </>
            ) : null}
            {alert.category ? (
              <>
                <dt>Category</dt>
                <dd>{alert.category}</dd>
              </>
            ) : null}
          </dl>

          {bodyText ? (
            <section className="alerts-detail-section">
              <div className="section-label">Alert text</div>
              <pre className="alerts-detail-text">{bodyText}</pre>
            </section>
          ) : null}

          {alert.audioUrl ? (
            <section className="alerts-detail-section">
              <div className="section-label">Audio</div>
              {/* Global product rule: audio sources start muted on open. */}
              <audio
                ref={audioRef}
                className="alerts-detail-audio"
                controls
                preload="none"
                muted
                src={alert.audioUrl}
                onTimeUpdate={(e) => setTimeSec(e.currentTarget.currentTime)}
              >
                <a href={alert.audioUrl} target="_blank" rel="noreferrer">
                  Open audio
                </a>
              </audio>
              <p className="bcfy-audio-hint">Starts muted. Unmute in the player to listen.</p>
            </section>
          ) : null}

          {alert.audioUrl || alert.transcript ? (
            <section className="alerts-detail-section bcfy-captions" aria-label="Transcript">
              <div className="bcfy-captions-head">
                <div className="section-label" style={{ margin: 0 }}>
                  Transcript / captions
                </div>
                {alert.audioUrl ? (
                  <button
                    type="button"
                    className="btn btn-ghost alerts-chip"
                    disabled={captionBusy}
                    onClick={() => void runTranscription()}
                  >
                    {captionBusy
                      ? "Transcribing…"
                      : caption?.segments.length
                        ? "Re-run local"
                        : "Transcribe local"}
                  </button>
                ) : null}
              </div>
              <p className="bcfy-captions-note">
                {captionError
                  ? captionError
                  : (caption?.note ??
                    (alert.audioUrl
                      ? "Local / on-device transcription preferred — audio stays on this machine."
                      : null))}
              </p>
              {active ? (
                <div className="bcfy-caption-live" aria-live="polite">
                  {active.text}
                </div>
              ) : caption?.segments.length ? (
                <div className="bcfy-caption-live is-empty">
                  {alert.audioUrl ? "Play audio to follow captions…" : null}
                </div>
              ) : (
                <div className="bcfy-caption-live is-empty">
                  {alert.audioUrl
                    ? "Run local transcription to generate captions for this clip."
                    : "No transcript available for this alert."}
                </div>
              )}
              {caption?.segments.length ? (
                <ol className="bcfy-caption-list">
                  {caption.segments.map((seg) => (
                    <li
                      key={seg.id}
                      className={active?.id === seg.id ? "is-active" : undefined}
                    >
                      {seg.text}
                    </li>
                  ))}
                </ol>
              ) : null}
              {caption?.segments.length ? (
                <CaptionCorrection
                  suggestion={active?.text ?? caption.segments[0]?.text ?? ""}
                  onSaved={(memory) =>
                    setCaption({
                      ...caption,
                      segments: withCorrections(caption.segments, memory),
                    })
                  }
                />
              ) : null}
            </section>
          ) : null}

          {alert.detailUrl ? (
            <a
              className="incident-link"
              href={alert.detailUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open source detail
            </a>
          ) : null}
        </div>

        <footer className="alerts-detail-footer">
          <button type="button" className="btn btn-ghost" onClick={onIgnoreSession}>
            Ignore this session
          </button>
          <button type="button" className="btn btn-ghost" onClick={onIgnoreSettings}>
            Ignore until Settings change
          </button>
        </footer>
      </div>
    </div>
  );
}
