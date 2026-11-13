import { useMemo, useState } from "react";
import { ADAPTER_CATALOG, getAdapter } from "../adapters/catalog";
import {
  addPanelToBoard,
  newId,
  upsertSource,
  validateSourceFields,
} from "../lib/api";
import type {
  AdapterDefinition,
  AdapterField,
  AppState,
  ConfigPaths,
  Panel,
  SourceConfig,
} from "../types";

type Tab = "sources" | "configured" | "rotation" | "paths";

const ROTATION_PRESETS = [
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
] as const;

type Props = {
  state: AppState;
  paths: ConfigPaths;
  onClose: () => void;
  onState: (state: AppState) => void;
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

export function SettingsView({ state, paths, onClose, onState }: Props) {
  const [tab, setTab] = useState<Tab>("sources");
  const [selectedType, setSelectedType] = useState<string | null>(null);
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

  function startAdd(typeId: string) {
    const def = getAdapter(typeId);
    setSelectedType(typeId);
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
            : null,
    );
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
      const required = requiredKeys(adapter).filter((key) => {
        if (adapter.typeId === "incident.opendata" && key === "endpoint") {
          return String(params.provider ?? "") === "custom";
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
      const validation = await validateSourceFields(required, params, secrets);
      if (!validation.ok) {
        setMessage({ kind: "error", text: validation.message });
        return;
      }

      const sourceId = newId(`src.${adapter.typeId.split(".").pop()}`);
      const secretRefs = Object.keys(secrets).filter((k) => secrets[k]?.trim());
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
        refresh: adapter.defaultRefresh,
        secrets: secretRefs.map((k) => k),
        enabled: true,
        draft: false,
      };

      let next = await upsertSource(sourceId, source, secrets);

      if (addToBoard) {
        const panelId = newId("panel");
        const yMax = next.boards
          .find((b) => b.id === next.activeBoardId)
          ?.panels.reduce((max, p) => Math.max(max, p.layout.y + p.layout.h), 0) ?? 0;

        const wide =
          adapter.typeId === "incident.opendata" ||
          adapter.typeId === "broadcastify.owner";
        const panel: Panel = {
          id: panelId,
          title: adapter.name,
          widget: adapter.defaultWidget,
          source: sourceId,
          options: { typeId: adapter.typeId },
          layout: {
            i: panelId,
            x: 0,
            y: yMax,
            w: wide ? 24 : 16,
            h: wide ? 22 : 14,
            minW: wide ? 12 : 8,
            minH: wide ? 12 : 8,
          },
        };
        next = await addPanelToBoard(next.activeBoardId, panel);
        setMessage({
          kind: "ok",
          text: `Saved ${sourceId} and added to the active board.`,
        });
      } else {
        setMessage({
          kind: "ok",
          text: `Saved ${sourceId}. Use Add to board when you want it on a board.`,
        });
      }

      onState(next);
      setSelectedType(null);
      setParams({});
      setSecrets({});
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
        return type === "incident.opendata" || type === "broadcastify.owner";
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
      const wide =
        source.type === "incident.opendata" || source.type === "broadcastify.owner";
      const panel: Panel = {
        id: panelId,
        title: def?.name ?? source.type,
        widget: def?.defaultWidget ?? "kpi",
        source: sourceId,
        options: { typeId: source.type },
        layout: {
          i: panelId,
          x: 0,
          y: yMax,
          w: wide ? 24 : 16,
          h: wide ? 22 : 14,
          minW: wide ? 12 : 8,
          minH: wide ? 12 : 8,
        },
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
                onChange={updateField}
                onCancel={() => {
                  setSelectedType(null);
                  setMessage(null);
                }}
                onSave={() => void saveSource(false)}
                onSaveAndAdd={() => void saveSource(true)}
              />
            ) : null}

            {tab === "configured" ? (
              <>
                <p className="section-label">Saved sources</p>
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
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy || source.draft}
                          onClick={() => void addConfiguredToBoard(id)}
                        >
                          Add to board
                        </button>
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
  onChange,
  onCancel,
  onSave,
  onSaveAndAdd,
}: {
  adapter: AdapterDefinition;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  busy: boolean;
  onChange: (field: AdapterField, raw: string | boolean) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndAdd: () => void;
}) {
  return (
    <div>
      <button type="button" className="btn btn-ghost" onClick={onCancel}>
        ← Back to catalog
      </button>
      <h3 style={{ margin: "12px 0 4px" }}>{adapter.name}</h3>
      <p style={{ margin: 0, color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        {adapter.description}
      </p>
      <div className="form-grid">
        {adapter.fields.map((field) => {
          const value = fieldValue(field, params, secrets);
          return (
            <div className="field" key={field.key}>
              <label htmlFor={field.key}>
                {field.label}
                {field.required ? <span className="req"> *</span> : null}
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
                  placeholder={field.placeholder}
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
          Save source
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={onSaveAndAdd}
        >
          Save & add to board
        </button>
      </div>
    </div>
  );
}
