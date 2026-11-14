import type { AppState, LayoutSettings, SyncResult } from "../types";
import {
  authorizedAuth,
  errorMessage,
  sessionSecretValues,
  storedUserId,
  withAuth,
} from "./auth";

const CURSOR_KEY = "command-center.settings-sync.v1";
const MAX_DOCUMENT_BYTES = 512 * 1024;
const RESTORED_MESSAGE =
  "Restored your boards and sources from this account. API keys stay on this computer.";

/** Keep this list aligned with `SECRET_KEYS` in src-tauri/src/sync.rs. */
const SECRET_KEYS = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "apptoken",
  "app_token",
  "refreshtoken",
  "refresh_token",
  "accesstoken",
  "access_token",
  "authorization",
  "clientsecret",
  "client_secret",
]);

type BoardDocument = {
  version: number;
  activeBoardId: string;
  layout: LayoutSettings;
  boards: AppState["boards"];
  sources: AppState["sources"];
};

type Cursor = { userId: string; revision: number };
type Stored = { revision: number; document: BoardDocument };

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalized = normKey(key);
  const flat = normalized.replace(/_/g, "");
  for (const item of SECRET_KEYS) {
    if (item === normalized || item.replace(/_/g, "") === flat) return true;
  }
  return false;
}

function readCursor(): Cursor | null {
  try {
    const raw = localStorage.getItem(CURSOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (!parsed.userId || typeof parsed.revision !== "number") return null;
    return { userId: parsed.userId, revision: parsed.revision };
  } catch {
    return null;
  }
}

function writeCursor(cursor: Cursor | null): void {
  if (!cursor) {
    localStorage.removeItem(CURSOR_KEY);
    return;
  }
  localStorage.setItem(CURSOR_KEY, JSON.stringify(cursor));
}

export function hasLocalContent(state: AppState): boolean {
  const sources = state.sources ?? {};
  if (Object.keys(sources).length > 0) return true;
  if (state.boards.length !== 1) return true;
  const board = state.boards[0];
  if (!board) return false;
  if (board.panels.length > 0 || board.id !== "home" || board.title !== "Home") return true;
  if (state.activeBoardId !== "home") return true;
  const layout = state.layout;
  return layout.cols !== 48 || layout.rowHeight !== 12 || layout.margin[0] !== 4 || layout.margin[1] !== 4;
}

function scrubValue(
  value: unknown,
  secretNames: string[],
  secretValues: string[],
): unknown | undefined {
  if (typeof value === "string") {
    if (secretValues.some((secret) => secret.length > 0 && secret === value)) return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => scrubValue(item, secretNames, secretValues))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return scrubRecord(value as Record<string, unknown>, secretNames, secretValues);
  }
  return value;
}

function scrubRecord(
  record: Record<string, unknown>,
  secretNames: string[],
  secretValues: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (secretNames.some((name) => name.toLowerCase() === key.toLowerCase()) || isSecretKey(key)) {
      continue;
    }
    const cleaned = scrubValue(value, secretNames, secretValues);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function stripSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "secrets" && isSecretKey(key)) continue;
      out[key] = key === "secrets" ? child : stripSecretKeys(child);
    }
    return out;
  }
  return value;
}

function redact(value: unknown, secret: string, secretNames: Set<string>): unknown {
  if (typeof value === "string") {
    if (secretNames.has(value)) return value;
    return value.includes(secret) ? value.split(secret).join("") : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret, secretNames));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "secrets" ? child : redact(child, secret, secretNames);
    }
    return out;
  }
  return value;
}

export function documentFromState(state: AppState, secretValues: Record<string, string>): BoardDocument {
  const names = new Set<string>();
  const sources: AppState["sources"] = {};
  const values = Object.values(secretValues).filter((value) => value.length > 0);
  for (const [id, source] of Object.entries(state.sources ?? {})) {
    for (const name of source.secrets ?? []) names.add(name);
    sources[id] = {
      ...source,
      params: scrubRecord(source.params ?? {}, source.secrets ?? [], values),
    };
  }
  let document: BoardDocument = stripSecretKeys({
    version: state.version,
    activeBoardId: state.activeBoardId,
    layout: state.layout,
    boards: state.boards,
    sources,
  }) as BoardDocument;
  for (const secret of values) {
    if (secret.length >= 8) document = redact(document, secret, names) as BoardDocument;
  }
  return document;
}

function applyDocument(state: AppState, document: BoardDocument): AppState {
  const boards = document.boards?.length ? document.boards : state.boards;
  const active = boards.some((board) => board.id === document.activeBoardId)
    ? document.activeBoardId
    : boards[0]?.id ?? state.activeBoardId;
  return {
    ...state,
    version: document.version ?? state.version,
    layout: document.layout ?? state.layout,
    boards,
    activeBoardId: active,
    sources: document.sources ?? {},
    editMode: state.editMode,
    auth: state.auth,
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function asStored(body: unknown): Stored | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { revision?: unknown; document?: BoardDocument };
  if (typeof value.revision !== "number" || !value.document || typeof value.document !== "object") {
    return null;
  }
  return { revision: value.revision, document: value.document };
}

async function secretMap(state: AppState): Promise<Record<string, string>> {
  const { browserSecretValues } = await import("./api");
  const stored = browserSecretValues();
  const values: Record<string, string> = { ...sessionSecretValues() };
  for (const source of Object.values(state.sources ?? {})) {
    for (const name of source.secrets ?? []) {
      const value = stored[name];
      if (value) values[name] = value;
    }
  }
  return values;
}

async function putDocument(
  document: BoardDocument,
  revision: number | null,
): Promise<
  | { kind: "saved" | "conflict"; stored: Stored; userId: string }
  | { kind: "missing" }
  | { kind: "signed-out" }
> {
  const raw = JSON.stringify(document);
  if (raw.length > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `Board setup is too large to sync (${raw.length} bytes; limit is ${MAX_DOCUMENT_BYTES}).`,
    );
  }
  const response = await authorizedAuth("PUT", "/settings", { revision, document });
  if (!response) return { kind: "signed-out" };
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 200 || response.status === 409) {
    const stored = asStored(response.body);
    if (!stored) throw new Error("auth-server returned a board this app could not read.");
    return {
      kind: response.status === 200 ? "saved" : "conflict",
      stored,
      userId: response.userId,
    };
  }
  if (response.status === 401) return { kind: "signed-out" };
  const code =
    response.body && typeof response.body === "object" && "error" in response.body
      ? String((response.body as { error?: unknown }).error ?? "bad_request")
      : "bad_request";
  throw new Error(`auth-server rejected the board setup (${code}).`);
}

async function reconcileBrowser(state: AppState): Promise<SyncResult> {
  const current = withAuth(state);
  if (!current.auth.enabled) {
    return { state: current, restored: false, published: false, message: null };
  }
  const response = await authorizedAuth("GET", "/settings");
  if (!response || response.status === 401) {
    return { state: current, restored: false, published: false, message: null };
  }
  const secrets = await secretMap(current);
  const local = documentFromState(current, secrets);
  if (response.status === 404) {
    if (!hasLocalContent(current)) {
      return { state: current, restored: false, published: false, message: null };
    }
    const put = await putDocument(local, null);
    if (put.kind === "saved") {
      writeCursor({ userId: response.userId, revision: put.stored.revision });
      return { state: current, restored: false, published: true, message: null };
    }
    if (put.kind === "conflict") {
      writeCursor({ userId: response.userId, revision: put.stored.revision });
      return {
        state: applyDocument(current, put.stored.document),
        restored: true,
        published: false,
        message: RESTORED_MESSAGE,
      };
    }
    return { state: current, restored: false, published: false, message: null };
  }
  if (response.status !== 200) {
    return { state: current, restored: false, published: false, message: null };
  }
  const stored = asStored(response.body);
  if (!stored) throw new Error("auth-server returned a board this app could not read.");
  const cursor = readCursor();
  const sameRevision =
    cursor !== null && cursor.userId === response.userId && cursor.revision === stored.revision;
  if (canonical(local) === canonical(stored.document)) {
    writeCursor({ userId: response.userId, revision: stored.revision });
    return { state: current, restored: false, published: false, message: null };
  }
  // This browser already had this revision and then edited. Upload that edit
  // instead of replacing it with the copy that failed to leave the machine.
  if (sameRevision) {
    const put = await putDocument(local, stored.revision);
    if (put.kind === "saved") {
      writeCursor({ userId: response.userId, revision: put.stored.revision });
      return { state: current, restored: false, published: true, message: null };
    }
    if (put.kind === "conflict") {
      writeCursor({ userId: response.userId, revision: put.stored.revision });
      return {
        state: applyDocument(current, put.stored.document),
        restored: true,
        published: false,
        message: RESTORED_MESSAGE,
      };
    }
    return { state: current, restored: false, published: false, message: null };
  }
  writeCursor({ userId: response.userId, revision: stored.revision });
  return {
    state: applyDocument(current, stored.document),
    restored: true,
    published: false,
    message: RESTORED_MESSAGE,
  };
}

async function publishBrowser(state: AppState): Promise<void> {
  const current = withAuth(state);
  if (!current.auth.enabled) return;
  const secrets = await secretMap(current);
  const document = documentFromState(current, secrets);
  const cursor = readCursor();
  const sameUser = cursor !== null && cursor.userId === storedUserId();
  const first = await putDocument(document, sameUser && cursor ? cursor.revision : null);
  if (first.kind === "saved") {
    writeCursor({ userId: first.userId, revision: first.stored.revision });
    return;
  }
  if (first.kind !== "conflict") return;
  const second = await putDocument(document, first.stored.revision);
  if (second.kind === "saved") {
    writeCursor({ userId: second.userId, revision: second.stored.revision });
  }
}

export function syncBoard(): Promise<SyncResult> {
  if (isTauri()) {
    return (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<SyncResult>("sync_board");
      return { ...result, state: withAuth(result.state) };
    })().catch(() => {
      throw new Error("Could not restore the board from this account.");
    });
  }
  return serialized(async () => {
    const { loadAppState, writeBrowserState } = await import("./api");
    const { state } = await loadAppState();
    try {
      const result = await reconcileBrowser(state);
      if (result.restored) writeBrowserState(result.state);
      return result;
    } catch (err) {
      const message = errorMessage(err);
      return {
        state: withAuth(state),
        restored: false,
        published: false,
        message: message.includes("unreachable") ? null : message,
      };
    }
  });
}

export function publishBoard(state: AppState): Promise<void> {
  if (isTauri() || !state.auth?.enabled) return Promise.resolve();
  return serialized(() => publishBrowser(state)).then(
    () => undefined,
    () => undefined,
  );
}
