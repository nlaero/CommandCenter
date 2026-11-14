import { useEffect, useMemo, useState } from "react";
import { ADAPTER_CATALOG, getAdapter } from "../adapters/catalog";
import { CALLS_APP } from "../lib/broadcastifyCallsPreset";
import {
  PENN_HILLS_FEED,
  applyBroadcastifyPreset,
  isPennHillsPreset,
} from "../lib/broadcastifyPreset";
import { AUTH_IN_APP } from "../lib/authFeature";
import { booleanFieldChecked } from "../lib/formFields";
import { AccountSettings } from "./AuthScreen";
import { LocalAiPanel } from "./LocalAiPanel";
import { ServerSetup } from "./ServerSetup";
import { UpdatesBody, useUpdates } from "./UpdatesPanel";
import { clampAutoHideSec, useAlerts } from "../lib/alerts";
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
import {
  addPanelToBoard,
  newId,
  upsertSource,
  validateSourceFields,
} from "../lib/api";
import { ensureLocationParams, locationSaveError } from "../lib/location";
import { blankFeed, feedsSaveError, normalizeSafetyParams } from "../lib/safety";
import { LocationField } from "./LocationField";
import { SafetyFeedsField } from "./SafetyFeedsField";
import { TelevisionSettings } from "./TelevisionSettings";
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

export type SettingsTab =
  | "sources"
  | "configured"
  | "rotation"
  | "alerts"
  | "display"
  | "television"
  | "account"
  | "server"
  | "ai"
  | "updates"
  | "paths";

const ROTATION_PRESETS = [
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
] as const;

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
    return booleanFieldChecked(field, params[field.key]);
  }
  const v = params[field.key];
  return v === undefined || v === null ? "" : String(v);
}

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
  const { notifySourceSaved } = useSourceRefresh();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "sources");
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
      initial.preset = PENN_HILLS_FEED.preset;
      initial.feedId = PENN_HILLS_FEED.feedId;
      initial.includeArchives = true;
      // Global rule: audio sources support closed captions (default on; user may opt out).
      initial.enableCaptions = true;
    }
    if (typeId === "broadcastify.calls") {
      initial.selector = "system";
      initial.limit = 40;
      initial.keyId = CALLS_APP.keyId;
      initial.issuer = CALLS_APP.issuer;
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
    if (typeId === "safety.nearby") {
      initial.radiusMi = 10;
      initial.enableCaptions = true;
      initial.feeds = [blankFeed()];
    }
    setParams(initial);
    setSecrets(
      typeId === "broadcastify.owner"
        ? { "broadcastify.username": PENN_HILLS_FEED.username }
        : {},
    );
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
                text: "Penn Hills / Plum Police Dispatch (47291) is filled in. The password stays in the OS keyring. The desktop app calls the Feed Owner API for status, the relay listen URL, and personal-use archives. The live feed starts muted and captions run while it plays. Fixes stay on this computer. Audio stays on this computer.",
              }
            : typeId === "broadcastify.calls"
              ? {
                  kind: "warn",
                  text: "Separate from Feed Owner. Key ID and issuer are filled in for the approved Calls app. The signing secret stays in the OS keyring. The panel lists the call clips the API returns and plays them muted. A live playlist can wait.",
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
                : typeId === "safety.nearby"
                  ? {
                      kind: "warn",
                      text: "Nearby alerts use sources already set up, including Broadcastify Feed Owner. Each one keeps the county and state it covers. Audio starts muted, and captions stay on while the sound is off.",
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
    if (source.type === "safety.nearby") {
      if (!Array.isArray(nextParams.feeds) || nextParams.feeds.length === 0) {
        nextParams.feeds = [blankFeed()];
      }
      if (nextParams.radiusMi === undefined || nextParams.radiusMi === "") {
        nextParams.radiusMi = 10;
      }
      if (nextParams.enableCaptions === undefined) {
        nextParams.enableCaptions = true;
      }
    }
    if (source.type === "broadcastify.owner") {
      const feedId = String(nextParams.feedId ?? "").trim();
      if (nextParams.preset !== "penn-hills" && nextParams.preset !== "custom") {
        nextParams.preset =
          feedId === PENN_HILLS_FEED.feedId || feedId === ""
            ? PENN_HILLS_FEED.preset
            : "custom";
      }
      if (nextParams.preset === PENN_HILLS_FEED.preset) {
        nextParams.feedId = PENN_HILLS_FEED.feedId;
      }
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
    const chicago = "City of Chicago Open Data — Crimes 2001 to Present";
    const seattle = "City of Seattle Open Data — SPD Crime Data";
    const current = typeof prev.attribution === "string" ? prev.attribution.trim() : "";
    // Switching Chicago ↔ Seattle should replace the other city's preset text.
    // A line the user actually typed stays put.
    const stillPreset = current === "" || current === chicago || current === seattle;
    if (provider === "chicago" || provider === "seattle") {
      return {
        ...prev,
        provider,
        attribution: stillPreset ? (provider === "seattle" ? seattle : chicago) : current,
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
    if (field.key === "preset" && adapter?.typeId === "broadcastify.owner") {
      const nextPreset = String(raw);
      setParams((p) => applyBroadcastifyPreset(nextPreset, p));
      if (nextPreset !== "custom") {
        setSecrets((current) =>
          current["broadcastify.username"]?.trim()
            ? current
            : { ...current, "broadcastify.username": PENN_HILLS_FEED.username },
        );
      }
      return;
    }
    if (field.key === "feedId" && adapter?.typeId === "broadcastify.owner") {
      const feedId = String(raw).trim();
      setParams((p) => ({
        ...p,
        feedId: raw,
        preset:
          feedId === PENN_HILLS_FEED.feedId
            ? PENN_HILLS_FEED.preset
            : p.preset === PENN_HILLS_FEED.preset
              ? "custom"
              : p.preset,
      }));
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
        if (adapter.typeId === "broadcastify.owner" && key === "feedId") {
          return !isPennHillsPreset(params);
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
      const locationError = locationSaveError(adapter.fields, params);
      if (locationError) {
        setMessage({ kind: "error", text: locationError });
        return;
      }
      if (adapter.typeId === "safety.nearby") {
        const safetyError = feedsSaveError(params);
        if (safetyError) {
          setMessage({ kind: "error", text: safetyError });
          return;
        }
      }
      const readyParams = ensureLocationParams(adapter.fields, params);
      const validation = await validateSourceFields(required, readyParams, secretsProvided);
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
      const cleanedParams = { ...readyParams };
      if (
        adapter.typeId === "incident.opendata" &&
        String(cleanedParams.provider) !== "custom"
      ) {
        delete cleanedParams.endpoint;
      }
      if (adapter.typeId === "broadcastify.owner" && isPennHillsPreset(cleanedParams)) {
        cleanedParams.preset = PENN_HILLS_FEED.preset;
        cleanedParams.feedId = PENN_HILLS_FEED.feedId;
      }
      if (adapter.typeId === "safety.nearby") {
        Object.assign(cleanedParams, normalizeSafetyParams(cleanedParams));
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
          title: panelTitleFor(adapter, cleanedParams),
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
      const memberTypes = rotateSourceIds.map((id) => state.sources[id]?.type);
      const hasQuake = memberTypes.includes("usgs.earthquake");
      const hasWeather = memberTypes.includes("weather.openmeteo");
      const hasRichPanel = memberTypes.some(
        (type) =>
          type === "incident.opendata" ||
          type === "broadcastify.owner" ||
          type === "broadcastify.calls" ||
          type === "camera.http_image" ||
          type === "video.youtube" ||
          type === "safety.nearby",
      );
      // Match the single-source panel size so a weather or quake slot is not crushed.
      const layoutSize = hasQuake
        ? { w: 32, h: 34, minW: 18, minH: 18 }
        : hasWeather
          ? { w: 28, h: 32, minW: 16, minH: 18 }
          : hasRichPanel
            ? { w: 24, h: 24, minW: 12, minH: 12 }
            : { w: 20, h: 16, minW: 10, minH: 10 };

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
          ...layoutSize,
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
        title: def ? panelTitleFor(def, source.params) : source.type,
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
                sources={state.sources}
                busy={busy}
                editingSourceId={editingSourceId}
                onChange={updateField}
                onParams={setParams}
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
                  Pick any combination of configured sources and cycle them inside{" "}
                  <strong style={{ color: "var(--cc-text)", fontWeight: 500 }}>one</strong> board
                  panel on a timer. Configure sources first, then turn rotation on here.
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
                        const order = rotateSourceIds.indexOf(id);
                        const checked = order >= 0;
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
                                {checked ? <span className="badge">{order + 1}</span> : null}
                                <span className="badge">{source.type}</span>
                              </h3>
                              <p>{id}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p style={{ margin: "8px 0 0", color: "var(--cc-text-muted)", fontSize: "0.8rem" }}>
                    Any mix of saved sources. At least two. They cycle in the order you check them.
                  </p>

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

function panelTitleFor(
  adapter: AdapterDefinition,
  params: Record<string, unknown>,
): string {
  if (adapter.typeId === "broadcastify.owner" && isPennHillsPreset(params)) {
    return PENN_HILLS_FEED.name;
  }
  if (adapter.typeId === "broadcastify.calls") {
    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (label) return label;
  }
  if (adapter.typeId === "camera.http_image" || adapter.typeId === "video.youtube") {
    const label = typeof params.label === "string" ? params.label.trim() : "";
    if (label) return label;
  }
  return adapter.name;
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
  if (typeId === "safety.nearby") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 40,
      h: 46,
      minW: 22,
      minH: 24,
    };
  }
  if (typeId === "broadcastify.owner" || typeId === "broadcastify.calls") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 28,
      h: 28,
      minW: 16,
      minH: 16,
    };
  }
  if (typeId === "incident.opendata") {
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
  if (typeId === "camera.http_image" || typeId === "video.youtube") {
    return {
      i: panelId,
      x: 0,
      y: yMax,
      w: 24,
      h: 18,
      minW: 12,
      minH: 10,
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
  sources,
  busy,
  editingSourceId,
  onChange,
  onParams,
  onCancel,
  onSave,
  onSaveAndAdd,
}: {
  adapter: AdapterDefinition;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  sources: Record<string, { type: string; params: Record<string, unknown> }>;
  busy: boolean;
  editingSourceId: string | null;
  onChange: (field: AdapterField, raw: string | boolean) => void;
  onParams: (params: Record<string, unknown>) => void;
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
          if (field.kind === "feeds") {
            return (
              <div className="field" key={field.key}>
                <label>
                  {field.label}
                  {field.required ? <span className="req"> *</span> : null}
                </label>
                <SafetyFeedsField params={params} sources={sources} disabled={busy} onChange={onParams} />
                {field.help ? <div className="help">{field.help}</div> : null}
              </div>
            );
          }
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
              {field.kind === "location" && field.help ? (
                <div className="help location-help">{field.help}</div>
              ) : null}
              {field.kind === "location" ? (
                <LocationField
                  field={field}
                  params={params}
                  disabled={busy}
                  onChange={onParams}
                />
              ) : field.kind === "boolean" ? (
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
              {field.help && field.kind !== "location" ? (
                <div className="help">{field.help}</div>
              ) : null}
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

  useEffect(() => subscribeDisplayPrefs(() => setPrefs(readDisplayPrefs())), []);

  async function apply(next: Omit<DisplayPrefs, "density">) {
    setBusy(true);
    try {
      const saved = await applyDisplayPrefs({ ...next, density: readDisplayPrefs().density });
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
    </>
  );
}
