import type {
  BoardAlert,
  Incident,
  IncidentSeverity,
  WeatherAlert,
} from "../types";

export function boardAlertId(sourceId: string, rawId: string): string {
  return `${sourceId}::${rawId}`;
}

export function weatherSeverityToBoard(
  severity: string,
  event?: string,
): BoardAlert["severity"] {
  const s = severity.trim().toLowerCase();
  if (s === "extreme" || s === "severe") return "alert";
  if (s === "moderate") return "warn";
  const ev = (event ?? "").toLowerCase();
  if (ev.includes("warning")) return "alert";
  if (ev.includes("watch")) return "warn";
  return "info";
}

function incidentSeverity(sev?: IncidentSeverity): BoardAlert["severity"] {
  if (sev === "alert") return "alert";
  if (sev === "warn") return "warn";
  return "info";
}

/** Map crime / Broadcastify / other incident rows into the shared alerts feed. */
export function incidentsToBoardAlerts(args: {
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  incidents: Incident[];
  /**
   * When set, only these severities are published.
   * Default: warn + alert, plus any row that carries audio (media reachable from the pane).
   */
  severities?: IncidentSeverity[];
  /** Include info-severity rows that have audio/transcript media (default true). */
  includeMediaInfo?: boolean;
}): BoardAlert[] {
  const allow = new Set(args.severities ?? (["warn", "alert"] as IncidentSeverity[]));
  const includeMediaInfo = args.includeMediaInfo !== false;
  return args.incidents
    .filter((item) => {
      const sev = item.severity ?? "info";
      if (allow.has(sev)) return true;
      return includeMediaInfo && Boolean(item.audioUrl);
    })
    .map((item) => ({
      id: boardAlertId(args.sourceId, item.id),
      sourceId: args.sourceId,
      sourceType: args.sourceType,
      sourceLabel: args.sourceLabel,
      title: item.title,
      summary: item.address ?? item.category ?? item.description,
      body: item.description,
      severity: incidentSeverity(item.severity),
      category: item.category ?? item.severity,
      area: item.address,
      address: item.address,
      occurredAt: item.occurredAt,
      detailUrl: item.detailUrl,
      audioUrl: item.audioUrl,
    }));
}

/** Map NWS alerts from a weather source payload into the shared feed. */
export function weatherAlertsToBoardAlerts(args: {
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  alerts: WeatherAlert[];
}): BoardAlert[] {
  return args.alerts.map((item) => ({
    id: boardAlertId(args.sourceId, item.id),
    sourceId: args.sourceId,
    sourceType: args.sourceType,
    sourceLabel: args.sourceLabel,
    title: item.headline?.trim() || item.event,
    summary: item.area ?? item.sender,
    body: [item.headline, item.description].filter(Boolean).join("\n\n") || undefined,
    severity: weatherSeverityToBoard(item.severity, item.event),
    category: item.event,
    area: item.area,
    occurredAt: item.onset ?? item.expires,
    endsAt: item.ends ?? item.expires,
    detailUrl: item.detailUrl,
  }));
}
