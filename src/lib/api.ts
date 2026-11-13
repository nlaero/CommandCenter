import type {
  AppState,
  ConfigPaths,
  GridItem,
  LoadResult,
  Panel,
  SourceConfig,
  ValidationResult,
} from "../types";

const BROWSER_KEY = "command-center.app-state.v1";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

function defaultState(): AppState {
  return {
    version: 1,
    activeBoardId: "home",
    layout: { cols: 48, rowHeight: 12, margin: [4, 4] },
    boards: [{ id: "home", title: "Home", panels: [] }],
    sources: {},
    editMode: false,
  };
}

function defaultPaths(): ConfigPaths {
  return {
    root: "(browser localStorage)",
    configFile: "(browser localStorage)",
    layoutsDir: "(browser localStorage)",
    overrideActive: false,
    overrideSource: null,
  };
}

function readBrowser(): AppState {
  try {
    const raw = localStorage.getItem(BROWSER_KEY);
    if (!raw) return defaultState();
    return JSON.parse(raw) as AppState;
  } catch {
    return defaultState();
  }
}

function writeBrowser(state: AppState): void {
  localStorage.setItem(BROWSER_KEY, JSON.stringify(state));
}

export async function loadAppState(): Promise<LoadResult> {
  if (!isTauri()) {
    const existing = localStorage.getItem(BROWSER_KEY);
    const state = existing ? readBrowser() : defaultState();
    if (!existing) writeBrowser(state);
    return { state, paths: defaultPaths(), created: !existing };
  }
  return invoke<LoadResult>("load_app_state");
}

export async function getConfigPaths(): Promise<ConfigPaths> {
  if (!isTauri()) return defaultPaths();
  return invoke<ConfigPaths>("get_config_paths");
}

export async function saveAppState(state: AppState): Promise<ConfigPaths> {
  if (!isTauri()) {
    writeBrowser(state);
    return defaultPaths();
  }
  return invoke<ConfigPaths>("save_app_state", { state });
}

export async function saveBoardLayout(
  boardId: string,
  items: GridItem[],
): Promise<void> {
  if (!isTauri()) {
    const state = readBrowser();
    const board = state.boards.find((b) => b.id === boardId);
    if (board) {
      for (const item of items) {
        const panel = board.panels.find((p) => p.id === item.i);
        if (panel) panel.layout = item;
      }
      writeBrowser(state);
    }
    return;
  }
  await invoke("save_board_layout", { args: { boardId, items } });
}

export async function upsertSource(
  id: string,
  source: SourceConfig,
): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    state.sources[id] = source;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("upsert_source", { args: { id, source } });
}

export async function addPanelToBoard(
  boardId: string,
  panel: Panel,
): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    const board = state.boards.find((b) => b.id === boardId);
    if (!board) throw new Error(`board not found: ${boardId}`);
    if (!state.sources[panel.source] || state.sources[panel.source].draft) {
      throw new Error("source must be saved and valid before adding to board");
    }
    board.panels.push(panel);
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("add_panel_to_board", { args: { boardId, panel } });
}

export async function createBoard(title: string): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    const id = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `board-${Date.now()}`;
    if (state.boards.some((b) => b.id === id)) {
      throw new Error(`board id already exists: ${id}`);
    }
    state.boards.push({ id, title, panels: [] });
    state.activeBoardId = id;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("create_board", { title });
}

export async function setActiveBoard(boardId: string): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    if (!state.boards.some((b) => b.id === boardId)) {
      throw new Error(`board not found: ${boardId}`);
    }
    state.activeBoardId = boardId;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("set_active_board", { boardId });
}

export async function setEditMode(enabled: boolean): Promise<AppState> {
  if (!isTauri()) {
    const state = readBrowser();
    state.editMode = enabled;
    writeBrowser(state);
    return state;
  }
  return invoke<AppState>("set_edit_mode", { enabled });
}

export async function validateSourceFields(
  required: string[],
  params: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<ValidationResult> {
  if (!isTauri()) {
    const missing: string[] = [];
    for (const key of required) {
      if (key.startsWith("secret:")) {
        const name = key.slice("secret:".length);
        if (!secrets[name]?.trim()) missing.push(key);
      } else {
        const v = params[key];
        const empty =
          v === undefined ||
          v === null ||
          (typeof v === "number" && Number.isNaN(v)) ||
          String(v).trim() === "";
        if (empty) missing.push(key);
      }
    }
    return {
      ok: missing.length === 0,
      missing,
      message:
        missing.length === 0
          ? "ok"
          : `missing required fields: ${missing.join(", ")}`,
    };
  }
  return invoke<ValidationResult>("validate_source_fields", {
    required,
    params,
    secrets,
  });
}

export function newId(prefix: string): string {
  return `${prefix}.${crypto.randomUUID().slice(0, 8)}`;
}
