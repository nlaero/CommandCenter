/** Television output. Setup stays on this computer. The TV shows the board only. */

import { clampBoardDensity, saveBoardScreens } from "./display.ts";
import { displayWallSummary, televisionWallDecision } from "./span.ts";

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

export type CastSplitTarget = {
  id: string;
  name: string;
  width: number;
  height: number;
};

export type CastSession = {
  method: CastMethod;
  targetId: string;
  targetName: string;
  width: number;
  height: number;
  /** Set when the board is divided across more than one television. */
  split?: CastSplitTarget[];
};

export type CastView = {
  tv: boolean;
  preview: boolean;
  /** A display-wall window. Setup stays on the computer. */
  span: boolean;
  screenId: string | null;
};

const DISPLAY_WALL_KEY = "command-center.wall.v1";
const TV_WALL_KEY = "command-center.tv-wall.v1";
const DISPLAY_WALL_EVENT = "command-center.wall";
const TV_WALL_EVENT = "command-center.tv-wall";

export type WallKind = "display" | "television";

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
const browserSpan = new Map<string, Window>();
const browserTvWall = new Map<string, Window>();

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
  if (typeof window === "undefined") {
    return { tv: false, preview: false, span: false, screenId: null };
  }
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const screen = params.get("screen");
  return {
    tv: view === "tv",
    preview: params.get("preview") === "1",
    span: view === "span",
    screenId: screen && screen.trim() ? screen : null,
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

/**
 * Row height for the television. Matches `tv_row_height_scaled` in the desktop app.
 * Density 1 fills the glass the way it always has. A denser setting caps that
 * stretch so a 4K screen can hold more sources without giant tiles. A larger
 * setting keeps the fill and raises the cap so panels stay easy to read.
 */
/** Chrome the television grid uses at this density. Standard and larger keep the original 4 / 8. */
export function tvGridChrome(density: number): { margin: number; padding: number } {
  const scale = clampBoardDensity(density);
  if (scale >= 1) return { margin: 4, padding: 8 };
  return {
    margin: Math.max(1, Math.round(4 * scale)),
    padding: Math.max(2, Math.round(8 * scale)),
  };
}

export function tvRowHeight(
  base: number,
  rows: number,
  viewportHeight: number,
  density = 1,
): number {
  const scale = clampBoardDensity(density);
  const span = Math.max(1, Math.round(rows) || 1);
  const safeBase = Number.isFinite(base) && base > 0 ? Math.round(base) : 12;
  const chrome = tvGridChrome(scale);
  const fitted = fittedRow(span, viewportHeight, chrome.margin, chrome.padding);
  if (scale >= 1) {
    const natural = Math.max(4, Math.round(safeBase * scale));
    const cap = Math.min(200, Math.max(160, Math.round(160 * scale)));
    if (fitted >= natural) return Math.min(fitted, cap);
    return fitted;
  }
  const natural = Math.max(4, Math.round(safeBase * scale));
  const distance = Math.min(2, Math.max(1, Math.round(viewportHeight) / 1080));
  const cap = Math.max(natural, Math.round(natural * distance));
  return Math.min(fitted, cap);
}

function fittedRow(span: number, viewportHeight: number, marginY: number, paddingY: number): number {
  const chrome = paddingY * 2 + marginY * Math.max(0, span - 1);
  const available = Math.max(span, Math.round(viewportHeight) - chrome);
  const floor = marginY === 4 && paddingY === 8 ? 8 : 4;
  return Math.max(floor, Math.floor(available / span));
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
  if (
    browserTvWall.size > 0 &&
    [...browserTvWall.values()].every((popup) => popup.closed)
  ) {
    browserTvWall.clear();
    localStorage.removeItem(CAST_KEY);
    writeWallCache("television", []);
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
    const split = parseSplit(parsed.split);
    return {
      method: parsed.method,
      targetId: parsed.targetId,
      targetName: parsed.targetName,
      width,
      height,
      ...(split.length > 1 ? { split } : {}),
    };
  } catch {
    return null;
  }
}

function parseSplit(value: unknown): CastSplitTarget[] {
  if (!Array.isArray(value)) return [];
  const out: CastSplitTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<CastSplitTarget>;
    if (typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name) continue;
    const width = Number(row.width);
    const height = Number(row.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
    out.push({ id: row.id, name: row.name, width, height });
  }
  return out;
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
    const session = await invoke<CastSession>("cast_start", {
      request: { method, targetId },
    });
    publish(session);
    writeWallCache("television", []);
    return session;
  }
  if (method === "airplay") {
    throw new Error(
      "AirPlay runs in the desktop app. It shows the board when that receiver is a display on this computer.",
    );
  }
  const screen = browserScreensCache.find((item) => item.id === targetId) ?? null;
  if (!screen) throw new Error("That screen is no longer listed. Refresh and pick it again.");
  closeBrowserTvWall();
  writeWallCache("television", []);
  return browserMirror(screen);
}

export async function stopCast(): Promise<void> {
  if (isTauri()) {
    await invoke("cast_stop");
    publish(null);
    writeWallCache("television", []);
    return;
  }
  if (browserTv && !browserTv.closed) browserTv.close();
  browserTv = null;
  closeBrowserTvWall();
  writeWallCache("television", []);
  writeBrowserSession(null);
}

/**
 * Split the board across the screens chosen in Display.
 * The computer keeps setup. Other screens show only their part, at their own size.
 */
export async function applyDisplayWall(screenIds: string[]): Promise<string> {
  const live = await listCastScreens();
  const unique: string[] = [];
  for (const id of screenIds) {
    const trimmed = id.trim();
    if (!trimmed || unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= 8) break;
  }
  saveBoardScreens(unique);
  const wanted = unique.flatMap((id) => {
    const screen = live.find((item) => item.id === id);
    return screen ? [screen] : [];
  });
  writeWallCache("display", wanted);
  const missing = unique.length - wanted.length;
  if (wanted.length < 2) {
    await hideSpanWindows();
    if (missing > 0) {
      return "A selected screen is not connected. The board stays in this window.";
    }
    return "The board stays in this window.";
  }
  await openSpanWindows(wanted.filter((screen) => !screen.current));
  const summary = displayWallSummary(wanted);
  if (missing > 0) return `${summary} One selected screen is not connected.`;
  return summary;
}

/** More than one television divides the board. Each one has to stay at 4K or higher. */
export async function startTelevisionWall(screens: CastScreen[]): Promise<CastSession> {
  const decision = televisionWallDecision(screens);
  if (!decision.ok) throw new Error(decision.reason);
  writeWallCache("television", screens);
  if (isTauri()) {
    const session = await invoke<CastSession>("cast_split", {
      args: { screenIds: screens.map((screen) => screen.id), requireSharp: true },
    });
    publish(session);
    return session;
  }
  if (browserTv && !browserTv.closed) browserTv.close();
  browserTv = null;
  closeBrowserTvWall();
  for (const screen of screens) {
    const opened = placePopup(
      screen,
      `${window.location.pathname}?view=tv&screen=${encodeURIComponent(screen.id)}`,
      popupName("command-center-tv", screen.id),
    );
    browserTvWall.set(screen.id, opened);
  }
  const session: CastSession = {
    method: "mirror",
    targetId: screens.map((screen) => screen.id).join("\n"),
    targetName: screens.map((screen) => screen.name).join(" · "),
    width: Math.max(...screens.map((screen) => screen.width)),
    height: Math.max(...screens.map((screen) => screen.height)),
    split: screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      width: screen.width,
      height: screen.height,
    })),
  };
  writeBrowserSession(session);
  return session;
}

export function readWallCache(kind: WallKind): CastScreen[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(wallKey(kind));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { screens?: CastScreen[] };
    if (!Array.isArray(parsed.screens)) return [];
    return parsed.screens.filter(isCastScreen);
  } catch {
    return [];
  }
}

export function subscribeWall(kind: WallKind, listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const key = wallKey(kind);
  const event = kind === "display" ? DISPLAY_WALL_EVENT : TV_WALL_EVENT;
  const onStore = (stored: StorageEvent) => {
    if (stored.key !== null && stored.key !== key) return;
    listener();
  };
  window.addEventListener(event, listener);
  window.addEventListener("storage", onStore);
  return () => {
    window.removeEventListener(event, listener);
    window.removeEventListener("storage", onStore);
  };
}

function writeWallCache(kind: WallKind, screens: CastScreen[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(wallKey(kind), JSON.stringify({ screens }));
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(kind === "display" ? DISPLAY_WALL_EVENT : TV_WALL_EVENT));
}

function wallKey(kind: WallKind): string {
  return kind === "display" ? DISPLAY_WALL_KEY : TV_WALL_KEY;
}

function isCastScreen(value: CastScreen): boolean {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      value.id &&
      Number.isFinite(value.width) &&
      Number.isFinite(value.height) &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y),
  );
}

async function openSpanWindows(screens: CastScreen[]): Promise<void> {
  const external = screens.filter((screen) => !screen.current).slice(0, 8);
  if (isTauri()) {
    if (external.length === 0) {
      await invoke("span_hide");
      return;
    }
    await invoke("span_show", {
      args: { screenIds: external.map((screen) => screen.id), requireSharp: false },
    });
    return;
  }
  for (const [id, popup] of browserSpan) {
    if (external.some((screen) => screen.id === id)) continue;
    if (!popup.closed) popup.close();
    browserSpan.delete(id);
  }
  for (const screen of external) {
    const existing = browserSpan.get(screen.id);
    if (existing && !existing.closed) continue;
    const opened = placePopup(
      screen,
      `${window.location.pathname}?view=span&screen=${encodeURIComponent(screen.id)}`,
      popupName("command-center-span", screen.id),
    );
    browserSpan.set(screen.id, opened);
  }
}

async function hideSpanWindows(): Promise<void> {
  if (isTauri()) {
    await invoke("span_hide");
    return;
  }
  for (const popup of browserSpan.values()) {
    if (!popup.closed) popup.close();
  }
  browserSpan.clear();
}

function closeBrowserTvWall(): void {
  for (const popup of browserTvWall.values()) {
    if (!popup.closed) popup.close();
  }
  browserTvWall.clear();
}

function placePopup(screen: CastScreen, url: string, name: string): Window {
  const frameWidth = screen.frameWidth ?? Math.round(screen.width / (screen.scale || 1));
  const frameHeight = screen.frameHeight ?? Math.round(screen.height / (screen.scale || 1));
  const opened = window.open(
    url,
    name,
    `popup=yes,left=${Math.round(screen.x)},top=${Math.round(screen.y)},width=${frameWidth},height=${frameHeight}`,
  );
  if (!opened) throw new Error("The window for that screen was blocked.");
  return opened;
}

function popupName(prefix: string, id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return `${prefix}-${hash.toString(36)}`;
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
