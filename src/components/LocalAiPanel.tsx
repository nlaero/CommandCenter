import { useEffect, useId, useState } from "react";
import type { AuthSession } from "../types";
import { errorMessage } from "../lib/auth";
import { AUTH_IN_APP } from "../lib/authFeature";
import {
  applyCorrections,
  emptyMemory,
  removeCorrection,
  saveAiMemory,
  syncAiMemory,
  upsertCorrection,
  type AiMemory,
} from "../lib/aiMemory";
import { formatBytes, installLocalAi, localAiStatus, removeLocalAi, type LocalAiStatus } from "../lib/localAi";

type Note = { kind: "ok" | "error"; text: string };

export function LocalAiPanel({ session }: { session?: AuthSession | null }) {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [memory, setMemory] = useState<AiMemory>(emptyMemory());
  const [revision, setRevision] = useState<number | null>(null);
  const [heard, setHeard] = useState("");
  const [says, setSays] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const [nextStatus, synced] = await Promise.all([localAiStatus(), syncAiMemory()]);
        if (cancel) return;
        setStatus(nextStatus);
        setMemory(synced.memory);
        setRevision(synced.revision);
        if (synced.message) setNote({ kind: synced.restored ? "ok" : "error", text: synced.message });
      } catch (err) {
        if (!cancel) setNote({ kind: "error", text: errorMessage(err) });
      }
    })();
    return () => {
      cancel = true;
    };
  }, [session?.baseUrl, session?.user?.id]);

  async function install() {
    setBusy(true);
    setNote(null);
    try {
      const next = await installLocalAi();
      setStatus(next);
      setNote({ kind: "ok", text: "Tiny English is on this computer. Audio is not uploaded." });
    } catch (err) {
      setNote({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function uninstall() {
    setBusy(true);
    setNote(null);
    try {
      const next = await removeLocalAi();
      setStatus(next);
      setNote({
        kind: "ok",
        text: AUTH_IN_APP
          ? "Removed the model from this computer. Caption fixes stay on the server you are signed into."
          : "Removed the model from this computer. Caption fixes stay on this computer.",
      });
    } catch (err) {
      setNote({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function persist(next: AiMemory, ok: string) {
    setBusy(true);
    setNote(null);
    try {
      const saved = await saveAiMemory(next);
      setMemory(saved.memory);
      setRevision(saved.revision);
      setNote({
        kind: saved.message && !saved.published && !saved.restored ? "error" : "ok",
        text: saved.message ?? ok,
      });
    } catch (err) {
      setNote({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  function addFix(event: React.FormEvent) {
    event.preventDefault();
    try {
      const next = upsertCorrection(memory, heard, says);
      setHeard("");
      setSays("");
      void persist(
        next,
        AUTH_IN_APP
          ? "Saved. That fix syncs through the server you are signed into."
          : "Saved on this computer.",
      );
    } catch (err) {
      setNote({ kind: "error", text: errorMessage(err) });
    }
  }

  const server = session?.baseUrl?.trim() || "the server you are signed into";
  const installed = Boolean(status?.installed);

  return (
    <div className="server-setup">
      <p className="section-label">Local AI</p>
      <p className="auth-copy">
        {AUTH_IN_APP
          ? "Tiny English runs on this computer. Audio is not uploaded. Caption fixes sync through the server you are signed into, whether that server is on this computer or somewhere else."
          : "Tiny English runs on this computer. Audio is not uploaded. Caption fixes stay on this computer."}
      </p>

      {note ? (
        <div className={`alert ${note.kind}`} role="status">
          {note.text}
        </div>
      ) : null}
      {status?.message ? (
        <div className="alert error" role="alert">
          {status.message}
        </div>
      ) : null}

      {!installed ? (
        <>
          <div className="choice-grid">
            <div className="choice-card active">
              <strong>Tiny English</strong>
              <span>About 75 MB. Speech stays on this computer. Used for captions.</span>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install()}>
              {busy ? "Installing…" : "Install Tiny English"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="source-list">
            <div className="source-row update-row">
              <div>
                <h3>{status?.modelLabel ?? "Tiny English"}</h3>
                <p>
                  {formatBytes(status?.bytes ?? null)} on this computer
                  {status?.path ? ` · ${status.path}` : ""}. Audio is transcribed here.
                </p>
                <p className="update-meta">
                  {AUTH_IN_APP
                    ? `Caption fixes sync through ${server}${revision != null ? ` · revision ${revision}` : ""}`
                    : "Caption fixes stay on this computer."}
                </p>
              </div>
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void uninstall()}>
              Remove model
            </button>
          </div>
        </>
      )}

      <form className="auth-server" onSubmit={addFix}>
        <p className="section-label">Caption fixes</p>
        <p className="auth-copy">
          When a caption is wrong, say what was heard and what it should have been. Later clips
          pick that up. {AUTH_IN_APP
            ? "The same list follows this account onto other computers."
            : "The list stays on this computer."}
        </p>
        <div className="field">
          <label htmlFor="ai-heard">Heard</label>
          <input
            id="ai-heard"
            value={heard}
            onChange={(event) => setHeard(event.target.value)}
            placeholder="engine twelve"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="ai-says">Should say</label>
          <input
            id="ai-says"
            value={says}
            onChange={(event) => setSays(event.target.value)}
            placeholder="Engine 12"
            autoComplete="off"
          />
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save fix
          </button>
        </div>
        {memory.corrections.length ? (
          <div className="source-list">
            {memory.corrections.map((item) => (
              <div className="source-row" key={item.id}>
                <div>
                  <h3>
                    {item.heard} → {item.says}
                  </h3>
                  <p>Used {item.count} {item.count === 1 ? "time" : "times"}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => void persist(removeCorrection(memory, item.id), "Removed that fix.")}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="auth-copy">No fixes yet.</p>
        )}
      </form>
    </div>
  );
}

export function CaptionCorrection({
  suggestion,
  onSaved,
}: {
  suggestion: string;
  onSaved: (memory: AiMemory) => void;
}) {
  const heardId = useId();
  const saysId = useId();
  const [open, setOpen] = useState(false);
  const [heard, setHeard] = useState(suggestion);
  const [says, setSays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHeard(suggestion);
  }, [suggestion]);

  if (!open) {
    return (
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>
          Fix caption
        </button>
      </div>
    );
  }

  return (
    <form
      className="auth-server"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void (async () => {
          try {
            const current = await syncAiMemory();
            const next = upsertCorrection(current.memory, heard, says);
            const saved = await saveAiMemory(next);
            onSaved(saved.memory);
            setSays("");
            setOpen(false);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      <div className="field">
        <label htmlFor={heardId}>Heard</label>
        <input id={heardId} value={heard} onChange={(event) => setHeard(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={saysId}>Should say</label>
        <input
          id={saysId}
          value={says}
          onChange={(event) => setSays(event.target.value)}
          placeholder="Engine 12"
        />
      </div>
      {error ? (
        <div className="alert error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save fix
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function withCorrections<T extends { text: string }>(segments: T[], memory: AiMemory): T[] {
  return segments.map((segment) => ({ ...segment, text: applyCorrections(segment.text, memory) }));
}
