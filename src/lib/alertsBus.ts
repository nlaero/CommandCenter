import type { SourceAlert } from "../types";

/**
 * In-process hook for the shared alerts pane.
 *
 * The pane is not on this branch. When it lands, subscribe here — do not
 * scrape panel DOM. USGS publishes notable quakes, tsunami flags, landslides,
 * and volcanic eruptions after each poll. The same rows are on
 * `SourcePayload.alerts` from `fetch_source_payload` (Rust: `sources::alerts::SourceAlert`).
 *
 * - `publishSourceAlerts(sourceId, alerts)` replaces that source's rows
 *   (pass `[]` on unmount).
 * - `subscribeAlerts(listener)` fires immediately with the merged list,
 *   newest first, and returns an unsubscribe function.
 * - `getSourceAlerts()` is the current snapshot.
 */

type Listener = (alerts: SourceAlert[]) => void;

const bySource = new Map<string, SourceAlert[]>();
const listeners = new Set<Listener>();

function merged(): SourceAlert[] {
  const all = [...bySource.values()].flat();
  all.sort((a, b) => String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? "")));
  return all;
}

function emit(): void {
  const next = merged();
  for (const listener of listeners) listener(next);
}

export function publishSourceAlerts(sourceId: string, alerts: SourceAlert[]): void {
  if (alerts.length === 0) bySource.delete(sourceId);
  else bySource.set(sourceId, alerts);
  emit();
}

export function getSourceAlerts(): SourceAlert[] {
  return merged();
}

export function subscribeAlerts(listener: Listener): () => void {
  listeners.add(listener);
  listener(merged());
  return () => {
    listeners.delete(listener);
  };
}
