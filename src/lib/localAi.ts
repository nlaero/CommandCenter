const MOCK_KEY = "command-center.local-ai.v1";

export type LocalAiStatus = {
  installed: boolean;
  modelId: string | null;
  modelLabel: string | null;
  bytes: number | null;
  runtimeReady: boolean;
  path: string | null;
  message: string | null;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd);
}

function empty(): LocalAiStatus {
  return {
    installed: false,
    modelId: null,
    modelLabel: null,
    bytes: null,
    runtimeReady: false,
    path: null,
    message: null,
  };
}

function readMock(): LocalAiStatus {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    return raw ? { ...empty(), ...(JSON.parse(raw) as LocalAiStatus) } : empty();
  } catch {
    return empty();
  }
}

export function localAiStatus(): Promise<LocalAiStatus> {
  if (isTauri()) return invoke<LocalAiStatus>("local_ai_status");
  return Promise.resolve(readMock());
}

export async function installLocalAi(): Promise<LocalAiStatus> {
  if (isTauri()) return invoke<LocalAiStatus>("local_ai_install");
  const status: LocalAiStatus = {
    installed: true,
    modelId: "tiny.en",
    modelLabel: "Tiny English",
    bytes: 77_704_715,
    runtimeReady: true,
    path: null,
    message: null,
  };
  localStorage.setItem(MOCK_KEY, JSON.stringify(status));
  return status;
}

export async function removeLocalAi(): Promise<LocalAiStatus> {
  if (isTauri()) return invoke<LocalAiStatus>("local_ai_remove");
  localStorage.removeItem(MOCK_KEY);
  return empty();
}

export function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
