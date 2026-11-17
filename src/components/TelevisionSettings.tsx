import { useEffect, useState } from "react";
import {
  airplayDecision,
  castMethodLabel,
  errorText,
  listCastScreens,
  mirrorDecision,
  openPictureCheck,
  readCastSession,
  scanAirPlay,
  startCast,
  startTelevisionWall,
  stopCast,
  type AirPlayReceiver,
  type CastMethod,
  type CastScreen,
  type CastSession,
} from "../lib/cast";
import { televisionWallDecision } from "../lib/span";

type Props = {
  onMessage: (text: string, kind: "ok" | "error") => void;
};

export function TelevisionSettings({ onMessage }: Props) {
  const [method, setMethod] = useState<CastMethod>("mirror");
  const [screens, setScreens] = useState<CastScreen[]>([]);
  const [receivers, setReceivers] = useState<AirPlayReceiver[]>([]);
  const [scanNote, setScanNote] = useState("");
  const [screenIds, setScreenIds] = useState<string[] | null>(null);
  const [receiverId, setReceiverId] = useState<string | null>(null);
  const [session, setSession] = useState<CastSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  async function refreshScreens() {
    const next = await listCastScreens();
    setScreens(next);
    setScreenIds((current) =>
      current === null ? null : current.filter((id) => next.some((screen) => screen.id === id)),
    );
  }

  async function refreshReceivers() {
    const scan = await scanAirPlay();
    setReceivers(scan.receivers);
    setScanNote(scan.message);
    setScanned(true);
    setReceiverId((current) =>
      current && scan.receivers.some((item) => item.id === current) ? current : null,
    );
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [listed, active] = await Promise.all([listCastScreens(), readCastSession()]);
        if (cancelled) return;
        setScreens(listed);
        setSession(active);
      } catch (err) {
        if (!cancelled) onMessage(errorText(err), "error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // The settings alert is owned by the parent. Report the first load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (method !== "airplay" || scanned) return;
    let cancelled = false;
    setBusy(true);
    void refreshReceivers()
      .catch((err) => {
        if (!cancelled) onMessage(errorText(err), "error");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      setBusy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, scanned]);

  const selectedScreens =
    screenIds === null
      ? screens.length === 1
        ? [screens[0]]
        : []
      : screens.filter((screen) => screenIds.includes(screen.id));
  const selectedScreen = selectedScreens.length === 1 ? selectedScreens[0] : null;
  const selectedReceiver =
    receivers.find((item) => item.id === receiverId) ??
    (receivers.length === 1 ? receivers[0] : null);
  const decision =
    method === "mirror"
      ? selectedScreens.length > 1
        ? televisionWallDecision(selectedScreens)
        : mirrorDecision(selectedScreen)
      : airplayDecision(selectedReceiver);
  const summary = session
    ? session.split && session.split.length > 1
      ? `On ${session.split.length} TVs · ${session.split.map((screen) => screen.name).join(" · ")}`
      : `On the TV · ${session.targetName} · ${session.width} × ${session.height} · ${castMethodLabel(session.method)}`
    : decision.reason;

  async function refresh() {
    setBusy(true);
    try {
      if (method === "airplay") await refreshReceivers();
      else await refreshScreens();
      setSession(await readCastSession());
    } catch (err) {
      onMessage(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleScreen(id: string) {
    setScreenIds((current) => {
      const base = current ?? (screens.length === 1 ? screens.map((screen) => screen.id) : []);
      if (base.includes(id)) return base.filter((item) => item !== id);
      return [...base, id].slice(0, 8);
    });
  }

  async function show() {
    if (method === "mirror" && selectedScreens.length > 1) {
      if (!decision.ok) {
        onMessage(decision.reason, "error");
        return;
      }
      setBusy(true);
      try {
        const next = await startTelevisionWall(selectedScreens);
        setSession(next);
        onMessage(
          `The board splits across ${selectedScreens.length} televisions. Setup stays on this computer.`,
          "ok",
        );
      } catch (err) {
        onMessage(errorText(err), "error");
      } finally {
        setBusy(false);
      }
      return;
    }
    const targetId = method === "mirror" ? selectedScreen?.id : selectedReceiver?.id;
    if (!targetId || !decision.ok) {
      onMessage(decision.reason, "error");
      return;
    }
    setBusy(true);
    try {
      const next = await startCast(method, targetId);
      setSession(next);
      onMessage(
        `Showing the board on ${next.targetName} at ${next.width} × ${next.height}. The television has no controls.`,
        "ok",
      );
    } catch (err) {
      onMessage(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await stopCast();
      setSession(null);
      onMessage("The television is clear.", "ok");
    } catch (err) {
      onMessage(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function checkPicture() {
    setBusy(true);
    try {
      await openPictureCheck();
      onMessage(
        "Opened a picture check on this computer. That window is not the television.",
        "ok",
      );
    } catch (err) {
      onMessage(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="section-label">Television</p>
      <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
        The television shows the board and nothing else. You set it up on this computer. One
        television shows the whole board. More than one splits it across them. A 58-inch or
        larger set stays sharp at 3840 × 2160 or higher, so a smaller picture is refused.
      </p>
      <p className="display-current">{summary}</p>

      <div className="source-list">
        <button
          type="button"
          className={`source-row display-preset${method === "airplay" ? " is-checked" : ""}`}
          onClick={() => setMethod("airplay")}
        >
          <div>
            <h3>
              AirPlay
              <span className="badge">receivers</span>
            </h3>
            <p>Apple TV and other AirPlay receivers on this network. Nothing is set up on the TV.</p>
          </div>
        </button>
        <button
          type="button"
          className={`source-row display-preset${method === "mirror" ? " is-checked" : ""}`}
          onClick={() => setMethod("mirror")}
        >
          <div>
            <h3>
              Screen mirroring
              <span className="badge">displays</span>
            </h3>
            <p>
              A television this computer is already using as a display, such as HDMI. Pick more
              than one to split the board.
            </p>
          </div>
        </button>
      </div>

      {method === "mirror" ? (
        <>
          <p className="section-label">Screens</p>
          {screens.length === 0 ? (
            <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
              No screens reported yet.
            </p>
          ) : (
            <div className="source-list">
              {screens.map((screen) => {
                const active = selectedScreens.some((item) => item.id === screen.id);
                const badge = screen.current ? "this computer" : screen.sharp ? "4K" : "below 4K";
                return (
                  <button
                    key={screen.id}
                    type="button"
                    aria-pressed={active}
                    className={`source-row display-preset${active ? " is-checked" : ""}`}
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
                          ? ". Setup stays on this screen."
                          : screen.sharp
                            ? ". Sharp on a 58-inch or larger television."
                            : ". Too small for a 58-inch or larger television until it is set to 4K."}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="section-label">AirPlay receivers</p>
          {scanNote ? (
            <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
              {scanNote}
            </p>
          ) : null}
          {receivers.length === 0 && !scanNote ? (
            <p style={{ margin: "0 0 12px", color: "var(--cc-text-muted)", fontSize: "0.85rem" }}>
              {busy ? "Looking for receivers…" : "No AirPlay receivers yet."}
            </p>
          ) : null}
          <div className="source-list">
            {receivers.map((receiver) => {
              const active = receiver.id === selectedReceiver?.id;
              const badge = receiver.audioOnly
                ? "audio"
                : receiver.sharp === false
                  ? "below 4K"
                  : receiver.sharp
                    ? "4K"
                    : "AirPlay";
              const picture =
                receiver.width && receiver.height
                  ? `${receiver.width} × ${receiver.height}`
                  : "Picture size comes from the display it is connected to";
              return (
                <button
                  key={receiver.id}
                  type="button"
                  className={`source-row display-preset${active ? " is-checked" : ""}`}
                  onClick={() => setReceiverId(receiver.id)}
                >
                  <div>
                    <h3>
                      {receiver.name}
                      <span className="badge">{badge}</span>
                    </h3>
                    <p>
                      {receiver.modelLabel ? `${receiver.modelLabel}. ` : ""}
                      {picture}
                      {receiver.host ? ` · ${receiver.host}` : ""}
                      {receiver.asksForPin
                        ? ". If the television shows a code, enter it in the system AirPlay prompt on this computer, then show the board."
                        : ""}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Working…" : "Refresh"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !decision.ok}
          onClick={() => void show()}
        >
          Show the board
        </button>
        <button type="button" className="btn" disabled={busy || !session} onClick={() => void stop()}>
          Stop
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void checkPicture()}>
          Check the picture
        </button>
      </div>
      <p style={{ margin: "8px 0 0", color: "var(--cc-text-muted)", fontSize: "0.8rem" }}>
        Check the picture opens on this computer so you can see the board the television will
        show. The television itself has no settings and no controls.
      </p>
    </>
  );
}
