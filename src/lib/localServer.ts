import type { AppState } from "../types";
import { saveAuthSettings } from "./auth";

export type ServerRole = "device" | "shared";
export type ServerStartup = "service" | "login";

export type LocalServerStatus = {
  installed: boolean;
  running: boolean;
  role: ServerRole | null;
  storeSecrets: boolean;
  port: number;
  baseUrl: string | null;
  binaryFound: boolean;
  lanAddress: string | null;
  startup: ServerStartup | null;
  message: string | null;
};

export type LocalServerChange = {
  status: LocalServerStatus;
  state: AppState;
};

const MOCK_KEY = "command-center.local-server.v1";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

function emptyStatus(): LocalServerStatus {
  return {
    installed: false,
    running: false,
    role: null,
    storeSecrets: false,
    port: 8080,
    baseUrl: null,
    binaryFound: true,
    lanAddress: null,
    startup: null,
    message: null,
  };
}

function readMock(): LocalServerStatus {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    return raw ? { ...emptyStatus(), ...(JSON.parse(raw) as LocalServerStatus) } : emptyStatus();
  } catch {
    return emptyStatus();
  }
}

function writeMock(status: LocalServerStatus): void {
  localStorage.setItem(MOCK_KEY, JSON.stringify(status));
}

export function localServerStatus(): Promise<LocalServerStatus> {
  if (isTauri()) return invoke<LocalServerStatus>("local_server_status");
  return Promise.resolve(readMock());
}

export async function installLocalServer(input: {
  role: ServerRole;
  storeSecrets: boolean;
  port: number;
  startup: ServerStartup;
  adminUsername: string;
  adminPassword: string;
}): Promise<LocalServerChange> {
  if (input.role === "shared" && input.storeSecrets) {
    throw new Error(
      "A server for other devices does not store passwords or API keys. Those stay on each computer.",
    );
  }
  const adminUsername = input.adminUsername.trim();
  if (!adminUsername || input.adminPassword.length < 8) {
    throw new Error(
      "Create a server admin during install. This account is for the server and its settings, not a Command Center board login. Use at least 8 characters.",
    );
  }
  if (isTauri()) {
    return invoke<LocalServerChange>("local_server_install", {
      role: input.role,
      storeSecrets: input.storeSecrets && input.role === "device",
      port: input.port,
      startup: input.startup,
      adminUsername,
      adminPassword: input.adminPassword,
    });
  }
  const port = input.port || 8080;
  const baseUrl = `http://127.0.0.1:${port}`;
  const status: LocalServerStatus = {
    installed: true,
    running: true,
    role: input.role,
    storeSecrets: input.role === "device" && input.storeSecrets,
    port,
    baseUrl,
    binaryFound: true,
    lanAddress: input.role === "shared" ? `http://192.168.1.20:${port}` : null,
    startup: input.startup,
    message: null,
  };
  writeMock(status);
  const { loadAppState } = await import("./api");
  const { state } = await loadAppState();
  const next = await saveAuthSettings({
    ...state.auth,
    enabled: true,
    baseUrl,
    allowInsecureHttp: true,
  });
  return { status, state: next };
}

export async function openLocalServerAdmin(): Promise<void> {
  if (isTauri()) {
    await invoke("local_server_open_admin");
    return;
  }
  const status = readMock();
  if (!status.baseUrl) {
    throw new Error("No server is installed on this computer.");
  }
  window.open(`${status.baseUrl.replace(/\/$/, "")}/admin`, "_blank", "noopener");
}

export async function startLocalServer(): Promise<LocalServerStatus> {
  if (isTauri()) return invoke<LocalServerStatus>("local_server_start");
  const status = { ...readMock(), running: true, message: null };
  writeMock(status);
  return status;
}

export async function stopLocalServer(): Promise<LocalServerStatus> {
  if (isTauri()) return invoke<LocalServerStatus>("local_server_stop");
  const status = { ...readMock(), running: false };
  writeMock(status);
  return status;
}

export async function setLocalServerSecrets(storeSecrets: boolean): Promise<LocalServerChange> {
  if (isTauri()) {
    return invoke<LocalServerChange>("local_server_set_secrets", { storeSecrets });
  }
  const current = readMock();
  if (storeSecrets && current.role !== "device") {
    throw new Error(
      "A server for other devices does not store passwords or API keys. Those stay on each computer.",
    );
  }
  const status = { ...current, storeSecrets: storeSecrets && current.role === "device" };
  writeMock(status);
  const { loadAppState } = await import("./api");
  const { state } = await loadAppState();
  return { status, state };
}

export async function exportLocalServerBackup(): Promise<{ document: string; path: string }> {
  if (isTauri()) return invoke("local_server_export_backup");
  const status = readMock();
  if (!status.installed) {
    throw new Error("Install the server on this computer before exporting a backup.");
  }
  const stored = localStorage.getItem("command-center.local-server.backup");
  const document =
    stored ||
    JSON.stringify(
      {
        format: "command-center-auth-backup",
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        users: [],
        refreshTokens: [],
        settings: [],
        secrets: [],
      },
      null,
      2,
    );
  return { document, path: "command-center-auth-backup.json" };
}

export async function importLocalServerBackup(document: string): Promise<LocalServerStatus> {
  let parsed: { format?: string };
  try {
    parsed = JSON.parse(document) as { format?: string };
  } catch {
    throw new Error("That file is not a Command Center auth-server backup.");
  }
  if (parsed.format !== "command-center-auth-backup") {
    throw new Error("That file is not a Command Center auth-server backup.");
  }
  if (isTauri()) return invoke<LocalServerStatus>("local_server_import_backup", { document });
  const status = readMock();
  if (!status.installed) {
    throw new Error("Install the server on this computer before importing a backup.");
  }
  localStorage.setItem("command-center.local-server.backup", document);
  return status;
}
