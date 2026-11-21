import type { TrafficCamera } from "../types.ts";

/** How many PennDOT cameras one view can show at once. */
export const MAX_CAMERAS_ON_SCREEN = 8;

export function cameraCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_CAMERAS_ON_SCREEN, Math.max(1, Math.round(n)));
}

export function camerasRotate(value: unknown): boolean {
  return value === true;
}

export function cameraRotateSec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(3600, Math.max(5, Math.round(n)));
}

/** Cameras on screen at this step. Rotation advances one camera at a time. */
export function visibleCameras(
  cameras: TrafficCamera[],
  count: number,
  index: number,
  rotate: boolean,
): TrafficCamera[] {
  if (!cameras.length) return [];
  const shown = Math.min(cameraCount(count), cameras.length);
  if (!rotate || cameras.length <= shown) return cameras.slice(0, shown);
  const start = ((index % cameras.length) + cameras.length) % cameras.length;
  return Array.from({ length: shown }, (_, step) => cameras[(start + step) % cameras.length]);
}

export function cameraGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  return 4;
}
