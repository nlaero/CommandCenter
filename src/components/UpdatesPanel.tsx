import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../lib/auth";
import { AUTH_IN_APP } from "../lib/authFeature";
import {
  applyUpdate,
  checkForUpdates,
  openRelease,
  tauriApp,
  updateSummary,
  type ApplyResult,
  type UpdateProduct,
  type UpdateReport,
} from "../lib/updates";

type Note = { kind: "ok" | "error"; text: string };

type UpdatesApi = {
  report: UpdateReport | null;
  checking: boolean;
  checkError: string | null;
  applyNote: Note | null;
  applying: string | null;
  open: boolean;
  dismissed: boolean;
  hasUpdate: boolean;
  check: (force: boolean) => Promise<void>;
  openUpdates: () => void;
  close: () => void;
  dismiss: () => void;
  apply: (product: UpdateProduct) => Promise<void>;
  openPage: (url: string) => Promise<void>;
};

const UpdatesContext = createContext<UpdatesApi | null>(null);

export function useUpdates(): UpdatesApi {
  const value = useContext(UpdatesContext);
  if (!value) {
    throw new Error("Updates are only available inside the app shell.");
  }
  return value;
}

export function UpdatesProvider({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<UpdateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [applyNote, setApplyNote] = useState<Note | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const openRef = useRef<() => void>(() => undefined);

  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    setCheckError(null);
    try {
      const next = await checkForUpdates(force);
      setReport(next);
    } catch (err) {
      setCheckError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  const openUpdates = useCallback(() => {
    setOpen(true);
    setApplyNote(null);
    void check(true);
  }, [check]);

  openRef.current = openUpdates;

  useEffect(() => {
    void check(false);
  }, [check]);

  useEffect(() => {
    if (!tauriApp()) return;
    let unlisten: (() => void) | undefined;
    let cancel = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("check-updates", () => {
        openRef.current();
      });
      if (cancel) stop();
      else unlisten = stop;
    });
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, []);

  const apply = useCallback(async (product: UpdateProduct) => {
    setApplying(product.id);
    setApplyNote(null);
    try {
      const result: ApplyResult = await applyUpdate(product.id);
      setApplyNote({ kind: "ok", text: result.message });
      const next = await checkForUpdates(true);
      setReport(next);
    } catch (err) {
      setApplyNote({ kind: "error", text: errorMessage(err) });
    } finally {
      setApplying(null);
    }
  }, []);

  const openPage = useCallback(async (url: string) => {
    try {
      await openRelease(url);
    } catch (err) {
      setApplyNote({ kind: "error", text: errorMessage(err) });
    }
  }, []);

  const hasUpdate = report?.products.some((product) => product.updateAvailable) ?? false;

  const value = useMemo<UpdatesApi>(
    () => ({
      report,
      checking,
      checkError,
      applyNote,
      applying,
      open,
      dismissed,
      hasUpdate,
      check,
      openUpdates,
      close: () => setOpen(false),
      dismiss: () => setDismissed(true),
      apply,
      openPage,
    }),
    [
      report,
      checking,
      checkError,
      applyNote,
      applying,
      open,
      dismissed,
      hasUpdate,
      check,
      openUpdates,
      apply,
      openPage,
    ],
  );

  return (
    <UpdatesContext.Provider value={value}>
      {children}
      {createPortal(<UpdateSurfaces />, document.body)}
    </UpdatesContext.Provider>
  );
}

export function UpdatesBody() {
  const updates = useUpdates();
  return (
    <>
      <p className="section-label">GitHub releases</p>
      <p className="update-lead">
        {AUTH_IN_APP
          ? "Command Center checks GitHub for a newer release of this app and of auth-server. Nothing is downloaded until you choose it here."
          : "Command Center checks GitHub for a newer release of this app. Nothing is downloaded until you choose it here."}
      </p>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button
          type="button"
          className="btn"
          disabled={updates.checking}
          onClick={() => void updates.check(true)}
        >
          {updates.checking ? "Checking…" : "Check again"}
        </button>
      </div>
      {updates.checkError ? (
        <div className="alert error" role="alert">
          {updates.checkError}
        </div>
      ) : null}
      {updates.applyNote ? (
        <div className={`alert ${updates.applyNote.kind}`} role="status">
          {updates.applyNote.text}
        </div>
      ) : null}
      {updates.checking && !updates.report ? (
        <p className="update-lead">Checking GitHub releases…</p>
      ) : null}
      <div className="source-list" style={{ marginTop: 16 }}>
        {(updates.report?.products ?? []).map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            busy={updates.applying === product.id}
            disabled={updates.applying !== null}
            onApply={() => void updates.apply(product)}
            onOpen={() => {
              if (product.htmlUrl) void updates.openPage(product.htmlUrl);
            }}
          />
        ))}
      </div>
    </>
  );
}

function ProductCard({
  product,
  busy,
  disabled,
  onApply,
  onOpen,
}: {
  product: UpdateProduct;
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onOpen: () => void;
}) {
  const published = product.publishedAt ? product.publishedAt.slice(0, 10) : null;
  return (
    <div className="source-row update-row">
      <div>
        <h3>
          {product.name}
          {product.updateAvailable ? <span className="badge">update</span> : null}
          {product.updateAvailable && product.prerelease ? (
            <span className="badge">prerelease</span>
          ) : null}
        </h3>
        <p>{product.message}</p>
        <p className="update-meta">
          {product.currentVersion ? `Installed ${product.currentVersion}` : "Installed version unknown"}
          {product.latestVersion ? ` · Latest ${product.latestVersion}` : ""}
          {published ? ` · ${published}` : ""}
        </p>
        <p className="update-meta">
          {product.currentDetail}
          {product.assetName ? ` · ${product.assetName}` : ""}
        </p>
        <p className="update-meta">{product.repo}</p>
        {product.notes ? <p className="update-notes">{product.notes}</p> : null}
        {product.error ? (
          <div className="alert error" role="alert">
            {product.error}
          </div>
        ) : null}
        <div className="form-actions">
          {product.canApply && product.applyLabel ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled}
              onClick={onApply}
            >
              {busy ? "Working…" : product.applyLabel}
            </button>
          ) : null}
          {product.htmlUrl ? (
            <button type="button" className="btn" onClick={onOpen}>
              Release page
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function UpdateSurfaces() {
  const updates = useUpdates();
  const summary = updateSummary(updates.report);

  useEffect(() => {
    if (!updates.open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") updates.close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updates]);

  return (
    <>
      {summary && !updates.dismissed && !updates.open ? (
        <div className="update-banner alert warn" role="status">
          <span>{summary}</span>
          <button type="button" className="btn btn-primary" onClick={() => updates.openUpdates()}>
            View
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => updates.dismiss()}>
            Dismiss
          </button>
        </div>
      ) : null}
      {updates.open ? (
        <div
          className="update-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) updates.close();
          }}
        >
          <div
            className="settings-sheet updates-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Updates"
          >
            <header className="settings-header">
              <h2>Updates</h2>
              <button type="button" className="btn" onClick={() => updates.close()} autoFocus>
                Close
              </button>
            </header>
            <div className="updates-body">
              <UpdatesBody />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
