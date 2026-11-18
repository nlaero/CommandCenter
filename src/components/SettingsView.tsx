import { useEffect, useState } from "react";
import { AUTH_IN_APP } from "../lib/authFeature";
import { AccountSettings } from "./AuthScreen";
import { LocalAiPanel } from "./LocalAiPanel";
import { ServerSetup } from "./ServerSetup";
import { UpdatesBody, useUpdates } from "./UpdatesPanel";
import { clampAutoHideSec, useAlerts } from "../lib/alerts";
import {
  applyDisplayWall,
  listCastScreens,
  type CastScreen,
} from "../lib/cast";
import {
  BOARD_DENSITIES,
  DISPLAY_PRESETS,
  applyDisplayPrefs,
  boardDensityPreset,
  readDisplayPrefs,
  readWorkArea,
  subscribeDisplayPrefs,
  type DisplayPrefs,
} from "../lib/display";
import { displayWallSummary } from "../lib/span";
import { TelevisionSettings } from "./TelevisionSettings";
import { PanelSettings } from "./PanelSettings";
import type { AppState, AuthSession, ConfigPaths } from "../types";

export type SettingsTab =
  | "panels"
  | "alerts"
  | "display"
  | "television"
  | "account"
  | "server"
  | "ai"
  | "updates"
  | "paths";

const ALERT_HIDE_PRESETS = [
  { label: "Off", value: 0 },
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
] as const;

type Props = {
  state: AppState;
  paths: ConfigPaths;
  session: AuthSession | null;
  onClose: () => void;
  onState: (state: AppState) => void;
  onSession: (session: AuthSession) => void;
  initialTab?: SettingsTab;
};

export function SettingsView({
  state,
  paths,
  session,
  onClose,
  onState,
  onSession,
  initialTab,
}: Props) {
  const updates = useUpdates();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "panels");
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(
    null,
  );
  const [hideDraft, setHideDraft] = useState("60");
  const {
    prefs: alertsPrefs,
    updatePrefs: updateAlertsPrefs,
    clearPersistentIgnores,
  } = useAlerts();

  useEffect(() => {
    setHideDraft(String(alertsPrefs.autoHideSec));
  }, [alertsPrefs.autoHideSec]);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-sheet">
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav">
            <button
              type="button"
              className={tab === "panels" ? "active" : ""}
              onClick={() => setTab("panels")}
            >
              Panels
            </button>
            <button
              type="button"
              className={tab === "alerts" ? "active" : ""}
              onClick={() => setTab("alerts")}
            >
              Alerts pane
            </button>
            <button
              type="button"
              className={tab === "display" ? "active" : ""}
              onClick={() => setTab("display")}
            >
              Display
            </button>
            <button
              type="button"
              className={tab === "television" ? "active" : ""}
              onClick={() => setTab("television")}
            >
              Television
            </button>
            {AUTH_IN_APP ? (
              <button
                type="button"
                className={tab === "account" ? "active" : ""}
                onClick={() => setTab("account")}
              >
                Account
              </button>
            ) : null}
            {AUTH_IN_APP ? (
              <button
                type="button"
                className={tab === "server" ? "active" : ""}
                onClick={() => setTab("server")}
              >
                Server
              </button>
            ) : null}
            <button
              type="button"
              className={tab === "ai" ? "active" : ""}
              onClick={() => setTab("ai")}
            >
              Local AI
            </button>
            <button
              type="button"
              className={tab === "updates" ? "active" : ""}
              onClick={() => setTab("updates")}
            >
              Updates
              {updates.hasUpdate ? <span className="badge">new</span> : null}
            </button>
            <button
              type="button"
              className={tab === "paths" ? "active" : ""}
              onClick={() => setTab("paths")}
            >
              Config paths
            </button>
          </nav>

          <div className="settings-content">
            {tab !== "panels" && message ? (
              <div className={`alert ${message.kind}`}>{message.text}</div>
            ) : null}

            {tab === "panels" ? <PanelSettings state={state} onState={onState} /> : null}

            {tab === "alerts" ? (
              <>
                <p className="section-label">Alerts pane</p>
                <p style={{ marginTop: 0, color: "var(--cc-text-muted)", fontSize: "0.9rem" }}>
                  Lists alerts from <strong style={{ color: "var(--cc-text)", fontWeight: 500 }}>active
                  source windows</strong> on the board. Changing options below clears alerts ignored
                  until Settings change.
                </p>

                <label className="rotate-optin">
                  <input
                    type="checkbox"
                    checked={alertsPrefs.pinned}
                    onChange={(e) => updateAlertsPrefs({ pinned: e.target.checked })}
                  />
                  <span>
                    Pin alerts pane open
                    <span
                      style={{
                        display: "block",
                        marginTop: 4,
                        color: "var(--cc-text-muted)",
                        fontSize: "0.8rem",
                      }}
                    >
                      Unpinned, a new alert covers the panels. Pinned, the panels shrink so they
                      fit beside the pane.
                    </span>
                  </span>
                </label>

                <label className="rotate-optin">
                  <input
                    type="checkbox"
                    checked={alertsPrefs.autoOpen}
                    onChange={(e) => updateAlertsPrefs({ autoOpen: e.target.checked })}
                  />
                  <span>Auto-open when new alerts arrive</span>
                </label>

                <div className="field" style={{ marginTop: 14 }}>
                  <label htmlFor="alerts-hide-sec">Hide the pane after</label>
                  <div className="rotate-interval-row">
                    {ALERT_HIDE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`btn${alertsPrefs.autoHideSec === preset.value ? " active" : ""}`}
                        onClick={() => updateAlertsPrefs({ autoHideSec: preset.value })}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <input
                      id="alerts-hide-sec"
                      type="number"
                      min={0}
                      max={3600}
                      value={hideDraft}
                      onChange={(e) => setHideDraft(e.target.value)}
                      onBlur={() => {
                        const next = clampAutoHideSec(Number(hideDraft));
                        updateAlertsPrefs({ autoHideSec: next });
                        setHideDraft(String(next));
                      }}
                    />
                  </div>
                  <div className="help">
                    Seconds before the pane closes itself. 0 is off. Otherwise 5 seconds to 1
                    hour. Default is 1 minute. Pin keeps it open. Clear alerts on the pane
                    dismisses the current list for this session; new alerts still show.
                  </div>
                </div>

                <div className="form-actions" style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={alertsPrefs.ignoredPersistent.length === 0}
                    onClick={() => {
                      clearPersistentIgnores();
                      setMessage({
                        kind: "ok",
                        text: "Cleared persistent alert ignores.",
                      });
                    }}
                  >
                    Clear ignored alerts
                    {alertsPrefs.ignoredPersistent.length
                      ? ` (${alertsPrefs.ignoredPersistent.length})`
                      : ""}
                  </button>
                </div>
              </>
            ) : null}

            {tab === "display" ? (
              <>
                <BoardDensityControl
                  onMessage={(text, kind) => setMessage({ kind, text })}
                />
                <DisplaySettings
                  onMessage={(text, kind) => setMessage({ kind, text })}
                />
              </>
            ) : null}

            {tab === "television" ? (
              <TelevisionSettings
                onMessage={(text, kind) => setMessage({ kind, text })}
              />
            ) : null}

            {AUTH_IN_APP && tab === "account" && session ? (
              <AccountSettings
                state={state}
                session={session}
                onState={onState}
                onSession={onSession}
              />
            ) : null}

            {AUTH_IN_APP && tab === "server" ? <ServerSetup onState={onState} /> : null}

            {tab === "ai" ? <LocalAiPanel session={session} /> : null}

            {tab === "updates" ? <UpdatesBody /> : null}

            {tab === "paths" ? (
              <>
                <p className="section-label">Config location</p>
                <div className="path-box">
                  <div>Root: {paths.root}</div>
                  <div>Config: {paths.configFile}</div>
                  <div>Layouts: {paths.layoutsDir}</div>
                  <div>
                    Override:{" "}
                    {paths.overrideActive
                      ? `active via ${paths.overrideSource ?? "unknown"}`
                      : "off (OS app-data / config dir)"}
                  </div>
                </div>
                <p style={{ color: "var(--cc-text-muted)", marginTop: 12, fontSize: "0.85rem" }}>
                  Set <code>COMMAND_CENTER_HOME</code> to a folder for portable / USB / git-synced
                  board packs. Secrets should still prefer the OS keyring when available.
                </p>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}


function BoardDensityControl({
  onMessage,
}: {
  onMessage: (text: string, kind: "ok" | "error") => void;
}) {
  const [density, setDensity] = useState(() => readDisplayPrefs().density);
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribeDisplayPrefs(() => setDensity(readDisplayPrefs().density)), []);

  async function choose(scale: number) {
    setBusy(true);
    try {
      const saved = await applyDisplayPrefs({ ...readDisplayPrefs(), density: scale });
      setDensity(saved.density);
      const preset = boardDensityPreset(saved.density);
      const text =
        saved.density > 1
          ? `${preset.label} panels stay easy to read on this screen and on the television.`
          : saved.density < 1
            ? `${preset.label} grid. More sources fit on this screen and on the television.`
            : "Standard grid on this screen and on the television.";
      onMessage(text, "ok");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const current = boardDensityPreset(density);

  return (
    <div className="density-block">
      <p className="section-label">Board density</p>
      <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        How big each source is. Saved on this computer, not on the account. Compact and Dense
        shrink the panel grid so more sources fit in this window. Larger keeps each panel easy
        to read. The television, including AirPlay, uses the same choice.
      </p>
      <p className="display-current">{current.label}</p>
      <div className="choice-grid density-grid" role="radiogroup" aria-label="Board density">
        {BOARD_DENSITIES.map((preset) => {
          const active = preset.scale === density;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? "choice-card active" : "choice-card"}
              disabled={busy}
              onClick={() => void choose(preset.scale)}
            >
              <strong>{preset.label}</strong>
              <span>{preset.detail}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DisplaySettings({
  onMessage,
}: {
  onMessage: (text: string, kind: "ok" | "error") => void;
}) {
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => readDisplayPrefs());
  const [customW, setCustomW] = useState(() => String(readDisplayPrefs().width));
  const [customH, setCustomH] = useState(() => String(readDisplayPrefs().height));
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<CastScreen[]>([]);
  const [picked, setPicked] = useState<string[]>(() => readDisplayPrefs().screens);

  useEffect(
    () =>
      subscribeDisplayPrefs(() => {
        const next = readDisplayPrefs();
        setPrefs((current) => {
          const sameScreens =
            current.screens.length === next.screens.length &&
            current.screens.every((id, index) => id === next.screens[index]);
          if (!sameScreens) setPicked(next.screens);
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void listCastScreens()
      .then((screens) => {
        if (!cancelled) setAvailable(screens);
      })
      .catch((err) => {
        if (!cancelled) onMessage(err instanceof Error ? err.message : String(err), "error");
      });
    return () => {
      cancelled = true;
    };
    // The settings alert is owned by the parent. Report the first load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply(next: Omit<DisplayPrefs, "density" | "screens">) {
    setBusy(true);
    try {
      const saved = await applyDisplayPrefs({
        ...next,
        density: readDisplayPrefs().density,
        screens: readDisplayPrefs().screens,
      });
      setPrefs(saved);
      setCustomW(String(saved.width));
      setCustomH(String(saved.height));
      onMessage(
        saved.mode === "auto"
          ? "Using the current window size."
          : `Window size set to ${saved.width} × ${saved.height}.`,
        "ok",
      );
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function matchScreen() {
    setBusy(true);
    try {
      const area = await readWorkArea();
      if (!area) {
        onMessage("Could not read this screen's size.", "error");
        return;
      }
      await apply({
        mode: "fixed",
        width: area.width,
        height: area.height,
        label: "This screen",
      });
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const summary =
    prefs.mode === "auto"
      ? "Following the window"
      : `${prefs.label} · ${prefs.width} × ${prefs.height}`;
  const livePicked = available.filter((screen) => picked.includes(screen.id));
  const wallSummary =
    picked.length >= 2 && livePicked.length < 2
      ? "Those screens are not connected. Refresh, then use them."
      : displayWallSummary(livePicked);

  function toggleScreen(id: string) {
    setPicked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(0, 8),
    );
  }

  async function refreshScreens() {
    setBusy(true);
    try {
      setAvailable(await listCastScreens());
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function useScreens(ids: string[]) {
    setBusy(true);
    try {
      const text = await applyDisplayWall(ids);
      setPicked(readDisplayPrefs().screens);
      onMessage(text, "ok");
    } catch (err) {
      onMessage(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="section-label">Program resolution</p>
      <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        Set the window size for the screen you are using. Saved on this computer, not on the
        account. You can still drag the window edges afterward.
      </p>
      <p className="display-current">{summary}</p>

      <div className="source-list">
        <button
          type="button"
          className={`source-row display-preset${prefs.mode === "auto" ? " is-checked" : ""}`}
          disabled={busy}
          onClick={() =>
            void apply({
              mode: "auto",
              width: prefs.width,
              height: prefs.height,
              label: "Window",
            })
          }
        >
          <div>
            <h3>
              Use the window size
              <span className="badge">default</span>
            </h3>
            <p>Leave the window wherever you put it. No fixed resolution.</p>
          </div>
        </button>
        {DISPLAY_PRESETS.map((preset) => {
          const active =
            prefs.mode === "fixed" &&
            prefs.width === preset.width &&
            prefs.height === preset.height;
          return (
            <button
              key={preset.id}
              type="button"
              className={`source-row display-preset${active ? " is-checked" : ""}`}
              disabled={busy}
              onClick={() =>
                void apply({
                  mode: "fixed",
                  width: preset.width,
                  height: preset.height,
                  label: preset.label,
                })
              }
            >
              <div>
                <h3>
                  {preset.label}
                  <span className="badge">{preset.detail}</span>
                </h3>
                <p>Logical pixels. The desktop window resizes to this.</p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="form-grid" style={{ marginTop: 16 }}>
        <div className="field">
          <label htmlFor="display-width">Custom width</label>
          <input
            id="display-width"
            type="number"
            min={960}
            max={7680}
            value={customW}
            onChange={(e) => setCustomW(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="display-height">Custom height</label>
          <input
            id="display-height"
            type="number"
            min={640}
            max={4320}
            value={customH}
            onChange={(e) => setCustomH(e.target.value)}
          />
        </div>
      </div>
      <p style={{ margin: "8px 0 0", color: "var(--cc-text-muted)", fontSize: "0.8rem" }}>
        Minimum 960 × 640. Maximum 7680 × 4320. Smaller or larger numbers are pulled into that
        range.
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            void apply({
              mode: "fixed",
              width: Number(customW),
              height: Number(customH),
              label: "Custom",
            })
          }
        >
          Use this size
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void matchScreen()}>
          Match this screen
        </button>
      </div>

      <p className="section-label" style={{ marginTop: 22 }}>
        Screens
      </p>
      <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        The board can use more than one screen. Setup stays on this computer. Checked screens
        each show their part of the board, at that screen's own size. A 58-inch or larger
        television stays sharp at 3840 × 2160 or higher. Pick a television under Television when
        it has to refuse a smaller picture.
      </p>
      <p className="display-current">{wallSummary}</p>
      {available.length === 0 ? (
        <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
          No screens reported yet.
        </p>
      ) : (
        <div className="source-list">
          {available.map((screen) => {
            const active = picked.includes(screen.id);
            const badge = screen.current ? "this computer" : screen.sharp ? "4K" : "below 4K";
            return (
              <button
                key={screen.id}
                type="button"
                aria-pressed={active}
                className={`source-row display-preset${active ? " is-checked" : ""}`}
                disabled={busy}
                onClick={() => toggleScreen(screen.id)}
              >
                <div>
                  <h3>
                    {screen.name}
                    <span className="badge">{badge}</span>
                  </h3>
                  <p>
                    {screen.width} × {screen.height}
                    {screen.current
                      ? ". Setup stays here. Check it to show this screen's part of the board."
                      : screen.sharp
                        ? ". Sharp on a 58-inch or larger television."
                        : ". This screen's own size. Soft on a 58-inch or larger television until it is set to 4K."}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void useScreens(picked)}
        >
          Use these screens
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || prefs.screens.length === 0}
          onClick={() => void useScreens([])}
        >
          This window only
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void refreshScreens()}>
          Refresh screens
        </button>
      </div>
    </>
  );
}
