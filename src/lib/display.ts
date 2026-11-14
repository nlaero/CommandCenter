/** Window size for this computer. Not part of the account board document. */

const DISPLAY_KEY = "command-center.display.v1";

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

export function defaultDisplayPrefs(): DisplayPrefs {
  return { mode: "auto", width: 1440, height: 900, label: "Window" };
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
    };
  } catch {
    return defaultDisplayPrefs();
  }
}

function writeDisplayPrefs(prefs: DisplayPrefs): void {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify(prefs));
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
