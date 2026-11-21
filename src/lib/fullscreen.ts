/** Data-only full screen. Escape returns to the window that was open before. */

import { useEffect, useRef, useState } from "react";

const EVENT = "data-fullscreen";

type KeyModifiers = {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export function fullscreenKeyAction(
  key: string,
  active: boolean,
  modifiers: KeyModifiers = { alt: false, ctrl: false, meta: false, shift: false },
): "enter" | "exit" | null {
  if (modifiers.alt || modifiers.ctrl || modifiers.meta || modifiers.shift) return null;
  if (key === "Escape") return active ? "exit" : null;
  if (key === "F11") return active ? "exit" : "enter";
  return null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function applyFullscreenClass(on: boolean): void {
  document.documentElement.classList.toggle("cc-fullscreen", on);
}

export async function readDataFullscreen(): Promise<boolean> {
  if (!isTauri()) {
    return document.documentElement.classList.contains("cc-fullscreen");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("data_fullscreen_state");
}

export async function setDataFullscreen(on: boolean): Promise<void> {
  if (!isTauri()) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_data_fullscreen", { on });
}

/** Hide the toolbar and show only the board. F11 enters. Escape leaves. */
export function useDataFullscreen(onEnter?: () => void): {
  active: boolean;
  enterFullscreen: () => void;
} {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    let cancelled = false;
    let unlisten = () => {};
    const apply = (on: boolean) => {
      activeRef.current = on;
      setActive(on);
      applyFullscreenClass(on);
    };
    const onDom = (event: Event) => {
      apply((event as CustomEvent<boolean>).detail === true);
    };
    window.addEventListener(EVENT, onDom);
    void (async () => {
      try {
        const current = await readDataFullscreen();
        if (!cancelled) apply(current);
      } catch {
        // The board still works if the desktop command is unavailable.
      }
      if (!isTauri() || cancelled) return;
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<boolean>(EVENT, (event) => {
        apply(event.payload === true);
      });
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
    })();
    return () => {
      cancelled = true;
      unlisten();
      window.removeEventListener(EVENT, onDom);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const action = fullscreenKeyAction(event.key, activeRef.current, {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "enter") onEnterRef.current?.();
      void setDataFullscreen(action === "enter").catch(() => undefined);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return {
    active,
    enterFullscreen: () => {
      onEnterRef.current?.();
      void setDataFullscreen(true).catch(() => undefined);
    },
  };
}
