/** Television output. Setup stays on this computer. The TV shows the board only. */

const CAST_KEY = "command-center.cast.v1";
const CAST_EVENT = "command-center-cast";

export const TV_MIN_WIDTH = 3840;
export const TV_MIN_HEIGHT = 2160;

export type CastMethod = "airplay" | "mirror";

export type CastScreen = {
  id: string;
  name: string;
  /** Physical pixels. */
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  current: boolean;
  sharp: boolean;
  /** CSS pixels, for placing a browser window. The desktop app uses physical pixels. */
  frameWidth?: number;
  frameHeight?: number;
};

export type AirPlayReceiver = {
  id: string;
  name: string;
  host: string;
  port: number;
  model: string;
  modelLabel: string;
  features: string;
  video: boolean;
  screen: boolean;
  audioOnly: boolean;
  asksForPin: boolean;
  width?: number | null;
  height?: number | null;
  sharp?: boolean | null;
};

export type AirPlayScan = {
  receivers: AirPlayReceiver[];
  message: string;
};

export type CastSession = {
  method: CastMethod;
  targetId: string;
  targetName: string;
  width: number;
  height: number;
};

export type CastView = {
  tv: boolean;
  preview: boolean;
};

type DetailedScreen = {
  label: string;
  width: number;
  height: number;
  left: number;
  top: number;
  devicePixelRatio: number;
  isPrimary?: boolean;
};

type ScreenDetails = {
  screens: DetailedScreen[];
  currentScreen: DetailedScreen;
};

let browserScreensCache: CastScreen[] = [];
let browserTv: Window | null = null;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

export function errorText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof err === "string" && err.trim()) return err;
  return "Something went wrong with the television.";
}

export function readCastView(): CastView {
  if (typeof window === "undefined") return { tv: false, preview: false };
  const params = new URLSearchParams(window.location.search);
  return {
    tv: params.get("view") === "tv",
    preview: params.get("preview") === "1",
  };
}

export function isSharp(width: number, height: number): boolean {
  return width >= TV_MIN_WIDTH && height >= TV_MIN_HEIGHT;
}

/** Same rule as the desktop app: don't double-count a size that is already 4K. */
export function physicalPixels(
  cssWidth: number,
  cssHeight: number,
  scale: number,
): { width: number; height: number } {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 0;
  const height = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 0;
  if (width >= TV_MIN_WIDTH && height >= TV_MIN_HEIGHT) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  return {
    width: Math.round(width * safeScale),
    height: Math.round(height * safeScale),
  };
}

export function boardSpanRows(panels: { layout: { y: number; h: number } }[]): number {
  return panels.reduce((max, panel) => Math.max(max, panel.layout.y + panel.layout.h), 0);
}

/** Fills the television. Matches `tv_row_height` in the desktop app. */
export function tvRowHeight(base: number, rows: number, viewportHeight: number): number {
  const span = Math.max(1, Math.round(rows) || 1);
  const marginY = 4;
  const paddingY = 8;
  const chrome = paddingY * 2 + marginY * Math.max(0, span - 1);
  const available = Math.max(span, Math.round(viewportHeight) - chrome);
  const fitted = Math.max(8, Math.floor(available / span));
  const safeBase = Number.isFinite(base) && base > 0 ? Math.round(base) : 12;
  if (fitted >= safeBase) return Math.min(fitted, 160);
  return fitted;
}

export function mirrorDecision(screen: CastScreen | null): { ok: boolean; reason: string } {
  if (!screen) return { ok: false, reason: "Pick a television." };
  if (screen.current) {
    return {
      ok: false,
      reason: "This is the computer. Setup stays here. Pick the television.",
    };
  }
  if (!screen.sharp) {
    return {
      ok: false,
      reason: `${screen.width} × ${screen.height} is below 3840 × 2160. A 58-inch or larger television would look soft. Set that display to 4K and refresh.`,
    };
  }
  return {
    ok: true,
    reason: `${screen.name} · ${screen.width} × ${screen.height}. The board fills this screen, with no controls.`,
  };
}

export function airplayDecision(receiver: AirPlayReceiver | null): { ok: boolean; reason: string } {
  if (!receiver) return { ok: false, reason: "Pick an AirPlay receiver." };
  if (receiver.audioOnly) {
    return { ok: false, reason: "This receiver only does audio, so it can't show the board." };
  }
  if (receiver.sharp === false) {
    const label = receiver.modelLabel || receiver.name;
    const width = receiver.width ?? 0;
    const height = receiver.height ?? 0;
    return {
      ok: false,
      reason: `${label} only goes to ${width} × ${height}. That is soft on a 58-inch or larger television.`,
    };
  }
  const label = receiver.modelLabel || receiver.name;
  if (receiver.sharp === true) {
    return {
      ok: true,
      reason: `${label} can show 3840 × 2160. The board opens there when that receiver is a display on this computer.`,
    };
  }
  return {
    ok: true,
    reason: `${receiver.name} is an AirPlay receiver. The picture has to be 3840 × 2160 or higher, and the receiver has to be a display on this computer.`,
  };
}

function publish(session: CastSession | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CAST_EVENT, { detail: session }));
}

export function onCastSession(listener: (session: CastSession | null) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<CastSession | null>).detail ?? null;
    listener(detail);
  };
  window.addEventListener(CAST_EVENT, handler);
  return () => window.removeEventListener(CAST_EVENT, handler);
}

function readBrowserSession(): CastSession | null {
  if (browserTv?.closed) {
    browserTv = null;
    localStorage.removeItem(CAST_KEY);
    return null;
  }
  try {
    const raw = localStorage.getItem(CAST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CastSession>;
    if (parsed.method !== "airplay" && parsed.method !== "mirror") return null;
    if (!parsed.targetId || !parsed.targetName) return null;
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
      method: parsed.method,
      targetId: parsed.targetId,
      targetName: parsed.targetName,
      width,
      height,
    };
  } catch {
    return null;
  }
}

function writeBrowserSession(session: CastSession | null): void {
  if (!session) localStorage.removeItem(CAST_KEY);
  else localStorage.setItem(CAST_KEY, JSON.stringify(session));
  publish(session);
}

export async function readCastSession(): Promise<CastSession | null> {
  if (isTauri()) {
    const session = await invoke<CastSession | null>("cast_status");
    return session ?? null;
  }
  return readBrowserSession();
}

function sameDetailed(a: DetailedScreen, b: DetailedScreen): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function fromDetailed(screen: DetailedScreen, current: DetailedScreen): CastScreen {
  const scale = screen.devicePixelRatio || 1;
  const pixels = physicalPixels(screen.width, screen.height, scale);
  const name = screen.label?.trim() || "Display";
  return {
    id: `${name}|${pixels.width}|${pixels.height}|${screen.left}|${screen.top}`,
    name,
    width: pixels.width,
    height: pixels.height,
    scale,
    x: screen.left,
    y: screen.top,
    current: sameDetailed(screen, current),
    sharp: isSharp(pixels.width, pixels.height),
    frameWidth: Math.round(screen.width),
    frameHeight: Math.round(screen.height),
  };
}

async function browserScreens(): Promise<CastScreen[]> {
  const getter = (
    window as Window & { getScreenDetails?: () => Promise<ScreenDetails> }
  ).getScreenDetails;
  if (getter) {
    try {
      const details = await getter();
      if (details.screens?.length) {
        browserScreensCache = details.screens.map((screen) =>
          fromDetailed(screen, details.currentScreen),
        );
        return browserScreensCache;
      }
    } catch {
      // Permission or an unsupported browser. Fall back to this screen.
    }
  }
  const scale = window.devicePixelRatio || 1;
  const pixels = physicalPixels(window.screen.width, window.screen.height, scale);
  browserScreensCache = [
    {
      id: "this-screen",
      name: "This screen",
      width: pixels.width,
      height: pixels.height,
      scale,
      x: 0,
      y: 0,
      current: true,
      sharp: isSharp(pixels.width, pixels.height),
      frameWidth: window.screen.width,
      frameHeight: window.screen.height,
    },
  ];
  return browserScreensCache;
}

export async function listCastScreens(): Promise<CastScreen[]> {
  if (isTauri()) return invoke<CastScreen[]>("list_cast_screens");
  return browserScreens();
}

export async function scanAirPlay(): Promise<AirPlayScan> {
  if (isTauri()) return invoke<AirPlayScan>("scan_airplay");
  return {
    receivers: [],
    message:
      "AirPlay search runs in the desktop app on this computer. The television does not get a settings screen.",
  };
}

function browserMirror(screen: CastScreen): CastSession {
  const decision = mirrorDecision(screen);
  if (!decision.ok) throw new Error(decision.reason);
  const frameWidth = screen.frameWidth ?? Math.round(screen.width / (screen.scale || 1));
  const frameHeight = screen.frameHeight ?? Math.round(screen.height / (screen.scale || 1));
  const opened = window.open(
    `${window.location.pathname}?view=tv`,
    "command-center-tv",
    `popup=yes,left=${screen.x},top=${screen.y},width=${frameWidth},height=${frameHeight}`,
  );
  if (!opened) {
    throw new Error("The window for the television was blocked.");
  }
  browserTv = opened;
  const session: CastSession = {
    method: "mirror",
    targetId: screen.id,
    targetName: screen.name,
    width: screen.width,
    height: screen.height,
  };
  writeBrowserSession(session);
  return session;
}

export async function startCast(method: CastMethod, targetId: string): Promise<CastSession> {
  if (isTauri()) {
    const session = await invoke<CastSession>("cast_start", { method, targetId });
    publish(session);
    return session;
  }
  if (method === "airplay") {
    throw new Error(
      "AirPlay runs in the desktop app. It shows the board when that receiver is a display on this computer.",
    );
  }
  const screen = browserScreensCache.find((item) => item.id === targetId) ?? null;
  if (!screen) throw new Error("That screen is no longer listed. Refresh and pick it again.");
  return browserMirror(screen);
}

export async function stopCast(): Promise<void> {
  if (isTauri()) {
    await invoke("cast_stop");
    publish(null);
    return;
  }
  if (browserTv && !browserTv.closed) browserTv.close();
  browserTv = null;
  writeBrowserSession(null);
}

export async function openPictureCheck(): Promise<void> {
  if (isTauri()) {
    await invoke("cast_preview");
    return;
  }
  const opened = window.open(
    `${window.location.pathname}?view=tv&preview=1`,
    "command-center-picture-check",
    "popup=yes,width=1280,height=720",
  );
  if (!opened) throw new Error("The window for the picture check was blocked.");
}

export async function closePictureCheck(): Promise<void> {
  if (isTauri()) {
    await invoke("cast_close_preview");
    return;
  }
  window.close();
}

export function castMethodLabel(method: CastMethod): string {
  return method === "airplay" ? "AirPlay" : "Screen mirroring";
}
