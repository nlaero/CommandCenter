/** Window size and board density for this computer. Not part of the account board document. */

import { useEffect, useState } from "react";
import type { LayoutSettings } from "../types";

const DISPLAY_KEY = "command-center.display.v1";
const DISPLAY_EVENT = "command-center.display";

/** Grid scale. 1 is today's cell size. Lower fits more sources. Higher keeps panels larger. */
export const BOARD_DENSITY_MIN = 0.45;
export const BOARD_DENSITY_MAX = 1.5;

export type BoardDensityId = "larger" | "standard" | "compact" | "dense";

export type BoardDensity = {
  id: BoardDensityId | "custom";
  label: string;
  detail: string;
  scale: number;
};

export const BOARD_DENSITIES: BoardDensity[] = [
  {
    id: "larger",
    label: "Larger",
    detail: "Bigger panels that stay easy to read",
    scale: 1.35,
  },
  {
    id: "standard",
    label: "Standard",
    detail: "Current size, about three sources",
    scale: 1,
  },
  {
    id: "compact",
    label: "Compact",
    detail: "More sources in the same window",
    scale: 0.72,
  },
  {
    id: "dense",
    label: "Dense",
    detail: "Smallest panels, including on a 4K television",
    scale: 0.5,
  },
];

export const DISPLAY_MIN_WIDTH = 960;
export const DISPLAY_MIN_HEIGHT = 640;
export const DISPLAY_MAX_WIDTH = 7680;
export const DISPLAY_MAX_HEIGHT = 4320;

export type DisplayMode = "auto" | "fixed";

export type DisplayPrefs = {
  /** `auto` leaves the window alone. `fixed` applies width and height. */
  mode: DisplayMode;
  width: number;
  height: number;
  /** Preset name, "Custom", "This screen", or "Window". */
  label: string;
  /** Multiplier on the board grid. Saved on this computer, shared with the television. */
  density: number;
  /**
   * Screens the board is split across. Empty means this window only.
   * Saved on this computer, not on the account. The computer keeps setup.
   */
  screens: string[];
};

export type DisplayPreset = {
  id: string;
  label: string;
  detail: string;
  width: number;
  height: number;
};

export const DISPLAY_PRESETS: DisplayPreset[] = [
  { id: "1280x720", label: "1280 × 720", detail: "HD / small laptop", width: 1280, height: 720 },
  { id: "1366x768", label: "1366 × 768", detail: "Common laptop", width: 1366, height: 768 },
  { id: "1600x900", label: "1600 × 900", detail: "HD+", width: 1600, height: 900 },
  { id: "1920x1080", label: "1920 × 1080", detail: "Full HD", width: 1920, height: 1080 },
  { id: "2560x1440", label: "2560 × 1440", detail: "QHD", width: 2560, height: 1440 },
  { id: "3840x2160", label: "3840 × 2160", detail: "4K", width: 3840, height: 2160 },
];

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function clampDisplaySize(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? Math.round(width) : 1440;
  const h = Number.isFinite(height) ? Math.round(height) : 900;
  return {
    width: Math.min(DISPLAY_MAX_WIDTH, Math.max(DISPLAY_MIN_WIDTH, w)),
    height: Math.min(DISPLAY_MAX_HEIGHT, Math.max(DISPLAY_MIN_HEIGHT, h)),
  };
}

export function clampBoardDensity(value: unknown): number {
  if (typeof value === "string") {
    const preset = BOARD_DENSITIES.find((item) => item.id === value);
    if (preset) return preset.scale;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  const clamped = Math.min(BOARD_DENSITY_MAX, Math.max(BOARD_DENSITY_MIN, n));
  return Math.round(clamped * 100) / 100;
}

export function boardDensityPreset(density: number): BoardDensity {
  const scale = clampBoardDensity(density);
  return (
    BOARD_DENSITIES.find((item) => item.scale === scale) ?? {
      id: "custom",
      label: "Custom",
      detail: "A grid size between the presets",
      scale,
    }
  );
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Shrink or grow the board grid for this computer.
 * Cell size changes. Saved panel columns and rows stay put, so a denser
 * grid fits more sources in the same window and a larger grid keeps each
 * panel tall enough to read.
 */
export function boardGridMetrics(
  layout: LayoutSettings,
  density: number,
): LayoutSettings & { padding: number; scale: number } {
  const scale = clampBoardDensity(density);
  const baseRow = Number.isFinite(layout.rowHeight) && layout.rowHeight > 0 ? layout.rowHeight : 12;
  const marginX = Number.isFinite(layout.margin?.[0]) ? layout.margin[0] : 4;
  const marginY = Number.isFinite(layout.margin?.[1]) ? layout.margin[1] : 4;
  return {
    cols: layout.cols > 0 ? layout.cols : 48,
    rowHeight: clampInt(baseRow * scale, 4, 48),
    margin: [clampInt(marginX * scale, 1, 16), clampInt(marginY * scale, 1, 16)],
    padding: clampInt(8 * scale, 2, 24),
    scale,
  };
}

/** Pixel height of `rows` grid rows, including the grid's own margin and padding. */
export function gridBlockHeight(rows: number, density: number, layout?: LayoutSettings): number {
  const metrics = boardGridMetrics(
    layout ?? { cols: 48, rowHeight: 12, margin: [4, 4] },
    density,
  );
  const span = Math.max(1, Math.round(rows) || 1);
  return span * metrics.rowHeight + Math.max(0, span - 1) * metrics.margin[1] + metrics.padding * 2;
}

/** How many stacked panels of `panelRows` fit in `viewport` pixels at this density. */
export function panelsThatFit(panelRows: number, viewport: number, density: number): number {
  const rowsEach = Math.max(1, Math.round(panelRows) || 1);
  let count = 0;
  while (gridBlockHeight(rowsEach * (count + 1), density) <= viewport) {
    count += 1;
    if (count > 100) break;
  }
  return count;
}

export const BOARD_SCREEN_LIMIT = 8;

export function normalizeScreenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= BOARD_SCREEN_LIMIT) break;
  }
  return out;
}

export function defaultDisplayPrefs(): DisplayPrefs {
  return { mode: "auto", width: 1440, height: 900, label: "Window", density: 1, screens: [] };
}

export function readDisplayPrefs(): DisplayPrefs {
  if (typeof localStorage === "undefined") return defaultDisplayPrefs();
  try {
    const raw = localStorage.getItem(DISPLAY_KEY);
    if (!raw) return defaultDisplayPrefs();
    const parsed = JSON.parse(raw) as Partial<DisplayPrefs>;
    const size = clampDisplaySize(Number(parsed.width), Number(parsed.height));
    const mode = parsed.mode === "fixed" ? "fixed" : "auto";
    return {
      mode,
      width: size.width,
      height: size.height,
      label: typeof parsed.label === "string" && parsed.label.trim() ? parsed.label : mode === "fixed" ? "Custom" : "Window",
      density: clampBoardDensity(parsed.density),
      screens: normalizeScreenIds(parsed.screens),
    };
  } catch {
    return defaultDisplayPrefs();
  }
}

function writeDisplayPrefs(prefs: DisplayPrefs): void {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify(prefs));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DISPLAY_EVENT));
  }
}

/** Same-window updates plus the storage event the television window receives. */
export function subscribeDisplayPrefs(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStore = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DISPLAY_KEY) return;
    listener();
  };
  window.addEventListener(DISPLAY_EVENT, listener);
  window.addEventListener("storage", onStore);
  return () => {
    window.removeEventListener(DISPLAY_EVENT, listener);
    window.removeEventListener("storage", onStore);
  };
}

export function useBoardDensity(): number {
  const [density, setDensity] = useState(() => readDisplayPrefs().density);
  useEffect(() => subscribeDisplayPrefs(() => setDensity(readDisplayPrefs().density)), []);
  return density;
}

export function useBoardScreens(): string[] {
  const [screens, setScreens] = useState(() => readDisplayPrefs().screens);
  useEffect(() => subscribeDisplayPrefs(() => setScreens(readDisplayPrefs().screens)), []);
  return screens;
}

/** Remember which screens the board uses. Does not resize the window. */
export function saveBoardScreens(screenIds: string[]): DisplayPrefs {
  const next: DisplayPrefs = { ...readDisplayPrefs(), screens: normalizeScreenIds(screenIds) };
  writeDisplayPrefs(next);
  return next;
}

function frameDisplay(width: number, height: number): void {
  document.documentElement.style.setProperty("--cc-frame-w", `${width}px`);
  document.documentElement.style.setProperty("--cc-frame-h", `${height}px`);
  document.body.classList.add("cc-display-framed");
}

function clearFrame(): void {
  document.documentElement.style.removeProperty("--cc-frame-w");
  document.documentElement.style.removeProperty("--cc-frame-h");
  document.body.classList.remove("cc-display-framed");
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/** Apply a size. In the desktop app this resizes the window. The browser mock frames the page. */
export async function applyDisplayPrefs(prefs: DisplayPrefs): Promise<DisplayPrefs> {
  const size = clampDisplaySize(prefs.width, prefs.height);
  const next: DisplayPrefs = {
    mode: prefs.mode === "fixed" ? "fixed" : "auto",
    width: size.width,
    height: size.height,
    label: prefs.label?.trim() || (prefs.mode === "fixed" ? "Custom" : "Window"),
    density: clampBoardDensity(prefs.density),
    screens: normalizeScreenIds(prefs.screens),
  };
  if (typeof document === "undefined") {
    writeDisplayPrefs(next);
    return next;
  }
  if (next.mode === "auto") {
    clearFrame();
    writeDisplayPrefs(next);
    return next;
  }
  if (isTauri()) {
    clearFrame();
    await invoke("set_display_size", { width: next.width, height: next.height });
  } else {
    frameDisplay(next.width, next.height);
  }
  writeDisplayPrefs(next);
  return next;
}

export async function readWorkArea(): Promise<{ width: number; height: number } | null> {
  if (isTauri()) {
    const area = await invoke<{ width: number; height: number }>("display_work_area");
    return clampDisplaySize(area.width, area.height);
  }
  if (typeof screen === "undefined") return null;
  return clampDisplaySize(screen.availWidth, screen.availHeight);
}
