import assert from "node:assert/strict";
import {
  appendFeedCaptionWindow,
  broadcastifyAudioInputs,
  callsInputId,
  closeFeedCaptionSession,
  correctFeedCaptionLines,
  feedOwnerInputId,
  isContinuousAudioStream,
  isFeedOwnerAudio,
  liveCaptionWindow,
  openFeedCaptionSession,
  parseCallsInputId,
  parseFeedOwnerInputId,
  programAudioSources,
  publicStreamUrl,
  readFeedCaptionHistory,
  resetFeedCaptionsForTests,
  syncSafetyFeeds,
  takeFeedCaptionWindows,
} from "./feedCaptions.ts";
import { readFeeds } from "./safety.ts";

resetFeedCaptionsForTests();

assert.equal(isContinuousAudioStream("http://relay.example/136068518"), true);
assert.equal(isContinuousAudioStream("https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"), false);
assert.deepEqual(liveCaptionWindow("http://relay.example/136068518", 1), {
  seekSec: 0,
  timelineStart: 12,
  durationSec: 12,
});
assert.deepEqual(liveCaptionWindow("https://cdn.example/clip.mp3", 2), {
  seekSec: 24,
  timelineStart: 24,
  durationSec: 12,
});

const dirty = "http://owner:hunter2@relay.example:80/47291?p=hunter2&x=1";
const shared = publicStreamUrl(dirty);
assert.equal(shared.includes("hunter2"), false);
assert.equal(shared.includes("owner"), false);
assert.equal(shared, "http://relay.example/47291?x=1");
assert.equal(publicStreamUrl("not a url"), "");

const sourceId = "src.owner.abcd1234";
assert.equal(parseFeedOwnerInputId(feedOwnerInputId(sourceId)), sourceId);
assert.equal(isFeedOwnerAudio({ kind: "audio-in", deviceId: feedOwnerInputId(sourceId) }), true);
assert.equal(isFeedOwnerAudio({ kind: "online", deviceId: feedOwnerInputId(sourceId) }), false);
assert.equal(parseFeedOwnerInputId("default"), null);
assert.equal(parseCallsInputId(callsInputId("src.calls.abcd1234")), "src.calls.abcd1234");
assert.equal(parseCallsInputId(feedOwnerInputId(sourceId)), null);
assert.equal(parseFeedOwnerInputId(callsInputId("src.calls.abcd1234")), null);

assert.deepEqual(
  broadcastifyAudioInputs({
    "src.weather.1": { type: "weather.openmeteo", params: {} },
    [sourceId]: { type: "broadcastify.owner", params: { preset: "penn-hills", feedId: "47291" } },
    "src.owner.custom1": { type: "broadcastify.owner", params: { preset: "custom", feedId: "99" } },
  }).map((item) => item.label),
  ["Feed 99 · captions", "Penn Hills / Plum Police Dispatch · captions"],
);

const callsId = "src.calls.east1";
const configured = {
  "src.weather.1": { type: "weather.openmeteo", params: { location: { label: "home" } } },
  [sourceId]: {
    type: "broadcastify.owner",
    params: { preset: "penn-hills", feedId: "47291" },
    enabled: false,
    draft: true,
  },
  "src.owner.custom1": { type: "broadcastify.owner", params: { preset: "custom", feedId: "99" } },
  [callsId]: { type: "broadcastify.calls", params: { label: "Allegheny East", selectorId: "12573" } },
  "src.calls.blank": { type: "broadcastify.calls", params: {} },
  "src.safety.1": { type: "safety.nearby", params: { feeds: [] } },
};
const listed = programAudioSources(configured);
assert.deepEqual(
  listed.map((item) => item.label),
  ["Allegheny East", "Broadcastify Calls", "Feed 99", "Penn Hills / Plum Police Dispatch"],
);
assert.equal(listed.some((item) => item.id === "src.weather.1" || item.id === "src.safety.1"), false);
assert.equal(listed.find((item) => item.id === sourceId)?.county, "Allegheny");
assert.equal(listed.find((item) => item.id === sourceId)?.state, "PA");
assert.equal(JSON.stringify(listed).includes("password"), false);
assert.equal(JSON.stringify(listed).includes("secret"), false);

const synced = syncSafetyFeeds(
  {
    radiusMi: 10,
    feeds: [
      {
        id: "feed-old",
        name: "",
        kind: "online",
        url: "https://user:hunter2@example.com/secret-stream",
        deviceId: "default",
        county: "Westmoreland",
        state: "PA",
      },
      {
        id: "feed-mic",
        name: "Desk scanner",
        kind: "audio-in",
        url: "",
        deviceId: "default",
        county: "Allegheny",
        state: "PA",
        listen: true,
      },
    ],
  },
  configured,
);
const syncedFeeds = readFeeds(synced.feeds);
assert.equal(syncedFeeds.some((feed) => feed.kind === "online" || feed.url.includes("hunter2")), false);
assert.equal(syncedFeeds.some((feed) => feed.deviceId === feedOwnerInputId(sourceId)), true);
assert.equal(syncedFeeds.some((feed) => feed.deviceId === callsInputId(callsId)), true);
assert.equal(syncedFeeds.some((feed) => feed.deviceId === callsInputId("src.calls.blank")), true);
assert.equal(syncedFeeds.find((feed) => feed.name === "Desk scanner")?.county, "Allegheny");
const penn = syncedFeeds.find((feed) => feed.deviceId === feedOwnerInputId(sourceId));
assert.equal(penn?.county, "Allegheny");
assert.equal(penn?.state, "PA");
assert.equal(penn?.name, "Penn Hills / Plum Police Dispatch");
const again = readFeeds(syncSafetyFeeds(synced, configured).feeds);
assert.deepEqual(again, syncedFeeds);

const keptCounty = syncSafetyFeeds(
  {
    feeds: [
      {
        id: penn?.id,
        name: "East dispatch",
        kind: "audio-in",
        deviceId: feedOwnerInputId(sourceId),
        deviceLabel: "Penn Hills / Plum Police Dispatch",
        county: "Butler",
        state: "PA",
        listen: false,
      },
    ],
  },
  configured,
);
const kept = readFeeds(keptCounty.feeds).find((feed) => feed.deviceId === feedOwnerInputId(sourceId));
assert.equal(kept?.county, "Butler");
assert.equal(kept?.name, "East dispatch");
assert.equal(kept?.listen, false);

const fromBlank = readFeeds(
  syncSafetyFeeds({ radiusMi: 10, feeds: [{ id: "feed-new", name: "", kind: "audio-in", deviceId: "default", county: "", state: "" }] }, {
    [sourceId]: { type: "broadcastify.owner", params: { feedId: "47291" } },
  }).feeds,
);
assert.equal(fromBlank.length, 1);
assert.equal(fromBlank[0]?.deviceId, feedOwnerInputId(sourceId));
assert.equal(fromBlank[0]?.name, "Penn Hills / Plum Police Dispatch");
assert.equal(fromBlank.some((feed) => feed.deviceId === "default"), false);

const closed = takeFeedCaptionWindows("safety-1", sourceId);
assert.equal(closed.state, "closed");
assert.match(closed.note, /Feed Owner panel/);
assert.equal(closed.streamUrl, "");

const generation = openFeedCaptionSession({
  sourceId,
  label: "Penn Hills / Plum Police Dispatch",
  feedId: "47291",
  streamUrl: dirty,
});
const opened = readFeedCaptionHistory(sourceId);
assert.equal(opened?.streamUrl, shared);
assert.equal(opened?.streamUrl.includes("hunter2"), false);
assert.equal(takeFeedCaptionWindows("safety-1", sourceId).state, "idle");

appendFeedCaptionWindow(
  sourceId,
  generation,
  "win-1",
  [
    { id: "a", startSec: 0, endSec: 4, text: "Engine 12, structure fire, 100 Grant Street." },
    { id: "b", startSec: 4, endSec: 8, text: "  " },
  ],
  "2026-11-14T06:00:00.000Z",
);
appendFeedCaptionWindow(
  sourceId,
  generation,
  "win-2",
  [{ id: "c", startSec: 12, endSec: 16, text: "Engine 12 on scene." }],
  "2026-11-14T06:00:12.000Z",
);

const taken = takeFeedCaptionWindows("safety-1", sourceId);
assert.equal(taken.state, "ready");
assert.equal(taken.streamUrl, shared);
assert.equal(taken.windows.length, 2);
assert.deepEqual(
  taken.windows[0].lines.map((line) => line.text),
  ["Engine 12, structure fire, 100 Grant Street."],
);
assert.equal(taken.windows[1].lines[0].text, "Engine 12 on scene.");
assert.equal(takeFeedCaptionWindows("safety-1", sourceId).state, "idle");

const other = takeFeedCaptionWindows("safety-2", sourceId);
assert.equal(other.state, "ready");
assert.equal(other.windows.length, 2);

correctFeedCaptionLines(sourceId, generation, [{ id: "a", text: "Engine 12, structure fire, 100 Grant Street." }]);
assert.equal(readFeedCaptionHistory(sourceId)?.lines[0].text, "Engine 12, structure fire, 100 Grant Street.");
assert.equal(appendFeedCaptionWindow(sourceId, generation + 99, "win-x", [{ id: "z", startSec: 0, endSec: 1, text: "nope" }], "2026-11-14T06:01:00.000Z"), null);

closeFeedCaptionSession(sourceId, generation);
assert.equal(readFeedCaptionHistory(sourceId), null);
assert.equal(takeFeedCaptionWindows("safety-1", sourceId).state, "closed");

resetFeedCaptionsForTests();
