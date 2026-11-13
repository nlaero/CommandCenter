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

type Tab = "sources" | "configured" | "paths";

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

  const adapter = selectedType ? getAdapter(selectedType) : undefined;
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
    setParams({});
    setSecrets({});
    setMessage(
      def?.stubNote
        ? { kind: "warn", text: def.stubNote }
        : null,
    );
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
    setParams((p) => ({ ...p, [field.key]: raw }));
  }

  async function saveSource(addToBoard: boolean) {
    if (!adapter) return;
    setBusy(true);
    setMessage(null);
    try {
      const required = requiredKeys(adapter);
      const validation = await validateSourceFields(required, params, secrets);
      if (!validation.ok) {
        setMessage({ kind: "error", text: validation.message });
        return;
      }

      const sourceId = newId(`src.${adapter.typeId.split(".").pop()}`);
      const secretRefs = Object.keys(secrets).filter((k) => secrets[k]?.trim());
      const source: SourceConfig = {
        type: adapter.typeId,
        params,
        refresh: adapter.defaultRefresh,
        secrets: secretRefs.map((k) => k),
        enabled: true,
        draft: false,
      };

      let next = await upsertSource(sourceId, source);

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
          layout: {
            i: panelId,
            x: 0,
            y: yMax,
            w: 16,
            h: 14,
            minW: 8,
            minH: 8,
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
        layout: {
          i: panelId,
          x: 0,
          y: yMax,
          w: 16,
          h: 14,
          minW: 8,
          minH: 8,
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
