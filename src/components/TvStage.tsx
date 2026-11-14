import { useEffect, useRef, useState, type ReactNode } from "react";
import { BoardView } from "./BoardView";
import { AlertsPane } from "./AlertsPane";
import { AlertsProvider } from "../lib/alerts";
import { loadAuthSession } from "../lib/auth";
import { loadAppState } from "../lib/api";
import { boardSpanRows, closePictureCheck, tvRowHeight } from "../lib/cast";
import type { AppState, AuthSession, Board } from "../types";

type Props = {
  preview: boolean;
};

export function TvStage({ preview }: Props) {
  const [state, setState] = useState<AppState | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState({ width: 1280, height: 720 });
  const stageRef = useRef<HTMLElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("cc-tv");
    return () => document.documentElement.classList.remove("cc-tv");
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void (async () => {
        try {
          const [result, auth] = await Promise.all([loadAppState(), loadAuthSession()]);
          if (cancelled) return;
          setState(result.state);
          setSession(auth);
          setError(null);
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const el = boardRef.current ?? stageRef.current;
    if (!el) return;
    const update = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state, session, error]);

  const board: Board | undefined =
    state?.boards.find((item) => item.id === state.activeBoardId) ?? state?.boards[0];
  const signedOut = Boolean(state?.auth.enabled && session && !session.signedIn);
  const rowHeight =
    state && board
      ? tvRowHeight(state.layout.rowHeight, boardSpanRows(board.panels), box.height)
      : undefined;

  let body: ReactNode;
  if (error && !state) {
    body = (
      <div className="empty-board">
        <div>
          <h1>Command Center</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  } else if (!state || !session || !board) {
    body = (
      <div className="empty-board">
        <div>
          <h1>Command Center</h1>
          <p>Loading the board…</p>
        </div>
      </div>
    );
  } else if (signedOut) {
    body = (
      <div className="empty-board">
        <div>
          <h1>Command Center</h1>
          <p>Sign in on the computer to show the board here.</p>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="board-with-alerts">
        <div className="board-with-alerts-main" ref={boardRef}>
          <BoardView
            state={{ ...state, editMode: false }}
            board={board}
            width={box.width}
            rowHeight={rowHeight}
            displayOnly
            onOpenSettings={() => undefined}
            onLayoutChange={() => undefined}
          />
        </div>
        <AlertsPane />
      </div>
    );
  }

  return (
    <AlertsProvider>
      <div
        className={`app-shell is-tv${preview ? " is-preview" : ""}`}
        onContextMenu={(event) => event.preventDefault()}
      >
        {preview ? (
          <div className="tv-preview-banner">
            <p>
              Picture check on this computer. The television shows this board with no settings
              and no controls, at 3840 × 2160 or higher.
            </p>
            <button type="button" className="btn" onClick={() => void closePictureCheck()}>
              Close
            </button>
          </div>
        ) : null}
        <main className="main-stage tv-stage" ref={stageRef} inert>
          {body}
        </main>
      </div>
    </AlertsProvider>
  );
}
