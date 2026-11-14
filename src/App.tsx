import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertsPane } from "./components/AlertsPane";
import { BoardSwitcher } from "./components/BoardSwitcher";
import { BoardView } from "./components/BoardView";
import { SettingsView } from "./components/SettingsView";
import { AuthScreen } from "./components/AuthScreen";
import { AlertsProvider } from "./lib/alerts";
import { authLogout, loadAuthSession } from "./lib/auth";
import { applyDisplayPrefs, readDisplayPrefs } from "./lib/display";
import { syncBoard } from "./lib/sync";
import {
  createBoard,
  loadAppState,
  saveBoardLayout,
  setActiveBoard,
  setEditMode,
} from "./lib/api";
import { SourceRefreshProvider } from "./lib/sourceRefresh";
import type { AppState, AuthSession, ConfigPaths, GridItem } from "./types";

export default function App() {
  return (
    <SourceRefreshProvider>
      <AppShell />
    </SourceRefreshProvider>
  );
}

function AppShell() {
  const [state, setState] = useState<AppState | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [paths, setPaths] = useState<ConfigPaths | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const syncedFor = useRef<string | null>(null);
  const [width, setWidth] = useState(1200);
  const stageRef = useRef<HTMLDivElement>(null);
  const boardMainRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void applyDisplayPrefs(readDisplayPrefs()).catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadAppState();
        const auth = await loadAuthSession();
        if (cancelled) return;
        setState(result.state);
        setPaths(result.paths);
        setSession(auth);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!session?.signedIn || !session.user) {
      syncedFor.current = null;
      return;
    }
    const userId = session.user.id;
    if (syncedFor.current === userId) return;
    let cancelled = false;
    void syncBoard()
      .then((result) => {
        if (cancelled) return;
        syncedFor.current = userId;
        if (result.restored) {
          setState(result.state);
          setSyncNote(
            result.message ??
              "Restored your boards and sources from this account. API keys stay on this computer.",
          );
        } else if (result.message) {
          setError(result.message);
        } else {
          setSyncNote(null);
        }
      })
      .catch(() => {
        if (!cancelled) syncedFor.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [session?.signedIn, session?.user?.id]);

  useEffect(() => {
    const el = boardMainRef.current ?? stageRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (state?.auth.enabled && session && !session.signedIn) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void toggleEdit();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, session]);

  const activeBoard = useMemo(
    () => state?.boards.find((b) => b.id === state.activeBoardId) ?? state?.boards[0],
    [state],
  );

  const toggleEdit = useCallback(async () => {
    if (!state) return;
    const next = await setEditMode(!state.editMode);
    setState(next);
  }, [state]);

  const onLayoutChange = useCallback(
    (items: GridItem[]) => {
      if (!state || !activeBoard) return;
      setState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          boards: prev.boards.map((board) =>
            board.id !== activeBoard.id
              ? board
              : {
                  ...board,
                  panels: board.panels.map((panel) => {
                    const layout = items.find((i) => i.i === panel.id);
                    return layout ? { ...panel, layout } : panel;
                  }),
                },
          ),
        };
      });
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void saveBoardLayout(activeBoard.id, items).catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }, 250);
    },
    [state, activeBoard],
  );

  if (error && !state) {
    return (
      <div className="app-shell">
        <div className="empty-board">
          <div>
            <h1>Failed to load</h1>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!state || !paths || !session || !activeBoard) {
    return (
      <div className="app-shell">
        <div className="empty-board">
          <div>
            <h1>Command Center</h1>
            <p>Loading…</p>
          </div>
        </div>
      </div>
    );
  }

  if (state.auth.enabled && !session.signedIn) {
    return (
      <AuthScreen
        settings={state.auth}
        session={session}
        onSession={setSession}
        onState={setState}
      />
    );
  }

  return (
    <AlertsProvider>
      <div className="app-shell">
        <header className="chrome">
          <div className="brand">
            Command <span>Center</span>
          </div>
          <BoardSwitcher
            boards={state.boards}
            activeBoardId={activeBoard.id}
            onSelect={(id) => {
              void setActiveBoard(id).then(setState);
            }}
            onCreate={() => {
              const title = window.prompt("New board name", "Ops");
              if (!title?.trim()) return;
              void createBoard(title.trim()).then(setState);
            }}
          />
          <div className="chrome-spacer" />
          {session.signedIn && session.user ? (
            <div className="chrome-user" title={session.offline ? "Signed in offline" : "Signed in"}>
              {session.user.username}
              {session.offline ? <span className="badge">offline</span> : null}
            </div>
          ) : null}
          <div className="chrome-meta" title={paths.root}>
            {paths.overrideActive ? "portable · " : ""}
            {paths.root}
          </div>
          <button
            type="button"
            className={`btn${state.editMode ? " active" : ""}`}
            onClick={() => void toggleEdit()}
            title="Toggle edit layout (Ctrl/Cmd+E)"
          >
            {state.editMode ? "Editing layout" : "Edit layout"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setSettingsOpen(true)}
            title="Settings (Ctrl/Cmd+,)"
          >
            Settings
          </button>
          {session.signedIn ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                void authLogout().then(setSession).catch((err) => {
                  setError(err instanceof Error ? err.message : String(err));
                });
              }}
            >
              Sign out
            </button>
          ) : null}
        </header>

        <main className="main-stage" ref={stageRef}>
          {error ? (
            <div className="alert error" role="alert" style={{ margin: 12 }}>
              {error}
            </div>
          ) : null}
          {syncNote ? (
            <div className="alert ok" role="status" style={{ margin: 12 }}>
              {syncNote}{" "}
              <button type="button" className="btn btn-ghost" onClick={() => setSyncNote(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="board-with-alerts">
            <div className="board-with-alerts-main" ref={boardMainRef}>
              <BoardView
                state={state}
                board={activeBoard}
                width={width}
                onOpenSettings={() => setSettingsOpen(true)}
                onLayoutChange={onLayoutChange}
              />
            </div>
            <AlertsPane />
          </div>
          {settingsOpen ? (
            <SettingsView
              state={state}
              paths={paths}
              session={session}
              onClose={() => setSettingsOpen(false)}
              onState={setState}
              onSession={setSession}
            />
          ) : null}
        </main>
      </div>
    </AlertsProvider>
  );
}
