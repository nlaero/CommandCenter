import assert from "node:assert/strict";
import {
  appendFeedCaptionWindow,
  broadcastifyAudioInputs,
  closeFeedCaptionSession,
  correctFeedCaptionLines,
  feedOwnerInputId,
  isContinuousAudioStream,
  isFeedOwnerAudio,
  liveCaptionWindow,
  openFeedCaptionSession,
  parseFeedOwnerInputId,
  publicStreamUrl,
  readFeedCaptionHistory,
  resetFeedCaptionsForTests,
  takeFeedCaptionWindows,
} from "./feedCaptions.ts";

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

assert.deepEqual(
  broadcastifyAudioInputs({
    "src.weather.1": { type: "weather.openmeteo", params: {} },
    [sourceId]: { type: "broadcastify.owner", params: { preset: "penn-hills", feedId: "47291" } },
    "src.owner.custom1": { type: "broadcastify.owner", params: { preset: "custom", feedId: "99" } },
  }).map((item) => item.label),
  ["Feed 99 · captions", "Penn Hills / Plum Police Dispatch · captions"],
);

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
