import assert from "node:assert/strict";
import {
  PRT_BUS_ALERTS,
  PRT_RAIL_ALERTS,
  fillTransitUrls,
  inPrtArea,
  prepareSource,
} from "./sourceDraft.ts";

const pennHills = {
  location: {
    confirmed: true,
    lat: 40.4759,
    lon: -79.833,
    label: "Penn Hills, Pennsylvania",
    provider: "address",
  },
};

const columbus = {
  location: {
    confirmed: true,
    lat: 39.9612,
    lon: -82.9988,
    label: "Columbus, Ohio",
    provider: "address",
  },
};

assert.equal(inPrtArea(40.4759, -79.833), true);
assert.equal(inPrtArea(39.9612, -82.9988), false);

const filled = fillTransitUrls({ ...pennHills, urls: "" });
assert.equal(String(filled.urls).includes(PRT_BUS_ALERTS), true);
assert.equal(String(filled.urls).includes(PRT_RAIL_ALERTS), true);
const kept = fillTransitUrls({ ...pennHills, urls: "https://example.test/alerts" });
assert.equal(kept.urls, "https://example.test/alerts");
assert.equal(fillTransitUrls({ ...columbus, urls: "" }).urls, "");

const weather = await prepareSource({
  typeId: "weather.openmeteo",
  params: { ...pennHills, scopes: "", units: "imperial" },
  secrets: {},
});
assert.equal(weather.ok, false);
if (!weather.ok) assert.equal(weather.message, "Choose at least one weather map.");

const maps = await prepareSource({
  typeId: "weather.openmeteo",
  params: {
    ...pennHills,
    scopes: "local,nationwide",
    units: "imperial",
    mapCount: 1,
    rotateMaps: true,
    mapRotateSec: 2,
  },
  secrets: {},
});
assert.equal(maps.ok, true);
if (maps.ok) {
  assert.equal(maps.value.source.params.scopes, "local,nationwide");
  assert.equal(maps.value.source.params.mapCount, 1);
  assert.equal(maps.value.source.params.rotateMaps, true);
  assert.equal(maps.value.source.params.mapRotateSec, 5);
}

const prt = await prepareSource({
  typeId: "transit.gtfs",
  params: { ...pennHills, urls: "" },
  secrets: {},
});
assert.equal(prt.ok, true);
if (prt.ok) assert.equal(String(prt.value.source.params.urls).includes(PRT_BUS_ALERTS), true);

const elsewhere = await prepareSource({
  typeId: "transit.gtfs",
  params: { ...columbus, urls: "" },
  secrets: {},
});
assert.equal(elsewhere.ok, false);
if (!elsewhere.ok) assert.match(elsewhere.message, /Pittsburgh/);

const alarms = await prepareSource({
  typeId: "alarms.home",
  params: { link: "homeassistant", baseUrl: "", topic: "homeassistant/#" },
  secrets: {},
});
assert.equal(alarms.ok, false);
if (!alarms.ok) assert.match(alarms.message, /Home Assistant URL/);

const mqttOnly = await prepareSource({
  typeId: "alarms.home",
  params: { link: "mqtt", mqttHost: "192.168.1.20", topic: "homeassistant/#", mqttPort: 1883 },
  secrets: {},
});
assert.equal(mqttOnly.ok, true);
if (mqttOnly.ok) assert.equal(mqttOnly.value.source.secrets.includes("alarms.token"), false);
