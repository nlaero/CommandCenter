import { AUTH_IN_APP } from "./authFeature";

/** Browser preview only. The desktop app reads its version from the package. */
const APP_VERSION = "0.1.2";

export type UpdateProduct = {
  id: string;
  name: string;
  repo: string;
  currentVersion: string | null;
  currentDetail: string;
  latestVersion: string | null;
  latestTag: string | null;
  prerelease: boolean;
  publishedAt: string | null;
  htmlUrl: string | null;
  notes: string | null;
  updateAvailable: boolean;
  canApply: boolean;
  applyLabel: string;
  assetName: string | null;
  message: string;
  error: string | null;
};

export type UpdateReport = {
  appVersion: string;
  checkedAt: string;
  products: UpdateProduct[];
};

export type ApplyResult = {
  product: string;
  message: string;
  path: string | null;
  startedInstaller: boolean;
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function previewRequested(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("updates") === "available";
}

function currentReport(): UpdateReport {
  return {
    appVersion: APP_VERSION,
    checkedAt: new Date().toISOString(),
    products: [
      {
        id: "command-center",
        name: "Command Center",
        repo: "nlaero/CommandCenter",
        currentVersion: APP_VERSION,
        currentDetail: "This copy of Command Center",
        latestVersion: null,
        latestTag: "v0.1.0-test.1",
        prerelease: false,
        publishedAt: "2026-11-14T01:24:18Z",
        htmlUrl: "https://github.com/nlaero/CommandCenter/releases/tag/v0.1.0-test.1",
        notes: null,
        updateAvailable: false,
        canApply: false,
        applyLabel: "",
        assetName: null,
        message:
          "Command Center 0.1.2 is current. The latest GitHub tag is prerelease v0.1.0-test.1, which is not a newer release.",
        error: null,
      },
      {
        id: "auth-server",
        name: "auth-server",
        repo: "nlaero/command-center-auth",
        currentVersion: null,
        currentDetail: "Not installed on this computer",
        latestVersion: null,
        latestTag: null,
        prerelease: false,
        publishedAt: null,
        htmlUrl: "https://github.com/nlaero/command-center-auth/releases",
        notes: null,
        updateAvailable: false,
        canApply: false,
        applyLabel: "",
        assetName: null,
        message: "No auth-server release is published yet.",
        error: null,
      },
    ],
  };
}

function availableReport(): UpdateReport {
  return {
    appVersion: APP_VERSION,
    checkedAt: new Date().toISOString(),
    products: [
      {
        id: "command-center",
        name: "Command Center",
        repo: "nlaero/CommandCenter",
        currentVersion: APP_VERSION,
        currentDetail: "This copy of Command Center",
        latestVersion: "0.2.0",
        latestTag: "v0.2.0",
        prerelease: false,
        publishedAt: "2026-11-14T12:00:00Z",
        htmlUrl: "https://github.com/nlaero/CommandCenter/releases/tag/v0.2.0",
        notes: "Windows installer for Command Center. The app opens on the board. Settings and caption fixes stay on this computer.",
        updateAvailable: true,
        canApply: true,
        applyLabel: "Download and install",
        assetName: "Command.Center_0.2.0_x64-setup.exe",
        message: "0.2.0 is available. This copy is 0.1.2.",
        error: null,
      },
      {
        id: "auth-server",
        name: "auth-server",
        repo: "nlaero/command-center-auth",
        currentVersion: "0.1.0",
        currentDetail: "Installed on this computer",
        latestVersion: "0.2.0",
        latestTag: "v0.2.0",
        prerelease: false,
        publishedAt: "2026-11-14T12:00:00Z",
        htmlUrl: "https://github.com/nlaero/command-center-auth/releases/tag/v0.2.0",
        notes: "auth-server 0.2.0. Stop the local server, replace the binary, and start it again.",
        updateAvailable: true,
        canApply: true,
        applyLabel: "Update server",
        assetName: "auth-server.exe",
        message: "0.2.0 is available. This computer is using 0.1.0.",
        error: null,
      },
    ],
  };
}

function visibleReport(report: UpdateReport): UpdateReport {
  if (AUTH_IN_APP) return report;
  return {
    ...report,
    products: report.products.filter((product) => product.id !== "auth-server"),
  };
}

export function updateSummary(report: UpdateReport | null): string | null {
  if (!report) return null;
  const due = visibleReport(report).products.filter((product) => product.updateAvailable);
  if (due.length === 0) return null;
  if (due.length >= 2) return "Updates are available for Command Center and auth-server.";
  const one = due[0];
  const version = one.latestVersion ? ` ${one.latestVersion}` : "";
  return `${one.name}${version} is available.`;
}

export async function checkForUpdates(force: boolean): Promise<UpdateReport> {
  if (!isTauri()) {
    return visibleReport(previewRequested() ? availableReport() : currentReport());
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return visibleReport(await invoke<UpdateReport>("check_updates", { force }));
}

export async function applyUpdate(product: string): Promise<ApplyResult> {
  if (!isTauri()) {
    const name = product === "auth-server" ? "auth-server" : "Command Center";
    return {
      product,
      message: `${name} would download the GitHub release and install it in the desktop app. This browser preview does not download it.`,
      path: null,
      startedInstaller: false,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ApplyResult>("apply_update", { product });
}

export async function openRelease(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export function tauriApp(): boolean {
  return isTauri();
}
