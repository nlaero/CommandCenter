import { useState } from "react";
import { ADAPTER_CATALOG, getAdapter } from "../adapters/catalog";
import { addPanelToBoard, newId, saveAppState, upsertSource } from "../lib/api";
import { panelTitleFor, rollingLayoutFor, panelLayoutFor } from "../lib/panelLayout";
import {
  editParams,
  initialParams,
  initialSecrets,
  newSourceId,
  prepareSource,
  sourceHint,
} from "../lib/sourceDraft";
import { SOURCE_GROUP_ORDER, rollingPanelRefusal, sourceGroup } from "../lib/rolling";
import { useSourceRefresh } from "../lib/sourceRefresh";
import type { AppState, Panel, SourceConfig } from "../types";
import { SourceFields } from "./SourceFields";

type Props = {
  state: AppState;
  onState: (state: AppState) => void;
};

type MemberDraft = {
  key: string;
  sourceId: string | null;
  typeId: string;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
};

type EditorState = {
  panelId: string | null;
  members: MemberDraft[];
  rolling: boolean;
  interval: number;
  warning: string | null;
};

const INTERVALS = [
  { label: "15s", value: 15 },
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
];

function memberFromSource(sourceId: string, source: SourceConfig): MemberDraft {
  return {
    key: sourceId,
    sourceId,
    typeId: source.type,
    params: editParams(source.type, source.params),
    secrets: {},
  };
}

function freshMember(typeId: string): MemberDraft {
  return {
    key: newId("member"),
    sourceId: null,
    typeId,
    params: initialParams(typeId),
    secrets: initialSecrets(typeId),
  };
}

function sourceIdsUsed(state: AppState): Set<string> {
  const used = new Set<string>();
  for (const board of state.boards) {
    for (const panel of board.panels) {
      if (panel.source) used.add(panel.source);
      for (const id of panel.rotation?.sourceIds ?? []) used.add(id);
    }
  }
  return used;
}

function dropOrphans(state: AppState): AppState {
  const used = sourceIdsUsed(state);
  const sources: AppState["sources"] = {};
  for (const [id, source] of Object.entries(state.sources)) {
    if (used.has(id)) sources[id] = source;
  }
  return { ...state, sources };
}

export function PanelSettings({ state, onState }: Props) {
  const { notifySourceSaved } = useSourceRefresh();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const board = state.boards.find((item) => item.id === state.activeBoardId) ?? state.boards[0];

  function openNew(typeId: string) {
    setEditor({
      panelId: null,
      members: [freshMember(typeId)],
      rolling: false,
      interval: 30,
      warning: null,
    });
    setMessage(null);
    setConfirmDelete(null);
  }

  function openEdit(panel: Panel) {
    const ids =
      panel.rotation?.enabled && panel.rotation.sourceIds.length >= 2
        ? panel.rotation.sourceIds
        : [panel.source];
    const members = ids
      .map((id) => {
        const source = state.sources[id];
        return source ? memberFromSource(id, source) : null;
      })
      .filter((item): item is MemberDraft => Boolean(item));
    const rolling = Boolean(panel.rotation?.enabled && ids.length >= 2);
    const warning = rolling ? rollingPanelRefusal(members.map((item) => item.typeId)) : null;
    setEditor({
      panelId: panel.id,
      members,
      rolling,
      interval: panel.rotation?.intervalSec ?? 30,
      warning,
    });
    setMessage(null);
    setConfirmDelete(null);
  }

  function tryAdd(typeId: string) {
    if (!editor) {
      openNew(typeId);
      return;
    }
    const typeIds = editor.members.map((item) => item.typeId);
    if (editor.rolling || typeIds.length > 0) {
      const refusal = rollingPanelRefusal([...typeIds, typeId]);
      if (refusal) {
        setEditor({ ...editor, warning: refusal });
        return;
      }
    }
    setEditor({
      ...editor,
      warning: null,
      members: [...editor.members, freshMember(typeId)],
    });
  }

  function setRolling(enabled: boolean) {
    setEditor((current) => {
      if (!current) return current;
      if (!enabled) return { ...current, rolling: false, warning: null };
      const refusal = rollingPanelRefusal(current.members.map((item) => item.typeId));
      if (refusal) return { ...current, rolling: false, warning: refusal };
      if (current.members.length === 0) return { ...current, warning: "Choose a source first." };
      return { ...current, rolling: true, warning: null };
    });
  }

  async function save() {
    if (!editor || !board) return;
    if (editor.members.length === 0) {
      setMessage({ kind: "error", text: "Choose a source." });
      return;
    }
    if (editor.rolling) {
      const refusal = rollingPanelRefusal(editor.members.map((item) => item.typeId));
      if (refusal) {
        setEditor({ ...editor, warning: refusal });
        return;
      }
      if (editor.members.length < 2) {
        setMessage({ kind: "error", text: "A rolling panel needs at least two sources that scroll." });
        return;
      }
    } else if (editor.members.length > 1) {
      setMessage({
        kind: "error",
        text: "Turn on rolling to keep more than one source, or remove the extra sources.",
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const preparedMembers: { sourceId: string; created: boolean; typeId: string; source: SourceConfig; secrets: Record<string, string> }[] = [];
      for (const member of editor.members) {
        const existing = member.sourceId ? state.sources[member.sourceId] : undefined;
        const prepared = await prepareSource({
          typeId: member.typeId,
          params: member.params,
          secrets: member.secrets,
          existing,
        });
        if (!prepared.ok) {
          setMessage({ kind: "error", text: prepared.message });
          return;
        }
        preparedMembers.push({
          sourceId: member.sourceId ?? newSourceId(member.typeId),
          created: member.sourceId === null,
          typeId: member.typeId,
          source: prepared.value.source,
          secrets: prepared.value.secretsProvided,
        });
      }
      let next = state;
      const ids: string[] = [];
      const typeIds: string[] = [];
      for (const member of preparedMembers) {
        next = await upsertSource(member.sourceId, member.source, member.secrets);
        notifySourceSaved(member.sourceId);
        ids.push(member.sourceId);
        typeIds.push(member.typeId);
      }
      const interval = Math.min(3600, Math.max(5, Math.round(editor.interval) || 30));
      const first = getAdapter(typeIds[0]);
      const title = editor.rolling
        ? "Rolling"
        : first
          ? panelTitleFor(first, editor.members[0].params)
          : "Panel";
      if (editor.panelId) {
        const current = next.boards.find((item) => item.id === board.id);
        const previous = current?.panels.find((item) => item.id === editor.panelId);
        if (!current || !previous) {
          setMessage({ kind: "error", text: "That panel is no longer on this board." });
          return;
        }
        const panel: Panel = {
          ...previous,
          title,
          widget: editor.rolling ? "rotate" : (first?.defaultWidget ?? previous.widget),
          source: ids[0],
          options: { typeId: typeIds[0] },
          rotation: editor.rolling ? { enabled: true, intervalSec: interval, sourceIds: ids } : undefined,
        };
        next = {
          ...next,
          boards: next.boards.map((item) =>
            item.id === board.id
              ? { ...item, panels: item.panels.map((row) => (row.id === panel.id ? panel : row)) }
              : item,
          ),
        };
        next = dropOrphans(next);
        await saveAppState(next);
        onState(next);
        setEditor(null);
        setMessage({ kind: "ok", text: "Saved this panel." });
        return;
      }
      const yMax =
        next.boards
          .find((item) => item.id === board.id)
          ?.panels.reduce((max, panel) => Math.max(max, panel.layout.y + panel.layout.h), 0) ?? 0;
      const panelId = newId("panel");
      const panel: Panel = {
        id: panelId,
        title,
        widget: editor.rolling ? "rotate" : (first?.defaultWidget ?? "watch"),
        source: ids[0],
        options: { typeId: typeIds[0] },
        layout: editor.rolling
          ? rollingLayoutFor(typeIds, panelId, yMax)
          : panelLayoutFor(typeIds[0], panelId, yMax),
        rotation: editor.rolling ? { enabled: true, intervalSec: interval, sourceIds: ids } : undefined,
      };
      try {
        next = await addPanelToBoard(board.id, panel);
      } catch (err) {
        const created = new Set(preparedMembers.filter((item) => item.created).map((item) => item.sourceId));
        const sources = { ...next.sources };
        for (const id of created) delete sources[id];
        const cleaned = { ...next, sources };
        await saveAppState(cleaned);
        onState(cleaned);
        throw err;
      }
      onState(next);
      setEditor(null);
      setMessage({ kind: "ok", text: editor.rolling ? "Added a rolling panel." : "Added the panel." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function removePanel(panelId: string) {
    if (!board) return;
    setBusy(true);
    setMessage(null);
    try {
      let next: AppState = {
        ...state,
        boards: state.boards.map((item) =>
          item.id === board.id
            ? { ...item, panels: item.panels.filter((panel) => panel.id !== panelId) }
            : item,
        ),
      };
      next = dropOrphans(next);
      await saveAppState(next);
      onState(next);
      if (editor?.panelId === panelId) setEditor(null);
      setConfirmDelete(null);
      setMessage({ kind: "ok", text: "Deleted the panel." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="section-label">Panels on this board</p>
      <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        Settings lists the panels already on {board?.title ?? "this board"}. Adjust a panel here, or
        delete it. A source that is no longer on any panel is dropped.
      </p>
      {message ? <div className={`alert ${message.kind}`}>{message.text}</div> : null}
      {!board || board.panels.length === 0 ? (
        <p style={{ color: "var(--cc-text-muted)" }}>No panels yet. Choose a source below.</p>
      ) : (
        <div className="source-list">
          {board.panels.map((panel) => {
            const source = state.sources[panel.source];
            const extra = panel.rotation?.enabled ? Math.max(0, panel.rotation.sourceIds.length - 1) : 0;
            const name = getAdapter(source?.type ?? "")?.name ?? source?.type ?? panel.widget;
            return (
              <div className="source-row" key={panel.id}>
                <div>
                  <h3>
                    {panel.title || name}
                    {extra > 0 ? <span className="badge">rolling</span> : null}
                  </h3>
                  <p>
                    {name}
                    {extra > 0 ? ` and ${extra} more` : ""}
                  </p>
                </div>
                <div className="source-row-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => openEdit(panel)}>
                    Adjust
                  </button>
                  {confirmDelete === panel.id ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => void removePanel(panel.id)}
                    >
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setConfirmDelete(panel.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="section-label" style={{ marginTop: 22 }}>
        {editor?.panelId ? "Adjust panel" : "New panel"}
      </p>
      <div className="field">
        <label htmlFor="new-panel-source">{editor && editor.members.length > 0 ? "Add a source" : "Source"}</label>
        <select
          id="new-panel-source"
          value=""
          disabled={busy}
          onChange={(event) => {
            const typeId = event.target.value;
            if (!typeId) return;
            if (!editor) openNew(typeId);
            else tryAdd(typeId);
          }}
        >
          <option value="">{editor && editor.members.length > 0 ? "Add a source" : "Choose a source"}</option>
          {SOURCE_GROUP_ORDER.map((group) => {
            const items = ADAPTER_CATALOG.filter((adapter) => sourceGroup(adapter.typeId) === group);
            if (items.length === 0) return null;
            return (
              <optgroup key={group} label={group}>
                {items.map((adapter) => (
                  <option key={adapter.typeId} value={adapter.typeId}>
                    {adapter.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
      </div>

      {editor ? (
        <div style={{ marginTop: 14 }}>
          {editor.warning ? (
            <div className="alert warn" role="alert">
              {editor.warning}
            </div>
          ) : null}
          <label className="rotate-optin">
            <input
              type="checkbox"
              checked={editor.rolling}
              disabled={busy || editor.members.length === 0}
              onChange={(event) => setRolling(event.target.checked)}
            />
            <span>Make this panel rolling</span>
          </label>
          <p className="help">
            A rolling panel switches between sources that scroll. A live feed stays its own panel.
            Weather rotates its own maps inside the weather panel, so it stays its own panel too.
          </p>
          {editor.rolling ? (
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="panel-interval">Switch every</label>
              <div className="rotate-interval-row">
                {INTERVALS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={`btn${editor.interval === preset.value ? " active" : ""}`}
                    disabled={busy}
                    onClick={() =>
                      setEditor((current) => (current ? { ...current, interval: preset.value } : current))
                    }
                  >
                    {preset.label}
                  </button>
                ))}
                <input
                  id="panel-interval"
                  type="number"
                  min={5}
                  max={3600}
                  value={editor.interval}
                  disabled={busy}
                  onWheel={(event) => event.currentTarget.blur()}
                  onChange={(event) =>
                    setEditor((current) =>
                      current ? { ...current, interval: Number(event.target.value) || 30 } : current,
                    )
                  }
                />
              </div>
            </div>
          ) : null}

          {editor.members.map((member, index) => {
            const adapter = getAdapter(member.typeId);
            if (!adapter) return null;
            const hint = sourceHint(member.typeId);
            return (
              <details key={member.key} open={index === 0 || editor.members.length < 4} style={{ marginTop: 12 }}>
                <summary>
                  {adapter.name}
                  {member.sourceId ? "" : " · new"}
                </summary>
                {hint ? <p className="help">{hint}</p> : null}
                <p style={{ margin: "8px 0", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
                  {adapter.description}
                </p>
                <SourceFields
                  adapter={adapter}
                  params={member.params}
                  secrets={member.secrets}
                  sources={state.sources}
                  busy={busy}
                  editing={Boolean(member.sourceId)}
                  onParams={(params) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            members: current.members.map((item) =>
                              item.key === member.key ? { ...item, params } : item,
                            ),
                          }
                        : current,
                    )
                  }
                  onSecrets={(secrets) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            members: current.members.map((item) =>
                              item.key === member.key ? { ...item, secrets } : item,
                            ),
                          }
                        : current,
                    )
                  }
                />
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      setEditor((current) => {
                        if (!current) return current;
                        const members = current.members.filter((item) => item.key !== member.key);
                        if (members.length === 0) return null;
                        return {
                          ...current,
                          members,
                          rolling: current.rolling && members.length >= 2,
                          warning: null,
                        };
                      });
                    }}
                  >
                    Remove this source
                  </button>
                </div>
              </details>
            );
          })}

          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              {editor.panelId ? "Save panel" : "Add panel"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setEditor(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
