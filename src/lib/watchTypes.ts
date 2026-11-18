export const WATCH_TYPES = [
  "rivers.nwps",
  "storms.spc",
  "lightning.glm",
  "agency.rss",
  "transit.gtfs",
  "tfr.faa",
  "nuclear.nrc",
  "radiation.epa",
  "spills.uscg",
  "disease.who",
  "internet.ioda",
  "alarms.home",
] as const;

export function isWatchType(typeId: string): boolean {
  return (WATCH_TYPES as readonly string[]).includes(typeId);
}
