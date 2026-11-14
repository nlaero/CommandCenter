import { authorizedAuth, errorMessage, storedUserId } from "./auth";
import { AUTH_IN_APP } from "./authFeature";

const KEY = "command-center.ai-memory.v1";
const MAX_CORRECTIONS = 400;
const MAX_PHRASE = 160;

export type Correction = {
  id: string;
  heard: string;
  says: string;
  count: number;
};

export type AiMemory = {
  version: 1;
  corrections: Correction[];
};

export type AiSyncResult = {
  memory: AiMemory;
  revision: number | null;
  server: string | null;
  published: boolean;
  restored: boolean;
  message: string | null;
};

type Cursor = {
  userId: string | null;
  revision: number | null;
  document: AiMemory;
};

type Remote = { revision: number; document: AiMemory };

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function emptyMemory(): AiMemory {
  return { version: 1, corrections: [] };
}

export function cleanPhrase(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function upsertCorrection(memory: AiMemory, heard: string, says: string): AiMemory {
  const from = cleanPhrase(heard);
  const to = cleanPhrase(says);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) {
    throw new Error("Enter what was heard and what it should say.");
  }
  if (from.length > MAX_PHRASE || to.length > MAX_PHRASE) {
    throw new Error("Keep each phrase under 160 characters.");
  }
  if (/[\u0000-\u001f]/.test(from + to) || from.toLowerCase().includes("data:") || to.toLowerCase().includes("data:")) {
    throw new Error("Caption fixes are text only. Audio stays on this computer.");
  }
  const key = from.toLowerCase();
  const existing = memory.corrections.find((item) => item.heard.toLowerCase() === key);
  const corrections = existing
    ? memory.corrections.map((item) =>
        item.heard.toLowerCase() === key
          ? { ...item, heard: from, says: to, count: item.count + 1 }
          : item,
      )
    : [...memory.corrections, { id: newId(), heard: from, says: to, count: 1 }];
  if (corrections.length > MAX_CORRECTIONS) {
    throw new Error("Too many caption fixes to store.");
  }
  return normalize({ version: 1, corrections });
}

export function removeCorrection(memory: AiMemory, id: string): AiMemory {
  return normalize({
    version: 1,
    corrections: memory.corrections.filter((item) => item.id !== id),
  });
}

export function mergeMemory(local: AiMemory, remote: AiMemory): AiMemory {
  const byHeard = new Map<string, Correction>();
  for (const item of remote.corrections) byHeard.set(item.heard.toLowerCase(), item);
  for (const item of local.corrections) {
    const key = item.heard.toLowerCase();
    const existing = byHeard.get(key);
    if (!existing || item.count > existing.count || (item.count === existing.count && item.says !== existing.says)) {
      byHeard.set(key, item);
    }
  }
  return normalize({ version: 1, corrections: [...byHeard.values()] });
}

export function applyCorrections(text: string, memory: AiMemory): string {
  const items = [...memory.corrections].sort((a, b) => b.heard.length - a.heard.length);
  const spans: { start: number; end: number; says: string }[] = [];
  for (const item of items) {
    const needle = item.heard.trim();
    if (!needle) continue;
    let start = 0;
    while (start < text.length) {
      const end = matchesAt(text, start, needle);
      if (end !== null) {
        const before = start === 0 || !isWord(text[start - 1] ?? "");
        const after = end >= text.length || !isWord(text[end] ?? "");
        const overlaps = spans.some((span) => start < span.end && end > span.start);
        if (before && after && !overlaps) spans.push({ start, end, says: item.says });
      }
      start += text.codePointAt(start)! > 0xffff ? 2 : 1;
    }
  }
  spans.sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of spans) {
    out = out.slice(0, span.start) + span.says + out.slice(span.end);
  }
  return out;
}

export function readLocalMemory(): AiMemory {
  const stored = readCursor();
  const userId = storedUserId();
  if (stored.userId && userId && stored.userId !== userId) return emptyMemory();
  return stored.document;
}

export async function syncAiMemory(): Promise<AiSyncResult> {
  if (!AUTH_IN_APP) {
    if (isTauri()) return invokeSync("sync_ai_memory");
    return result(readLocalMemory(), null, null, false, false, null);
  }
  if (isTauri()) return invokeSync("sync_ai_memory");
  return browserSync(null);
}

export async function saveAiMemory(memory: AiMemory): Promise<AiSyncResult> {
  const next = normalize(memory);
  if (!AUTH_IN_APP) {
    if (isTauri()) return invokeSync("save_ai_memory", { memory: next });
    writeCursor({ ...readCursor(), document: next });
    return result(next, null, null, false, false, null);
  }
  if (isTauri()) return invokeSync("save_ai_memory", { memory: next });
  writeCursor({ ...readCursor(), document: next });
  return browserSync(next);
}

async function invokeSync(command: string, args?: Record<string, unknown>): Promise<AiSyncResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AiSyncResult>(command, args);
}

async function browserSync(forced: AiMemory | null): Promise<AiSyncResult> {
  const { loadAppState } = await import("./api");
  const { state } = await loadAppState();
  const server = state.auth?.baseUrl?.trim() || null;
  let cursor = readCursor();
  const userId = storedUserId();
  if (cursor.userId && userId && cursor.userId !== userId) {
    cursor = { userId, revision: null, document: forced ?? emptyMemory() };
    writeCursor(cursor);
  }
  const local = forced ?? cursor.document;
  if (forced) writeCursor({ ...cursor, document: local });
  try {
    const response = await authorizedAuth("GET", "/ai/memory");
    if (!response) {
      return result(local, cursor.revision, server, false, false, null);
    }
    if (response.status === 404) {
      if (local.corrections.length === 0) {
        return result(local, null, server, false, false, null);
      }
      const created = await putMemory(local, null, response.userId, server);
      if (created.message === "conflict") {
        return finishRemote(
          local,
          { revision: created.revision ?? 0, document: created.memory },
          cursor,
          response.userId,
          server,
          true,
        );
      }
      return created;
    }
    if (response.status !== 200) {
      throw new Error("auth-server rejected the caption fixes.");
    }
    const remote = asRemote(response.body);
    if (!remote) throw new Error("auth-server returned caption fixes this app could not read.");
    return finishRemote(local, remote, cursor, response.userId, server, false);
  } catch (err) {
    const message = errorMessage(err);
    return result(local, cursor.revision, server, false, false, message.includes("unreachable") ? null : message);
  }
}

async function finishRemote(
  local: AiMemory,
  remote: Remote,
  cursor: Cursor,
  userId: string,
  server: string | null,
  retried: boolean,
): Promise<AiSyncResult> {
  if (same(local, remote.document)) {
    writeCursor({ userId, revision: remote.revision, document: remote.document });
    return result(remote.document, remote.revision, server, false, false, null);
  }
  const editedHere = cursor.userId === userId && cursor.revision === remote.revision;
  const next = editedHere ? local : mergeMemory(local, remote.document);
  if (same(next, remote.document) || retried) {
    writeCursor({ userId, revision: remote.revision, document: remote.document });
    return result(
      remote.document,
      remote.revision,
      server,
      false,
      true,
      "Restored caption fixes from this account.",
    );
  }
  const put = await putMemory(next, remote.revision, userId, server);
  if (put.message === "conflict" && put.memory) {
    return finishRemote(next, { revision: put.revision ?? remote.revision, document: put.memory }, cursor, userId, server, true);
  }
  return put;
}

async function putMemory(
  memory: AiMemory,
  revision: number | null,
  userId: string,
  server: string | null,
): Promise<AiSyncResult & { memory: AiMemory }> {
  const response = await authorizedAuth("PUT", "/ai/memory", { revision, document: memory });
  if (!response) return result(memory, revision, server, false, false, null);
  if (response.status === 404) {
    writeCursor({ userId, revision: null, document: memory });
    return result(
      memory,
      null,
      server,
      false,
      false,
      "This server does not keep caption fixes yet. Update it, then try again.",
    );
  }
  if (response.status === 409) {
    const remote = asRemote(response.body);
    if (!remote) throw new Error("auth-server reported a conflict without the current caption fixes.");
    return { ...result(remote.document, remote.revision, server, false, false, "conflict"), memory: remote.document };
  }
  if (response.status !== 200) throw new Error("auth-server rejected the caption fixes.");
  const saved = asRemote(response.body);
  if (!saved) throw new Error("auth-server returned caption fixes this app could not read.");
  writeCursor({ userId, revision: saved.revision, document: saved.document });
  return result(saved.document, saved.revision, server, true, false, null);
}

function result(
  memory: AiMemory,
  revision: number | null,
  server: string | null,
  published: boolean,
  restored: boolean,
  message: string | null,
): AiSyncResult {
  return { memory, revision, server, published, restored, message };
}

function asRemote(body: unknown): Remote | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { revision?: unknown; document?: AiMemory };
  if (typeof value.revision !== "number" || !value.document || !Array.isArray(value.document.corrections)) {
    return null;
  }
  return { revision: value.revision, document: normalize(value.document) };
}

function same(left: AiMemory, right: AiMemory): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function normalize(memory: AiMemory): AiMemory {
  const corrections = [...memory.corrections].sort((a, b) =>
    a.heard.toLowerCase().localeCompare(b.heard.toLowerCase()),
  );
  return { version: 1, corrections };
}

function readCursor(): Cursor {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { userId: null, revision: null, document: emptyMemory() };
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (!parsed.document || !Array.isArray(parsed.document.corrections)) {
      return { userId: null, revision: null, document: emptyMemory() };
    }
    return {
      userId: parsed.userId ?? null,
      revision: typeof parsed.revision === "number" ? parsed.revision : null,
      document: normalize(parsed.document),
    };
  } catch {
    return { userId: null, revision: null, document: emptyMemory() };
  }
}

function writeCursor(cursor: Cursor): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      userId: cursor.userId,
      revision: cursor.revision,
      document: normalize(cursor.document),
    }),
  );
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isWord(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function matchesAt(text: string, start: number, needle: string): number | null {
  let index = start;
  for (const expected of needle) {
    const actual = text.codePointAt(index);
    if (actual === undefined) return null;
    const ch = String.fromCodePoint(actual);
    if (ch.toLowerCase() !== expected.toLowerCase()) return null;
    index += ch.length;
  }
  return index;
}
