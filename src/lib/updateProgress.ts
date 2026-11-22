export type UpdateProgress = {
  product: string;
  phase: string;
  received: number;
  total: number | null;
};

export function updateProgressPercent(progress: UpdateProgress): number | null {
  if (!progress.total || progress.total <= 0) return null;
  const percent = Math.round((progress.received / progress.total) * 100);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, percent));
}

export function updateProgressLabel(progress: UpdateProgress): string {
  if (progress.phase === "closing") {
    return "Closing Command Center so setup can replace it.";
  }
  const percent = updateProgressPercent(progress);
  if (percent != null) return `Downloading ${percent}%`;
  if (!Number.isFinite(progress.received) || progress.received <= 0) return "Downloading…";
  return `Downloading ${formatBytes(progress.received)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}
