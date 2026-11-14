import assert from "node:assert/strict";
import {
  HAM_SOLAR_TYPE,
  SPACE_MIN_POLL_MS,
  buildSpaceSnapshot,
  listHamPairs,
  mapHemisphere,
  nearestAurora,
  parseAlerts,
  parseEstimatedKp,
  parsePlanetaryKp,
  parseScales,
  parseSolarFlux,
  parseSwpcHumanTime,
  parseSwpcTime,
  parseXray,
  readBand,
  selectAuroraPoints,
  spaceAlertIsCurrent,
  spaceAlertsForBoard,
  spacePollMs,
  xrayClass,
  type BandIndices,
} from "./spaceWeather.ts";

const quiet: BandIndices = { g: 0, r: 0, s: 0, known: true, kp: 0.67, flux: 118 };

assert.equal(xrayClass(5.601458497039857e-7), "B5.6");
assert.equal(xrayClass(5.6e-6), "C5.6");
assert.equal(xrayClass(2.5e-5), "M2.5");
assert.equal(xrayClass(1e-4), "X1.0");
assert.equal(xrayClass(1.5e-3), "X15");
assert.equal(xrayClass(0), null);

assert.equal(parseSwpcTime("2026-11-14 05:03:51.727"), Date.parse("2026-11-14T05:03:51.727Z"));
assert.equal(parseSwpcTime("2026-11-14T08:45:00Z"), Date.parse("2026-11-14T08:45:00Z"));
assert.equal(parseSwpcHumanTime("2026 Nov 10 1200 UTC"), Date.UTC(2026, 10, 10, 12, 0));

assert.equal(mapHemisphere("auto", 40.4), "north");
assert.equal(mapHemisphere("auto", -33), "south");
assert.equal(mapHemisphere("auto", 0), "both");
assert.equal(mapHemisphere("south", 40), "south");

assert.equal(readBand("20m", quiet).condition, "quiet");
assert.equal(readBand("80m", { ...quiet, g: 1 }).condition, "fair");
assert.equal(readBand("20m", { ...quiet, g: 1 }).condition, "quiet");
assert.equal(readBand("20m", { ...quiet, g: 2 }).condition, "fair");
assert.equal(readBand("80m", { ...quiet, g: 3 }).condition, "poor");
assert.equal(readBand("20m", { ...quiet, g: 3 }).condition, "fair");
assert.equal(readBand("10m", { ...quiet, g: 4 }).condition, "poor");
assert.equal(readBand("20m", { ...quiet, r: 3 }).condition, "poor");
assert.equal(readBand("40m", { ...quiet, r: 1 }).condition, "fair");
assert.equal(readBand("40m", { ...quiet, r: 2 }).condition, "poor");
assert.equal(readBand("20m", { ...quiet, r: 2 }).condition, "fair");
assert.equal(readBand("2m", { ...quiet, g: 2 }).condition, "aurora");
assert.equal(readBand("2m", quiet).condition, "quiet");
assert.equal(readBand("6m", { ...quiet, g: 1 }).condition, "aurora");
assert.equal(readBand("70cm", { ...quiet, g: 4 }).condition, "quiet");
assert.match(readBand("20m", { ...quiet, g: 4, r: 2 }).note, /R2/);
assert.match(readBand("20m", { ...quiet, g: 4, r: 2 }).note, /G4/);
assert.equal(readBand("20m", { ...quiet, known: false }).note, "NOAA scales were not available.");

const pairs = listHamPairs(
  {
    "src.swpc.ham": {
      type: HAM_SOLAR_TYPE,
      enabled: true,
      draft: false,
      params: { bands: "80m, 40m, 20m, 2m, 80m" },
    },
    "src.weather": {
      type: "weather.openmeteo",
      enabled: true,
      draft: false,
      params: { bands: "20m" },
    },
    "src.draft": {
      type: HAM_SOLAR_TYPE,
      enabled: true,
      draft: true,
      params: { bands: "10m" },
    },
  },
  { ...quiet, g: 2 },
);
assert.equal(pairs.length, 1);
assert.deepEqual(
  pairs[0].bands.map((band) => band.band),
  ["80m", "40m", "20m", "2m"],
);
assert.equal(pairs[0].bands[0].condition, "fair");
assert.equal(pairs[0].bands[3].condition, "aurora");
assert.match(pairs[0].summary, /G2/);
assert.match(pairs[0].summary, /118 sfu/);

const scales = parseScales({
  "0": {
    DateStamp: "2026-11-14",
    TimeStamp: "08:46:00",
    R: { Scale: "1", Text: "minor" },
    S: { Scale: "0", Text: "none" },
    G: { Scale: "2", Text: "moderate" },
  },
});
assert.equal(scales?.radio.level, 1);
assert.equal(scales?.geomagnetic.level, 2);
assert.equal(scales?.geomagnetic.text, "moderate");
assert.equal(scales?.observedAt, "2026-11-14T08:46:00Z");

const kp = parsePlanetaryKp([
  { time_tag: "2026-11-13T21:00:00", Kp: 1.33 },
  { time_tag: "2026-11-14T03:00:00", Kp: 0.67 },
  { time_tag: "2026-11-12T00:00:00", Kp: 4 },
]);
assert.equal(kp?.kp, 0.67);

const legacyKp = parsePlanetaryKp([
  ["time_tag", "Kp", "a_running", "station_count"],
  ["2026-11-13T00:00:00", "2.00", "7", "8"],
  ["2026-11-14T03:00:00", "1.33", "5", "8"],
]);
assert.equal(legacyKp?.kp, 1.33);

const estimated = parseEstimatedKp([
  { time_tag: "2026-11-14T02:47:00", estimated_kp: 1.0 },
  { time_tag: "2026-11-14T08:43:00", estimated_kp: 0.33 },
]);
assert.equal(estimated?.kp, 0.33);

const flux = parseSolarFlux([
  { time_tag: "2026-10-04T17:00:00", flux: 93 },
  { time_tag: "2026-11-13T22:00:00", flux: 118 },
]);
assert.equal(flux?.flux, 118);

const xray = parseXray([
  { time_tag: "2026-11-14T08:45:00Z", flux: 1e-6, energy: "0.05-0.4nm" },
  { time_tag: "2026-11-14T08:40:00Z", flux: 1e-6, energy: "0.1-0.8nm" },
  { time_tag: "2026-11-14T08:45:00Z", flux: 5.601e-7, energy: "0.1-0.8nm" },
]);
assert.equal(xray?.klass, "B5.6");

const alerts = parseAlerts([
  {
    product_id: "EF3A",
    issue_datetime: "2026-11-14 05:03:51.727",
    message:
      "Space Weather Message Code: ALTEF3\nSerial Number: 3775\nIssue Time: 2026 Nov 14 0503 UTC\n\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1,000pfu",
  },
  {
    product_id: "EF3A",
    issue_datetime: "2026-11-13 05:05:40.730",
    message:
      "Space Weather Message Code: ALTEF3\nSerial Number: 3774\nIssue Time: 2026 Nov 13 0505 UTC\n\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1,000pfu",
  },
  {
    product_id: "K04A",
    issue_datetime: "2026-11-07 19:20:00",
    message:
      "Space Weather Message Code: ALTK04\nSerial Number: 2697\nIssue Time: 2026 Nov 07 1920 UTC\n\nALERT: Geomagnetic K-index of 4",
  },
  {
    product_id: "K05A",
    issue_datetime: "2026-11-08 02:03:00",
    message:
      "Space Weather Message Code: ALTK05\nSerial Number: 2062\nIssue Time: 2026 Nov 08 0203 UTC\n\nALERT: Geomagnetic K-index of 5\nNOAA Scale: G1 - Minor\n\nPotential Impacts: Aurora may be visible at high latitudes.",
  },
  {
    product_id: "K04W",
    issue_datetime: "2026-11-01 03:02:00",
    message:
      "Space Weather Message Code: WARK04\nSerial Number: 5453\nIssue Time: 2026 Nov 01 0302 UTC\n\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\nNow Valid Until: 2026 Nov 20 1200 UTC",
  },
  {
    product_id: "A20F",
    issue_datetime: "2026-11-07 06:26:00",
    message:
      "Space Weather Message Code: WATA20\nSerial Number: 1137\nIssue Time: 2026 Nov 07 0626 UTC\n\nWATCH: Geomagnetic Storm Category G1 Predicted",
  },
  {
    product_id: "K06A",
    issue_datetime: "2026-10-31 19:14:00",
    message:
      "Space Weather Message Code: ALTK06\nSerial Number: 729\nIssue Time: 2026 Oct 31 1914 UTC\n\nALERT: Geomagnetic K-index of 6\nNOAA Scale: G2 - Moderate",
  },
  {
    product_id: "BHIS",
    issue_datetime: "2026-10-19 09:09:00",
    message:
      "Space Weather Message Code: SUM10R\nSerial Number: 930\nIssue Time: 2026 Oct 19 0909 UTC\n\nSUMMARY: 10cm Radio Burst",
  },
]);

assert.equal(alerts.filter((alert) => alert.code === "ALTEF3").length, 1);
assert.equal(alerts.find((alert) => alert.code === "ALTEF3")?.id, "ALTEF3-3775");
assert.equal(alerts.find((alert) => alert.code === "ALTEF3")?.notable, false);
assert.equal(alerts.find((alert) => alert.code === "ALTK04")?.notable, false);
assert.equal(alerts.find((alert) => alert.code === "ALTK05")?.severity, "warn");
assert.equal(alerts.find((alert) => alert.code === "ALTK05")?.notable, true);
assert.match(alerts.find((alert) => alert.code === "ALTK05")?.summary ?? "", /Potential Impacts/);
assert.equal(alerts.find((alert) => alert.code === "WARK04")?.notable, true);
assert.equal(alerts.find((alert) => alert.code === "WATA20")?.severity, "warn");
assert.equal(alerts.find((alert) => alert.code === "ALTK06")?.severity, "warn");
assert.equal(alerts.find((alert) => alert.code === "SUM10R")?.notable, false);

const legacyAlerts = parseAlerts([
  ["product_id", "issue_datetime", "message"],
  [
    "K07A",
    "2026-11-14 00:00:00",
    "Space Weather Message Code: ALTK07\nSerial Number: 9\nIssue Time: 2026 Nov 14 0000 UTC\n\nALERT: Geomagnetic K-index of 7\nNOAA Scale: G3 - Strong",
  ],
]);
assert.equal(legacyAlerts[0]?.severity, "alert");
assert.equal(legacyAlerts[0]?.code, "ALTK07");

const now = Date.parse("2026-11-14T12:00:00Z");
const oldWarning = alerts.find((alert) => alert.code === "WARK04");
assert.ok(oldWarning);
assert.equal(spaceAlertIsCurrent(oldWarning, now), true);
const expired = {
  ...oldWarning,
  validUntil: "2026-11-02T12:00:00Z",
  issuedAt: "2026-11-01T03:02:00Z",
};
assert.equal(spaceAlertIsCurrent(expired, now), false);
const fresh = alerts.find((alert) => alert.code === "ALTK05");
assert.ok(fresh);
assert.equal(spaceAlertIsCurrent(fresh, Date.parse("2026-11-09T00:00:00Z")), true);
assert.equal(spaceAlertIsCurrent(fresh, Date.parse("2026-11-14T00:00:00Z")), false);

const built = buildSpaceSnapshot({
  lat: 40.5,
  lon: -80,
  hemisphere: "north",
  showAurora: false,
  scales: {
    "0": {
      DateStamp: "2026-11-14",
      TimeStamp: "08:46:00",
      R: { Scale: "0", Text: "none" },
      S: { Scale: "0", Text: "none" },
      G: { Scale: "1", Text: "minor" },
    },
  },
  ovation: {
    "Observation Time": "2026-11-14T08:43:00Z",
    "Forecast Time": "2026-11-14T09:48:00Z",
    "Data Format": "[Longitude, Latitude, Aurora]",
    coordinates: [
      [0, 0, 2],
      [280, 40, 8],
      [279, 40, 4],
      [280, 41, 1],
      [200, -70, 30],
      [0, 90, 9],
      [10, 90, 9],
    ],
  },
});
assert.equal(built.space.auroraChance, 8);
assert.deepEqual(built.space.auroraPoints, []);
assert.equal(built.space.alerts[0]?.id, "scale-G");
assert.equal(spaceAlertsForBoard(built.space.alerts, now).some((alert) => alert.id === "scale-G"), true);

const mapped = selectAuroraPoints(
  [
    [0, 0, 2],
    [280, 40, 8],
    [279, 40, 4],
    [280, 41, 6],
    [200, -70, 30],
    [0, 90, 9],
    [10, 90, 9],
  ],
  "north",
);
assert.deepEqual(mapped, [
  { lon: 280, lat: 40, chance: 8 },
  { lon: 0, lat: 90, chance: 9 },
]);
assert.equal(nearestAurora([[280, 40, 8], [0, 0, 1]], 40.2, -79.5), 8);

assert.equal(spacePollMs("1m", 1000), SPACE_MIN_POLL_MS);
assert.equal(spacePollMs("15m", SPACE_MIN_POLL_MS), 15 * 60_000);
assert.equal(spacePollMs("30s", undefined), SPACE_MIN_POLL_MS);

console.log("spaceWeather.test.ts ok");
