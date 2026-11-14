import type {
  BoardAlert,
  Incident,
  IncidentSeverity,
  QuakeEvent,
  TrafficEvent,
  WeatherAlert,
} from "../types.ts";

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
      transcript: item.transcript,
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

function quakeSummary(event: QuakeEvent): string {
  const parts: string[] = [];
  if (event.mag != null) parts.push(`M${event.mag.toFixed(1)}`);
  parts.push(event.tsunami ? "tsunami" : event.eventType);
  if (event.alert) parts.push(`PAGER ${event.alert}`);
  if (event.depthKm != null) parts.push(`${event.depthKm.toFixed(1)} km deep`);
  if (event.place) parts.push(event.place);
  return parts.join(" · ");
}

/** Road incidents and conditions that can change travel time. */
export function trafficEventsToBoardAlerts(args: {
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  events: TrafficEvent[];
}): BoardAlert[] {
  return args.events
    .filter((event) => event.affectsTravel && (event.severity === "warn" || event.severity === "alert"))
    .map((event) => {
      const summary = [event.road, event.direction, event.summary].filter(Boolean).join(" · ");
      return {
        id: boardAlertId(args.sourceId, event.id),
        sourceId: args.sourceId,
        sourceType: args.sourceType,
        sourceLabel: args.sourceLabel,
        title: event.title,
        summary: summary || event.feedName,
        body: event.summary ?? event.title,
        severity: event.severity,
        category: event.kind,
        area: event.road,
        address: event.road,
        occurredAt: event.updatedAt,
        detailUrl: event.detailUrl,
      };
    });
}

/** Notable USGS rows (tsunami, PAGER yellow+, magnitude threshold, landslides, eruptions). */
export function quakesToBoardAlerts(args: {
  sourceId: string;
  sourceType: string;
  sourceLabel: string;
  events: QuakeEvent[];
}): BoardAlert[] {
  return args.events
    .filter((event) => event.notable)
    .map((event) => {
      const summary = quakeSummary(event);
      return {
        id: boardAlertId(args.sourceId, event.id),
        sourceId: args.sourceId,
        sourceType: args.sourceType,
        sourceLabel: args.sourceLabel,
        title: event.title,
        summary,
        body: summary,
        severity: event.severity,
        category: event.tsunami ? "tsunami" : event.eventType,
        area: event.place,
        occurredAt: event.occurredAt,
        detailUrl: event.url,
      };
    });
}
