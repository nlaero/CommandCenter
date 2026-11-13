import { useMemo, useState } from "react";
import { ADAPTER_CATALOG, getAdapter } from "../adapters/catalog";
import { AccountSettings } from "./AuthScreen";
import { useAlerts } from "../lib/alerts";
import {
  addPanelToBoard,
  newId,
  upsertSource,
  validateSourceFields,
} from "../lib/api";
import { useSourceRefresh } from "../lib/sourceRefresh";
import type {
  AdapterDefinition,
  AdapterField,
  AppState,
  AuthSession,
  ConfigPaths,
  Panel,
  SourceConfig,
} from "../types";

type Tab = "sources" | "configured" | "rotation" | "alerts" | "account" | "paths";

const ROTATION_PRESETS = [
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
] as const;

type Props = {
  state: AppState;
  paths: ConfigPaths;
  session: AuthSession;
  onClose: () => void;
  onState: (state: AppState) => void;
  onSession: (session: AuthSession) => void;
};

function requiredKeys(adapter: AdapterDefinition): string[] {
  return adapter.fields.filter((f) => f.required).map((f) => f.key);
}

function fieldValue(
  field: AdapterField,
  params: Record<string, unknown>,
  secrets: Record<string, string>,
): string | boolean {
  if (field.kind === "secret" || field.secret || field.key.startsWith("secret:")) {
    const name = field.key.startsWith("secret:")
      ? field.key.slice("secret:".length)
      : field.key;
    return secrets[name] ?? "";
  }
  if (field.kind === "boolean") {
    return Boolean(params[field.key]);
  }
  const v = params[field.key];
  return v === undefined || v === null ? "" : String(v);
}

export function SettingsView({ state, paths, session, onClose, onState, onSession }: Props) {
  const { notifySourceSaved } = useSourceRefresh();
  const [tab, setTab] = useState<Tab>("sources");
  const [selectedType, setSelectedType] = useState<string | null>(null);
  /** When set, Save updates this existing source id (panels auto-refresh). */
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [rotateOptIn, setRotateOptIn] = useState(false);
  const [rotateTitle, setRotateTitle] = useState("Rotating panel");
  const [rotateIntervalSec, setRotateIntervalSec] = useState(30);
  const [rotateSourceIds, setRotateSourceIds] = useState<string[]>([]);
  const {
    prefs: alertsPrefs,
    updatePrefs: updateAlertsPrefs,
    clearPersistentIgnores,
  } = useAlerts();

  const adapter = selectedType ? getAdapter(selectedType) : undefined;
  const readySources = useMemo(
    () =>
      Object.entries(state.sources).filter(
        ([, source]) => source.enabled && !source.draft,
      ),
    [state.sources],
  );
  const product = useMemo(
    () => ADAPTER_CATALOG.filter((a) => a.category === "product"),
    [],
  );
  const foundation = useMemo(
    () => ADAPTER_CATALOG.filter((a) => a.category === "foundation"),
    [],
  );

  function resetForm() {
    setSelectedType(null);
    setEditingSourceId(null);
    setParams({});
    setSecrets({});
  }

  function startAdd(typeId: string) {
    const def = getAdapter(typeId);
    setEditingSourceId(null);
    setSelectedType(typeId);
    setTab("sources");
    const initial: Record<string, unknown> = {};
    if (typeId === "incident.opendata") {
      initial.provider = "chicago";
      initial.limit = 50;
      initial.attribution = "City of Chicago Open Data — Crimes 2001 to Present";
    }
    if (typeId === "broadcastify.owner") {
      initial.includeArchives = true;
      // Global rule: audio sources support closed captions (default on; user may opt out).
      initial.enableCaptions = true;
    }
    if (typeId === "weather.openmeteo") {
      initial.scopes = "local";
      initial.units = "imperial";
      initial.showRadar = true;
      initial.showSatellite = true;
    }
    if (typeId === "usgs.earthquake") {
      initial.feed = "all_day";
      initial.limit = 50;
      initial.notableMinMag = 4.5;
      initial.autoPan = true;
    }
    setParams(initial);
    setSecrets({});
    setMessage(
      def?.stubNote
        ? { kind: "warn", text: def.stubNote }
        : typeId === "incident.opendata"
          ? {
              kind: "warn",
              text: "Uses municipal open data (not CrimeRadar/Squawster). Optional Socrata token stays in the OS keyring.",
            }
          : typeId === "broadcastify.owner"
            ? {
                kind: "warn",
                text: "Feed Owner API for your own feed only. Password stays in the OS keyring. Archives are personal-use — no Catalog/Calls. Captions prefer on-device ASR (stub until Whisper lands).",
              }
            : typeId === "weather.openmeteo"
              ? {
                  kind: "warn",
                  text: "Open-Meteo conditions + RainViewer radar + NOAA GOES satellite + local NWS alerts (when this source is on the board). Optional Open-Meteo API key stays in the OS keyring.",
                }
              : typeId === "usgs.earthquake"
                ? {
                    kind: "warn",
                    text: "Free USGS summary feed. The panel polls on Cache-Control (never faster than once a minute) and pans the map to each new earthquake, tsunami flag, or other event. Notable rows also show in the alerts pane while this window is on the board.",
                  }
                : null,
    );
  }

  function startEdit(sourceId: string) {
    const source = state.sources[sourceId];
    if (!source) return;
    const def = getAdapter(source.type);
    setEditingSourceId(sourceId);
    setSelectedType(source.type);
    setTab("sources");
    const nextParams = { ...source.params };
    if (source.type === "usgs.earthquake" && nextParams.autoPan === undefined) {
      nextParams.autoPan = true;
    }
    setParams(nextParams);
    setSecrets({});
    setMessage({
      kind: "warn",
      text: def?.stubNote
        ? `Editing ${sourceId}. ${def.stubNote} Leave secret fields blank to keep stored values. Saving refreshes every board panel using this source.`
        : `Editing ${sourceId}. Leave secret fields blank to keep stored values. Saving refreshes every board panel using this source.`,
    });
  }

  function applyProviderDefaults(provider: string, prev: Record<string, unknown>) {
    if (provider === "chicago") {
      return {
        ...prev,
        provider,
        attribution:
          typeof prev.attribution === "string" && prev.attribution.trim()
            ? prev.attribution
            : "City of Chicago Open Data — Crimes 2001 to Present",
        limit: prev.limit === undefined || prev.limit === "" ? 50 : prev.limit,
      };
    }
    if (provider === "seattle") {
      return {
        ...prev,
        provider,
        attribution:
          typeof prev.attribution === "string" && prev.attribution.trim()
            ? prev.attribution
            : "City of Seattle Open Data — SPD Crime Data",
        limit: prev.limit === undefined || prev.limit === "" ? 50 : prev.limit,
      };
    }
    return { ...prev, provider };
  }

  function updateField(field: AdapterField, raw: string | boolean) {
    if (field.kind === "secret" || field.secret || field.key.startsWith("secret:")) {
      const name = field.key.startsWith("secret:")
        ? field.key.slice("secret:".length)
        : field.key;
      setSecrets((s) => ({ ...s, [name]: String(raw) }));
      return;
    }
    if (field.kind === "boolean") {
      setParams((p) => ({ ...p, [field.key]: Boolean(raw) }));
      return;
    }
    if (field.kind === "number") {
      setParams((p) => ({
        ...p,
        [field.key]: raw === "" ? "" : Number(raw),
      }));
      return;
    }
    if (field.key === "provider") {
      setParams((p) => applyProviderDefaults(String(raw), p));
      return;
    }
    setParams((p) => ({ ...p, [field.key]: raw }));
  }

  async function saveSource(addToBoard: boolean) {
    if (!adapter) return;
    setBusy(true);
    setMessage(null);
    try {
      const existing = editingSourceId ? state.sources[editingSourceId] : undefined;
      const secretsProvided = Object.fromEntries(
        Object.entries(secrets).filter(([, value]) => Boolean(value?.trim())),
      );

      const required = requiredKeys(adapter).filter((key) => {
        if (adapter.typeId === "incident.opendata" && key === "endpoint") {
          return String(params.provider ?? "") === "custom";
        }
        // When editing, blank secret fields keep the stored keyring value.
        if (existing && key.startsWith("secret:")) {
          const name = key.slice("secret:".length);
          if (existing.secrets.includes(name) && !secretsProvided[name]) {
            return false;
          }
        }
        return true;
      });
      // Custom open-data endpoint is conditionally required.
      if (
        adapter.typeId === "incident.opendata" &&
        String(params.provider ?? "") === "custom"
      ) {
        const endpoint = String(params.endpoint ?? "").trim();
        if (!endpoint) {
          setMessage({
            kind: "error",
            text: "missing required fields: endpoint",
          });
          return;
        }
      }
      const validation = await validateSourceFields(required, params, secretsProvided);
      if (!validation.ok) {
        setMessage({ kind: "error", text: validation.message });
        return;
      }

      const sourceId =
        editingSourceId ?? newId(`src.${adapter.typeId.split(".").pop()}`);
      const secretRefs = Array.from(
        new Set([
          ...(existing?.secrets ?? []),
          ...Object.keys(secretsProvided),
        ]),
      );
      const cleanedParams = { ...params };
      if (
        adapter.typeId === "incident.opendata" &&
        String(cleanedParams.provider) !== "custom"
      ) {
        delete cleanedParams.endpoint;
      }
      const source: SourceConfig = {
        type: adapter.typeId,
        params: cleanedParams,
        refresh: existing?.refresh ?? adapter.defaultRefresh,
        secrets: secretRefs,
        enabled: true,
        draft: false,
      };

      let next = await upsertSource(sourceId, source, secretsProvided);
      // Remount/refetch every board panel bound to this source (all types).
      // Always bump: covers param edits and secret-only updates alike.
      notifySourceSaved(sourceId);

      if (addToBoard) {
        const panelId = newId("panel");
        const yMax = next.boards
          .find((b) => b.id === next.activeBoardId)
          ?.panels.reduce((max, p) => Math.max(max, p.layout.y + p.layout.h), 0) ?? 0;

        const panel: Panel = {
          id: panelId,
          title: adapter.name,
          widget: adapter.defaultWidget,
          source: sourceId,
          options: { typeId: adapter.typeId },
          layout: panelLayoutFor(adapter.typeId, panelId, yMax),
        };
        next = await addPanelToBoard(next.activeBoardId, panel);
        setMessage({
          kind: "ok",
          text: editingSourceId
            ? `Updated ${sourceId}; panels refreshed and a new panel was added.`
            : `Saved ${sourceId} and added to the active board.`,
        });
      } else {
        setMessage({
          kind: "ok",
          text: editingSourceId
            ? `Updated ${sourceId}. Bound board panels refreshed.`
            : `Saved ${sourceId}. Use Add to board when you want it on a board.`,
        });
      }

      onState(next);
      resetForm();
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  function toggleRotateSource(sourceId: string) {
    setRotateSourceIds((prev) =>
      prev.includes(sourceId)
        ? prev.filter((id) => id !== sourceId)
        : [...prev, sourceId],
    );
  }

  async function addRotatingPanel() {
    setBusy(true);
    setMessage(null);
    try {
      if (!rotateOptIn) {
        setMessage({
          kind: "error",
          text: "Opt in to timed multi-source rotation to create this panel.",
        });
        return;
      }
      if (rotateSourceIds.length < 2) {
        setMessage({
          kind: "error",
          text: "Pick at least two configured sources to rotate.",
        });
        return;
      }
      const interval = Math.min(3600, Math.max(5, Math.round(rotateIntervalSec) || 30));
      for (const id of rotateSourceIds) {
        const src = state.sources[id];
        if (!src || src.draft || !src.enabled) {
          setMessage({
            kind: "error",
            text: `Source ${id} is not ready for the board.`,
          });
          return;
        }
      }

      const panelId = newId("panel");
      const yMax =
        state.boards
          .find((b) => b.id === state.activeBoardId)
          ?.panels.reduce((max, p) => Math.max(max, p.layout.y + p.layout.h), 0) ?? 0;
      const primaryId = rotateSourceIds[0];
      const hasRichPanel = rotateSourceIds.some((id) => {
        const type = state.sources[id]?.type;
        return (
          type === "incident.opendata" ||
          type === "broadcastify.owner" ||
          type === "usgs.earthquake"
        );
      });

      const panel: Panel = {
        id: panelId,
        title: rotateTitle.trim() || "Rotating panel",
        widget: "rotate",
        source: primaryId,
        options: {
          typeId: "panel.rotate",
          members: rotateSourceIds,
        },
        rotation: {
          enabled: true,
          intervalSec: interval,
          sourceIds: [...rotateSourceIds],
        },
        layout: {
          i: panelId,
          x: 0,
          y: yMax,
          w: hasRichPanel ? 24 : 20,
          h: hasRichPanel ? 24 : 16,
          minW: hasRichPanel ? 12 : 10,
          minH: hasRichPanel ? 12 : 10,
        },
      };

      const next = await addPanelToBoard(state.activeBoardId, panel);
      onState(next);
      setMessage({
        kind: "ok",
        text: `Added rotating panel (${rotateSourceIds.length} sources · ${interval}s).`,
      });
      setRotateSourceIds([]);
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function addConfiguredToBoard(sourceId: string) {
    const source = state.sources[sourceId];
    if (!source || source.draft) return;
    const def = getAdapter(source.type);
    setBusy(true);
    try {
      const panelId = newId("panel");
      const yMax =
        state.boards
          .find((b) => b.id === state.activeBoardId)
          ?.panels.reduce((max, p) => Math.max(max, p.layout.y + p.layout.h), 0) ?? 0;
      const panel: Panel = {
        id: panelId,
        title: def?.name ?? source.type,
        widget: def?.defaultWidget ?? "kpi",
        source: sourceId,
        options: { typeId: source.type },
        layout: panelLayoutFor(source.type, panelId, yMax),
      };
      const next = await addPanelToBoard(state.activeBoardId, panel);
      onState(next);
      setMessage({ kind: "ok", text: `Added ${sourceId} to the active board.` });
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

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
              className={tab === "sources" ? "active" : ""}
              onClick={() => setTab("sources")}
            >
              Source catalog
            </button>
            <button
              type="button"
              className={tab === "configured" ? "active" : ""}
              onClick={() => setTab("configured")}
            >
              Configured sources
            </button>
            <button
              type="button"
              className={tab === "rotation" ? "active" : ""}
              onClick={() => setTab("rotation")}
            >
              Panel rotation
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
              className={tab === "account" ? "active" : ""}
              onClick={() => setTab("account")}
            >
              Account
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
            {message ? <div className={`alert ${message.kind}`}>{message.text}</div> : null}

            {tab === "sources" && !adapter ? (
              <>
                <p className="section-label">Product sources</p>
                <div className="source-list">
                  {product.map((item) => (
                    <SourceTypeRow key={item.typeId} item={item} onAdd={() => startAdd(item.typeId)} />
                  ))}
                </div>
                <p className="section-label">Foundation adapters</p>
                <div className="source-list">
                  {foundation.map((item) => (
                    <SourceTypeRow key={item.typeId} item={item} onAdd={() => startAdd(item.typeId)} />
                  ))}
                </div>
              </>
            ) : null}

            {tab === "sources" && adapter ? (
              <SourceForm
                adapter={adapter}
                params={params}
                secrets={secrets}
                busy={busy}
                editingSourceId={editingSourceId}
                onChange={updateField}
                onCancel={() => {
                  const wasEditing = Boolean(editingSourceId);
                  resetForm();
                  setMessage(null);
                  if (wasEditing) setTab("configured");
                }}
                onSave={() => void saveSource(false)}
                onSaveAndAdd={() => void saveSource(true)}
              />
            ) : null}

            {tab === "configured" ? (
              <>
                <p className="section-label">Saved sources</p>
                <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
                  Edit a source to change its Settings — every board panel using that source
                  refreshes automatically on save.
                </p>
                {Object.keys(state.sources).length === 0 ? (
                  <p style={{ color: "var(--cc-text-muted)" }}>
                    None yet. Configure a type under Source catalog.
                  </p>
                ) : (
                  <div className="source-list">
                    {Object.entries(state.sources).map(([id, source]) => (
                      <div className="source-row" key={id}>
                        <div>
                          <h3>
                            {id}
                            {source.draft ? <span className="badge">draft</span> : null}
                          </h3>
                          <p>{source.type}</p>
                        </div>
                        <div className="source-row-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={busy || source.draft}
                            onClick={() => startEdit(id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy || source.draft}
                            onClick={() => void addConfiguredToBoard(id)}
                          >
                            Add to board
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            {tab === "rotation" ? (
              <>
                <p className="section-label">Timed multi-source rotation</p>
                <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
                  Opt in to cycle weather and other configured sources inside{" "}
                  <strong style={{ color: "var(--cc-text)", fontWeight: 500 }}>one</strong> board
                  panel on a timer. Configure sources first, then enable rotation here.
                </p>

                <label className="rotate-optin">
                  <input
                    type="checkbox"
                    checked={rotateOptIn}
                    onChange={(e) => setRotateOptIn(e.target.checked)}
                  />
                  <span>
                    Enable timed rotation of multiple sources in one panel
                  </span>
                </label>

                <div className={`rotate-setup${rotateOptIn ? "" : " is-disabled"}`}>
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="rotate-title">Panel title</label>
                      <input
                        id="rotate-title"
                        type="text"
                        value={rotateTitle}
                        disabled={!rotateOptIn}
                        onChange={(e) => setRotateTitle(e.target.value)}
                        placeholder="Rotating panel"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="rotate-interval">Interval (seconds)</label>
                      <div className="rotate-interval-row">
                        {ROTATION_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={`btn${rotateIntervalSec === preset.value ? " active" : ""}`}
                            disabled={!rotateOptIn}
                            onClick={() => setRotateIntervalSec(preset.value)}
                          >
                            {preset.label}
                          </button>
                        ))}
                        <input
                          id="rotate-interval"
                          type="number"
                          min={5}
                          max={3600}
                          value={rotateIntervalSec}
                          disabled={!rotateOptIn}
                          onChange={(e) =>
                            setRotateIntervalSec(Number(e.target.value) || 30)
                          }
                        />
                      </div>
                      <div className="help">5–3600 seconds between source switches.</div>
                    </div>
                  </div>

                  <p className="section-label" style={{ marginTop: 16 }}>
                    Sources in this panel ({rotateSourceIds.length} selected)
                  </p>
                  {readySources.length < 2 ? (
                    <p style={{ color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
                      Need at least two saved sources. Configure them under Source catalog, then
                      return here.
                    </p>
                  ) : (
                    <div className="source-list">
                      {readySources.map(([id, source]) => {
                        const def = getAdapter(source.type);
                        const checked = rotateSourceIds.includes(id);
                        return (
                          <label
                            key={id}
                            className={`source-row rotate-source-row${checked ? " is-checked" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!rotateOptIn}
                              onChange={() => toggleRotateSource(id)}
                            />
                            <div>
                              <h3>
                                {def?.name ?? source.type}
                                <span className="badge">{source.type}</span>
                              </h3>
                              <p>{id}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={
                        busy ||
                        !rotateOptIn ||
                        rotateSourceIds.length < 2 ||
                        readySources.length < 2
                      }
                      onClick={() => void addRotatingPanel()}
                    >
                      Add rotating panel to board
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {tab === "alerts" ? (
              <>
                <p className="section-label">Right-side alerts pane</p>
                <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
                  Lists alerts from <strong style={{ color: "var(--cc-text)", fontWeight: 500 }}>active
                  source windows</strong> on the board (NWS watches and warnings, notable USGS
                  earthquakes and tsunami flags, or crime / scanner items with text and audio).
                  Changing options below clears alerts ignored “until Settings change.”
                </p>

                <label className="rotate-optin">
                  <input
                    type="checkbox"
                    checked={alertsPrefs.pinned}
                    onChange={(e) => updateAlertsPrefs({ pinned: e.target.checked })}
                  />
                  <span>Pin alerts pane open</span>
                </label>

                <label className="rotate-optin">
                  <input
                    type="checkbox"
                    checked={alertsPrefs.autoOpen}
                    onChange={(e) => updateAlertsPrefs({ autoOpen: e.target.checked })}
                  />
                  <span>Auto-open when new alerts arrive</span>
                </label>

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

            {tab === "account" ? (
              <AccountSettings
                state={state}
                session={session}
                onState={onState}
                onSession={onSession}
              />
            ) : null}

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

function panelLayoutFor(
  typeId: string,
  panelId: string,
  yMax: number,
): Panel["layout"] {
  if (typeId === "weather.openmeteo") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 28,
      h: 32,
      minW: 16,
      minH: 18,
    };
  }
  if (typeId === "usgs.earthquake") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 32,
      h: 34,
      minW: 18,
      minH: 18,
    };
  }
  if (typeId === "incident.opendata" || typeId === "broadcastify.owner") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 24,
      h: 22,
      minW: 12,
      minH: 12,
    };
  }
  return {
    i: panelId,
    x: 0,
    y: yMax,
    w: 16,
    h: 14,
    minW: 8,
    minH: 8,
  };
}

function SourceTypeRow({
  item,
  onAdd,
}: {
  item: AdapterDefinition;
  onAdd: () => void;
}) {
  return (
    <div className="source-row">
      <div>
        <h3>
          {item.name}
          <span className="badge">{item.category}</span>
        </h3>
        <p>{item.description}</p>
      </div>
      <button type="button" className="btn" onClick={onAdd}>
        Configure
      </button>
    </div>
  );
}

function SourceForm({
  adapter,
  params,
  secrets,
  busy,
  editingSourceId,
  onChange,
  onCancel,
  onSave,
  onSaveAndAdd,
}: {
  adapter: AdapterDefinition;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  busy: boolean;
  editingSourceId: string | null;
  onChange: (field: AdapterField, raw: string | boolean) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndAdd: () => void;
}) {
  const editing = Boolean(editingSourceId);
  return (
    <div>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        {editing ? "← Back to configured" : "← Back to catalog"}
      </button>
      <h3 style={{ margin: "12px 0 4px" }}>
        {adapter.name}
        {editing ? <span className="badge">editing</span> : null}
      </h3>
      <p style={{ margin: 0, color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        {editing
          ? `Updating ${editingSourceId}. Bound panels refresh as soon as you save.`
          : adapter.description}
      </p>
      <div className="form-grid">
        {adapter.fields.map((field) => {
          const value = fieldValue(field, params, secrets);
          const isSecret =
            field.kind === "secret" || field.secret || field.key.startsWith("secret:");
          return (
            <div className="field" key={field.key}>
              <label htmlFor={field.key}>
                {field.label}
                {field.required && !(editing && isSecret) ? (
                  <span className="req"> *</span>
                ) : null}
              </label>
              {field.kind === "boolean" ? (
                <input
                  id={field.key}
                  type="checkbox"
                  checked={Boolean(value)}
                  onChange={(e) => onChange(field, e.target.checked)}
                />
              ) : field.kind === "select" ? (
                <select
                  id={field.key}
                  value={String(value)}
                  onChange={(e) => onChange(field, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(field.options ?? []).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={field.key}
                  type={
                    field.kind === "secret"
                      ? "password"
                      : field.kind === "number"
                        ? "number"
                        : "text"
                  }
                  placeholder={
                    editing && isSecret
                      ? "Leave blank to keep stored secret"
                      : field.placeholder
                  }
                  value={String(value)}
                  onChange={(e) => onChange(field, e.target.value)}
                  autoComplete="off"
                />
              )}
              {field.help ? <div className="help">{field.help}</div> : null}
            </div>
          );
        })}
      </div>
      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={onSave}>
          {editing ? "Save changes" : "Save source"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={onSaveAndAdd}
        >
          {editing ? "Save & add another panel" : "Save & add to board"}
        </button>
      </div>
    </div>
  );
}
