import assert from "node:assert/strict";
import {
  readMapCount,
  readRotateMaps,
  readWeatherMaps,
  visibleWeatherMaps,
  weatherMapsSaveError,
} from "./weatherMaps.ts";

assert.deepEqual(readWeatherMaps({ scopes: "local,nationwide" }), ["local", "nationwide"]);
assert.deepEqual(readWeatherMaps({ scopes: ["regional", "local", "nope"] }), ["local", "regional"]);
assert.deepEqual(readWeatherMaps({ scopes: "local+regional" }), ["local", "regional"]);
assert.equal(weatherMapsSaveError({ scopes: "" }), "Choose at least one weather map.");
assert.equal(weatherMapsSaveError({ scopes: "local" }), null);

const legacy = { scopes: "local,regional,nationwide" };
assert.equal(readMapCount(legacy, readWeatherMaps(legacy)), 3);
assert.equal(readRotateMaps(legacy), false);
assert.deepEqual(visibleWeatherMaps(legacy, 0), ["local", "regional", "nationwide"]);

const rotating = { scopes: "local,regional,nationwide", mapCount: 1, rotateMaps: true, mapRotateSec: 15 };
assert.deepEqual(visibleWeatherMaps(rotating, 0), ["local"]);
assert.deepEqual(visibleWeatherMaps(rotating, 1), ["regional"]);
assert.deepEqual(visibleWeatherMaps(rotating, 2), ["nationwide"]);
assert.deepEqual(visibleWeatherMaps(rotating, 3), ["local"]);

const pair = { scopes: ["local", "regional", "nationwide"], mapCount: 2, rotateMaps: true };
assert.deepEqual(visibleWeatherMaps(pair, 1), ["regional", "nationwide"]);
assert.deepEqual(visibleWeatherMaps(pair, 2), ["nationwide", "local"]);

const held = { scopes: "local,regional", mapCount: 2, rotateMaps: true };
assert.deepEqual(visibleWeatherMaps(held, 4), ["local", "regional"]);
