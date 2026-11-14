/** One monitored feed. County and state place a street heard on that feed. */
export type SafetyFeed = {
  id: string;
  name: string;
  kind: "online" | "audio-in";
  url: string;
  deviceId: string;
  deviceLabel: string;
  county: string;
  state: string;
};

export type HeardCall = {
  dispatchType: string;
  severity: "info" | "warn" | "alert";
  heardAddress: string;
};

/** Assigned, answering, on scene, or released. A unit is not a person. */
export type UnitStatus = "dispatched" | "responding" | "on-scene" | "clear";

export type UnitMention = {
  id: string;
  status: UnitStatus;
};

/**
 * A person learned from a voice on this computer.
 * The id is not a unit ID. The same person may be heard on different units,
 * and the same unit may be a different person on another day.
 */
export type KnownPerson = {
  id: string;
  voiceKey: string;
  name: string | null;
  unitIds: string[];
};

export type TransmissionRead = {
  dispatchType: string | null;
  severity: HeardCall["severity"] | null;
  heardAddress: string | null;
  units: UnitMention[];
  /** Unit whose status report is on the air. Not a person. */
  callingUnitId: string | null;
};

export type OpenIncident = {
  id: string;
  units: { id: string; status: Exclude<UnitStatus, "clear"> }[];
};

/**
 * whisper.cpp b5454 `whisper-cli` with ggml-tiny.en writes words and timestamps
 * only. It does not emit a speaker key or a voice embedding, and this app does
 * not run another local diarizer. A unit ID is never stored as a voice. What is
 * missing is a local diarizer that returns a stable person key per voice on
 * this computer. That key can show up later on a different unit, and a different
 * key on the same unit is a different person. Audio is not uploaded.
 */
export const SPEAKER_GAP =
  "Tiny English does not learn who is speaking. whisper.cpp b5454 (whisper-cli, ggml-tiny.en) writes words and timestamps only, with no speaker key and no voice embedding. A unit ID is not a person: the same person may keep a unit or move to another, and a unit may be someone else the next day. What is missing is a local diarizer that assigns a stable person key per voice on this computer. Audio is not sent out to be identified.";

export type PlacedCall = {
  lat: number;
  lon: number;
  label: string;
};

type DispatchKind = {
  label: string;
  severity: HeardCall["severity"];
  patterns: RegExp[];
};

const MAX_FEEDS = 8;

const STREET_SUFFIX =
  "street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|circle|cir|highway|hwy|pike|parkway|pkwy|terrace|ter|trail|trl";

const SUFFIX_FULL: Record<string, string> = {
  st: "Street",
  ave: "Avenue",
  rd: "Road",
  blvd: "Boulevard",
  dr: "Drive",
  ln: "Lane",
  ct: "Court",
  pl: "Place",
  cir: "Circle",
  hwy: "Highway",
  pkwy: "Parkway",
  ter: "Terrace",
  trl: "Trail",
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "at",
  "on",
  "near",
  "scene",
  "unit",
  "copy",
  "dispatch",
  "station",
  "engine",
  "medic",
  "responding",
  "holding",
  "clear",
  "last",
  "and",
]);

/** Specific phrases first so "structure fire" does not collapse to "fire". */
const DISPATCH_TYPES: DispatchKind[] = [
  { label: "Structure fire", severity: "alert", patterns: [/structure fire/, /working fire/, /house fire/, /building fire/] },
  { label: "Vehicle fire", severity: "alert", patterns: [/vehicle fire/, /car fire/, /auto fire/] },
  { label: "Brush fire", severity: "warn", patterns: [/brush fire/, /woods fire/, /grass fire/] },
  { label: "Fire alarm", severity: "warn", patterns: [/fire alarm/] },
  { label: "Gas leak", severity: "alert", patterns: [/gas leak/, /smell of gas/] },
  { label: "Hazmat", severity: "alert", patterns: [/hazmat/, /hazardous materials?/] },
  { label: "Cardiac arrest", severity: "alert", patterns: [/cardiac/, /\bcpr\b/, /not breathing/, /full arrest/] },
  { label: "Overdose", severity: "alert", patterns: [/overdose/] },
  { label: "Medical", severity: "alert", patterns: [/chest pain/, /unconscious/, /seizure/, /\bstroke\b/, /\bmedic\b/, /\bems\b/, /medical/] },
  { label: "Shots fired", severity: "alert", patterns: [/shots fired/, /shot fired/, /shooting/, /gunshot/, /person with a gun/] },
  { label: "Robbery", severity: "alert", patterns: [/robbery/, /hold[- ]?up/, /carjack/] },
  { label: "Burglary", severity: "warn", patterns: [/burglary/, /burglar alarm/, /break[- ]in/] },
  { label: "Domestic", severity: "alert", patterns: [/domestic/] },
  { label: "Assault", severity: "alert", patterns: [/assault/, /\bfight\b/, /stabbing/] },
  { label: "Crash", severity: "warn", patterns: [/\baccident\b/, /\bcrash\b/, /collision/, /\bwreck\b/] },
  { label: "Wires down", severity: "warn", patterns: [/wires down/, /lines down/, /pole down/] },
  { label: "Fire", severity: "alert", patterns: [/\bfire\b/, /smoke showing/, /\bflames\b/] },
];

export const US_STATES: { code: string; name: string }[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

export function blankFeed(): SafetyFeed {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `feed-${crypto.randomUUID().slice(0, 8)}`
      : `feed-${Math.random().toString(16).slice(2, 10)}`;
  return {
    id,
    name: "",
    kind: "online",
    url: "",
    deviceId: "default",
    deviceLabel: "Default input",
    county: "",
    state: "",
  };
}

export function canonicalState(input: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\./g, "");
  if (!raw) return null;
  const byCode = US_STATES.find((item) => item.code.toLowerCase() === raw);
  if (byCode) return byCode.code;
  const byName = US_STATES.find((item) => item.name.toLowerCase() === raw);
  return byName?.code ?? null;
}

export function stateFullName(input: string): string {
  const code = canonicalState(input);
  return US_STATES.find((item) => item.code === code)?.name ?? input.trim();
}

export function clampRadius(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 100) return null;
  return rounded;
}

export function looksLikeZipList(value: string): boolean {
  return /\b\d{5}(?:-\d{4})?\b/.test(value);
}

function clipText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001f]/g, "").trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function readFeeds(value: unknown): SafetyFeed[] {
  if (!Array.isArray(value)) return [];
  const feeds: SafetyFeed[] = [];
  for (let index = 0; index < value.length && feeds.length < MAX_FEEDS; index += 1) {
    const row = value[index];
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = clipText(record.id, 40) || `feed-${index + 1}`;
    feeds.push({
      id,
      name: clipText(record.name, 80),
      kind: record.kind === "audio-in" ? "audio-in" : "online",
      url: clipText(record.url, 500),
      deviceId: clipText(record.deviceId, 160) || "default",
      deviceLabel: clipText(record.deviceLabel, 160) || "Default input",
      county: clipText(record.county, 60),
      state: clipText(record.state, 40),
    });
  }
  return feeds;
}

export function streamUrlError(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "needs an http or https stream URL";
  if (trimmed.length > 500) return "has a stream URL that is too long";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "needs an http or https stream URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "needs an http or https stream URL";
  }
  if (!parsed.hostname) return "needs an http or https stream URL";
  return null;
}

export function feedProblem(feed: SafetyFeed): string | null {
  const name = feed.name.trim() || "A feed";
  if (!feed.name.trim()) return "Each feed needs a name.";
  if (!feed.county.trim()) return `${name} needs the county it covers.`;
  if (looksLikeZipList(feed.county)) {
    return `${name} should name the county, not a zip code.`;
  }
  if (!canonicalState(feed.state)) return `${name} needs the state it covers.`;
  if (feed.kind === "audio-in") {
    if (!feed.deviceId.trim()) return `${name} needs an audio input.`;
    return null;
  }
  const urlError = streamUrlError(feed.url);
  if (urlError) return `${name} ${urlError}.`;
  return null;
}

export function feedsSaveError(params: Record<string, unknown>): string | null {
  if (clampRadius(params.radiusMi) == null) {
    return "Radius must be between 1 and 100 miles.";
  }
  const feeds = readFeeds(params.feeds);
  if (!feeds.length) {
    return "Add at least one feed. Each one needs the county and state it covers.";
  }
  for (const feed of feeds) {
    const problem = feedProblem(feed);
    if (problem) return problem;
  }
  return null;
}

export function normalizeSafetyParams(params: Record<string, unknown>): Record<string, unknown> {
  const radius = clampRadius(params.radiusMi);
  return {
    ...params,
    radiusMi: radius ?? params.radiusMi,
    enableCaptions: params.enableCaptions !== false,
    feeds: readFeeds(params.feeds).map((feed) => ({
      ...feed,
      state: canonicalState(feed.state) ?? feed.state.trim(),
    })),
  };
}

export function transcriptText(segments: { text: string }[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_KIND =
  "engine|ladder|truck|tower|medic|ambulance|rescue|squad|battalion|chief|quint|patrol";

export function readCall(transcript: string): HeardCall | null {
  const heard = readTransmission(transcript);
  if (!heard.heardAddress) return null;
  return {
    dispatchType: heard.dispatchType ?? "Dispatch",
    severity: heard.severity ?? "warn",
    heardAddress: heard.heardAddress,
  };
}

/** Caption fixes run before the reader so a corrected street can be placed. */
export function readPreparedCall(
  transcript: string,
  correct: (text: string) => string,
): HeardCall | null {
  return readCall(correct(transcript));
}

/** Captions in, units and place out. A unit ID in the words is not a voice. */
export function readTransmission(transcript: string): TransmissionRead {
  const text = transcript.replace(/\s+/g, " ").trim();
  const heardAddress = text ? hearAddress(text) : null;
  const kind = text ? hearType(text) : null;
  const units = text ? unitMentions(text, Boolean(heardAddress)) : [];
  const calling = units.find((unit) => unit.status !== "dispatched");
  return {
    dispatchType: kind?.label ?? null,
    severity: kind?.severity ?? null,
    heardAddress,
    units,
    callingUnitId: calling?.id ?? null,
  };
}

export function readPreparedTransmission(
  transcript: string,
  correct: (text: string) => string,
): TransmissionRead {
  return readTransmission(correct(transcript));
}

/** True when the string is a unit ID, so it cannot be stored as a person. */
export function looksLikeUnitId(value: string): boolean {
  return new RegExp(`^(?:${UNIT_KIND})\\s+\\d{1,4}$`, "i").test(value.trim());
}

/**
 * Match a local voice key to a person. Unit IDs are refused.
 * An unknown key is not a person yet — call `learnPerson` when the diarizer produced it.
 */
export function personFromVoice(
  voiceKey: string | null | undefined,
  people: KnownPerson[],
): string | null {
  const key = voiceKey?.trim() ?? "";
  if (!key || looksLikeUnitId(key)) return null;
  return people.find((person) => person.voiceKey === key)?.id ?? null;
}

/** Remember a person on the unit they were using. The person id does not change when the unit does. */
export function learnPerson(
  people: KnownPerson[],
  voiceKey: string | null | undefined,
  unitId: string | null,
): KnownPerson[] {
  const key = voiceKey?.trim() ?? "";
  if (!key || looksLikeUnitId(key)) return people;
  const unit = unitId?.trim() || null;
  const existing = people.find((person) => person.voiceKey === key);
  if (!existing) {
    return [
      ...people,
      {
        id: personIdFor(key),
        voiceKey: key,
        name: null,
        unitIds: unit ? [unit] : [],
      },
    ];
  }
  if (!unit || existing.unitIds.includes(unit)) return people;
  return people.map((person) =>
    person.voiceKey === key ? { ...person, unitIds: [...person.unitIds, unit] } : person,
  );
}

export function personPhrase(person: KnownPerson | null): string | null {
  if (!person) return null;
  const name = person.name?.trim() || "learned voice";
  if (person.unitIds.length > 1) return `${name} (heard on ${person.unitIds.join(", ")})`;
  return name;
}

const PEOPLE_KEY = "command-center.safety-people.v1";

export function loadKnownPeople(): KnownPerson[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(PEOPLE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isKnownPerson);
  } catch {
    return [];
  }
}

export function saveKnownPeople(people: KnownPerson[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(people));
  } catch {
    /* The board still shows the transmission without a saved roster. */
  }
}

/**
 * Later traffic joins an open incident while it shares a unit that is still
 * dispatched, responding, or on scene. Cleared, available, or left the scene
 * releases that unit. The next dispatch or response for it starts a new incident.
 * Who is speaking is not part of this match.
 */
export function foldTransmission(
  open: OpenIncident[],
  heard: TransmissionRead,
  createId: string,
): { open: OpenIncident[]; incidentId: string | null; action: "created" | "joined" | "ignored" } {
  const active = heard.units.filter(
    (unit): unit is { id: string; status: Exclude<UnitStatus, "clear"> } => unit.status !== "clear",
  );
  const clearing = heard.units.filter((unit) => unit.status === "clear").map((unit) => unit.id);
  let next = open.map((incident) => ({
    id: incident.id,
    units: incident.units.map((unit) => ({ ...unit })),
  }));

  const overlap = (incident: OpenIncident) =>
    active.filter((unit) => incident.units.some((assigned) => assigned.id === unit.id)).length;
  const ranked = next
    .map((incident, index) => ({ incident, index, score: overlap(incident) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const target = ranked[0]?.incident ?? null;

  let incidentId: string | null = null;
  let action: "created" | "joined" | "ignored" = "ignored";

  if (target) {
    incidentId = target.id;
    action = "joined";
    for (const unit of active) {
      for (const incident of next) {
        if (incident.id !== target.id) {
          incident.units = incident.units.filter((assigned) => assigned.id !== unit.id);
        }
      }
      const assigned = target.units.find((item) => item.id === unit.id);
      if (assigned) assigned.status = unit.status;
      else target.units.push({ id: unit.id, status: unit.status });
    }
  } else if (heard.heardAddress) {
    incidentId = createId;
    action = "created";
    next = [
      ...next,
      {
        id: createId,
        units: active.map((unit) => ({ id: unit.id, status: unit.status })),
      },
    ];
  } else if (clearing.length) {
    const holders = next.filter((incident) =>
      incident.units.some((unit) => clearing.includes(unit.id)),
    );
    const holder = holders[holders.length - 1];
    if (holder) {
      incidentId = holder.id;
      action = "joined";
    }
  }

  if (clearing.length) {
    next = next.map((incident) => ({
      ...incident,
      units: incident.units.filter((unit) => !clearing.includes(unit.id)),
    }));
  }

  return { open: next, incidentId, action };
}

export function nextIncidentId(
  feedId: string,
  heard: { dispatchType: string; heardAddress: string },
  open: { id: string }[],
): string {
  const base = hitId(feedId, {
    dispatchType: heard.dispatchType,
    severity: "warn",
    heardAddress: heard.heardAddress,
  });
  if (!open.some((incident) => incident.id === base)) return base;
  let n = 2;
  while (open.some((incident) => incident.id === `${base}:${n}`)) n += 1;
  return `${base}:${n}`;
}

export function formatRadioTranscript(
  rows: { callingUnitId: string | null; personLabel: string | null; text: string }[],
): string {
  return rows
    .map((row) => {
      const unit = row.callingUnitId ? `Unit ${row.callingUnitId}` : "Unit not named";
      const person = row.personLabel ? `Person: ${row.personLabel}` : "Person: not learned";
      return `${unit}\n${person}\n${row.text}`;
    })
    .join("\n\n");
}

function personIdFor(voiceKey: string): string {
  let hash = 2166136261;
  for (let i = 0; i < voiceKey.length; i += 1) {
    hash ^= voiceKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `person:${(hash >>> 0).toString(16)}`;
}

function isKnownPerson(value: unknown): value is KnownPerson {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<KnownPerson>;
  return (
    typeof row.id === "string" &&
    row.id.startsWith("person:") &&
    typeof row.voiceKey === "string" &&
    !looksLikeUnitId(row.voiceKey) &&
    (row.name === null || typeof row.name === "string") &&
    Array.isArray(row.unitIds) &&
    row.unitIds.every((unit) => typeof unit === "string")
  );
}

function unitMentions(text: string, hasAddress: boolean): UnitMention[] {
  const found = [...text.matchAll(new RegExp(`\\b(${UNIT_KIND})\\s+(\\d{1,4})\\b`, "gi"))];
  const mentions: UnitMention[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const match = found[index];
    if (match.index == null) continue;
    const end = found[index + 1]?.index ?? text.length;
    const slice = text.slice(match.index, end);
    const id = canonicalUnit(match[1] ?? "", match[2] ?? "");
    const status = lastStatus(slice) ?? (hasAddress ? "dispatched" : null);
    if (!status) continue;
    const previous = mentions.findIndex((item) => item.id === id);
    if (previous >= 0) mentions.splice(previous, 1);
    mentions.push({ id, status });
  }
  return mentions;
}

function canonicalUnit(kind: string, number: string): string {
  const lower = kind.toLowerCase();
  return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)} ${number}`;
}

function lastStatus(slice: string): UnitStatus | null {
  const lower = slice.toLowerCase();
  const found: { at: number; status: UnitStatus }[] = [];
  const add = (source: string, status: UnitStatus) => {
    const re = new RegExp(source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(lower))) {
      if (status === "clear" && /^clear (the|a|traffic|intersection)\b/.test(lower.slice(match.index, match.index + 24))) {
        continue;
      }
      found.push({ at: match.index, status });
    }
  };
  add("\\bcleared\\b", "clear");
  add("\\bavailable\\b", "clear");
  add("\\bin service\\b", "clear");
  add("\\bleft the scene\\b", "clear");
  add("\\bleaving the scene\\b", "clear");
  add("\\boff scene\\b", "clear");
  add("\\bclear\\b", "clear");
  add("\\bon the scene\\b|\\bon scene\\b|\\barrived\\b", "on-scene");
  add("\\bresponding\\b|\\ben route\\b|\\benroute\\b|\\bon the way\\b", "responding");
  add("\\bdispatched\\b", "dispatched");
  if (!found.length) return null;
  found.sort((a, b) => a.at - b.at);
  return found[found.length - 1]?.status ?? null;
}

export function hitId(feedId: string, call: HeardCall): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
  return `${feedId}:${slug(call.dispatchType)}:${slug(call.heardAddress)}`;
}

function hearType(text: string): DispatchKind | null {
  const lower = text.toLowerCase();
  for (const kind of DISPATCH_TYPES) {
    if (kind.patterns.some((pattern) => pattern.test(lower))) return kind;
  }
  return null;
}

function hearAddress(text: string): string | null {
  const street = text.match(streetPattern());
  if (street) return fromStreet(street);
  const crossing = hearCrossing(text);
  if (crossing) return crossing;
  const loose = text.match(
    /\b(?:at|on|near)\s+([A-Za-z][A-Za-z.'-]{2,}(?:\s+[A-Za-z][A-Za-z.'-]{2,}){0,2})\s+(?:and|&)\s+([A-Za-z][A-Za-z.'-]{2,}(?:\s+[A-Za-z][A-Za-z.'-]{2,}){0,2})\b/i,
  );
  if (loose && sideOk(loose[1] ?? "") && sideOk(loose[2] ?? "")) {
    return `${clean(loose[1] ?? "")} and ${clean(loose[2] ?? "")}`;
  }
  return null;
}

function streetPattern(): RegExp {
  return new RegExp(
    `\\b(\\d{1,6})\\s+(?:block(?:\\s+of)?\\s+)?([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,3})\\s+(${STREET_SUFFIX})\\b`,
    "i",
  );
}

function hearCrossing(text: string): string | null {
  const parts = text.split(/\s+(?:and|&)\s+/i);
  if (parts.length < 2) return null;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const left = trailingStreet(parts[index] ?? "");
    const right = leadingStreet(parts[index + 1] ?? "");
    if (left && right) return `${left} and ${right}`;
  }
  return null;
}

function trailingStreet(chunk: string): string | null {
  const suffix = chunk.match(new RegExp(`\\b(${STREET_SUFFIX})\\s*$`, "i"));
  if (!suffix || suffix.index == null) return null;
  const words = chunk
    .slice(0, suffix.index)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept: string[] = [];
  for (let index = words.length - 1; index >= 0 && kept.length < 3; index -= 1) {
    const word = words[index] ?? "";
    if (!/^[A-Za-z][A-Za-z.'-]*$/.test(word) || STOP_WORDS.has(word.toLowerCase())) break;
    kept.unshift(word);
  }
  if (!kept.length) return null;
  return expandSuffix(`${kept.join(" ")} ${suffix[1]}`);
}

function leadingStreet(chunk: string): string | null {
  const match = chunk
    .trim()
    .match(new RegExp(`^([A-Za-z][A-Za-z.'-]*(?:\\s+[A-Za-z][A-Za-z.'-]*){0,2})\\s+(${STREET_SUFFIX})\\b`, "i"));
  if (!match || !sideOk(match[1] ?? "")) return null;
  return expandSuffix(`${clean(match[1] ?? "")} ${match[2] ?? ""}`);
}

function fromStreet(match: RegExpMatchArray): string {
  const number = match[1] ?? "";
  const name = clean(match[2] ?? "");
  const suffix = match[3] ?? "";
  const block = /block/i.test(match[0] ?? "");
  const raw = block ? `${number} block of ${name} ${suffix}` : `${number} ${name} ${suffix}`;
  return expandSuffix(clean(raw));
}

function sideOk(value: string): boolean {
  const first = value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Boolean(first) && !STOP_WORDS.has(first);
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim();
}

function expandSuffix(address: string): string {
  return address.replace(/\s+([A-Za-z]+)$/, (all, suffix: string) => {
    const full = SUFFIX_FULL[suffix.toLowerCase()];
    return full ? ` ${full}` : all;
  });
}

/** Street plus the feed's county and state. No zip code. */
export function placeQuery(heard: string, county: string, state: string): string {
  const countyName = county.trim().replace(/\s+county$/i, "");
  return `${heard.trim()}, ${countyName} County, ${stateFullName(state)}`;
}

export function labelMatchesState(label: string, state: string): boolean {
  const names = new Set(stateAliases(state));
  if (!names.size) return false;
  const parts = label
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/\./g, ""))
    .filter((part) => part && part !== "united states" && part !== "usa" && part !== "us");
  return parts.some((part) => names.has(part));
}

function stateAliases(input: string): string[] {
  const code = canonicalState(input);
  if (!code) return [];
  const full = US_STATES.find((item) => item.code === code)?.name.toLowerCase() ?? "";
  return full && full !== code.toLowerCase() ? [code.toLowerCase(), full] : [code.toLowerCase()];
}

/**
 * Sample captions. Engine 12 responding and on scene stay one incident.
 * After Engine 12 clears, the next response is a new incident.
 */
export const PREVIEW_TRANSMISSIONS = [
  ["Engine 12 responding, structure fire,", "12245 Frankstown Road."],
  ["Engine 12 on scene.", "Smoke showing from the second floor."],
  ["Engine 12 cleared."],
  ["Engine 12 responding, structure fire,", "12245 Frankstown Road."],
];

export function previewTranscript(): string {
  return transcriptText((PREVIEW_TRANSMISSIONS[0] ?? []).map((text) => ({ text })));
}

export function choosePlacement(
  matches: PlacedCall[],
  county: string,
  state: string,
  heard?: string,
): PlacedCall | null {
  const inState = matches.filter((match) => labelMatchesState(match.label, state));
  if (!inState.length) return null;
  const countyName = county.trim().toLowerCase().replace(/\s+county$/, "");
  const inCounty = countyName
    ? inState.filter((match) => match.label.toLowerCase().includes(countyName))
    : [];
  const pool = inCounty.length ? inCounty : inState;
  const number = heard?.match(/^\s*(\d{1,6})\b/)?.[1];
  if (number) {
    const exact = pool.find((match) => new RegExp(`\\b${number}\\b`).test(match.label));
    if (exact) return exact;
  }
  return pool[0] ?? null;
}

export function milesBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideRadius(miles: number, radiusMi: number): boolean {
  return Number.isFinite(miles) && miles >= 0 && miles <= radiusMi;
}

export function formatMiles(miles: number): string {
  if (!Number.isFinite(miles) || miles < 0) return "—";
  if (miles < 0.1) return "under 0.1 mi";
  if (miles >= 10) return `${Math.round(miles)} mi`;
  return `${miles.toFixed(1)} mi`;
}
