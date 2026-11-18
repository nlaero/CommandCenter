import assert from "node:assert/strict";
import { ADAPTER_CATALOG } from "../adapters/catalog.ts";
import {
  SOURCE_GROUP_ORDER,
  liveFeedRefusal,
  rollingPanelRefusal,
  sourceGroup,
  sourceScrolls,
} from "./rolling.ts";

const live = [
  "adsb.exchange",
  "adsb.local",
  "audio.local",
  "broadcastify.owner",
  "camera.http_image",
  "camera.private",
  "camera.public",
  "camera.rtsp",
  "scanner.web",
  "video.youtube",
];

for (const typeId of live) {
  assert.equal(sourceScrolls(typeId), false, typeId);
  const refusal = liveFeedRefusal(typeId);
  assert.ok(refusal?.includes("does not scroll"), refusal ?? undefined);
  assert.equal(rollingPanelRefusal(["news.rss", typeId])?.includes("does not scroll"), true);
}

assert.equal(sourceScrolls("broadcastify.calls"), true);
assert.equal(sourceScrolls("weather.openmeteo"), true);
assert.ok(liveFeedRefusal("weather.openmeteo")?.includes("cannot be added to a rolling panel"));
assert.equal(
  rollingPanelRefusal(["news.rss", "weather.openmeteo"]),
  liveFeedRefusal("weather.openmeteo"),
);
assert.equal(sourceScrolls("rivers.nwps"), true);
assert.equal(sourceScrolls("lightning.glm"), true);
assert.equal(sourceScrolls("alarms.home"), true);
assert.equal(liveFeedRefusal("news.rss"), null);
assert.equal(rollingPanelRefusal(["news.rss", "usgs.earthquake"]), null);
assert.equal(
  rollingPanelRefusal(["scanner.web"]),
  liveFeedRefusal("scanner.web"),
);

for (const adapter of ADAPTER_CATALOG) {
  const group = sourceGroup(adapter.typeId);
  assert.ok(
    (SOURCE_GROUP_ORDER as readonly string[]).includes(group),
    `${adapter.typeId} -> ${group}`,
  );
}

const ids = new Set(ADAPTER_CATALOG.map((adapter) => adapter.typeId));
for (const typeId of [
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
]) {
  assert.equal(ids.has(typeId), true, typeId);
  assert.equal(sourceScrolls(typeId), true, typeId);
}
