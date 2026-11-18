import assert from "node:assert/strict";
import { programAudioSources } from "./feedCaptions.ts";
import {
  normalizeWebScannerUrl,
  scannerCaptionWindow,
  scannerPlayback,
  streamHost,
  webScannerUrlError,
} from "./webScanner.ts";

const live = "http://radio.example:8000/scanner";
assert.equal(webScannerUrlError(live), null);
assert.equal(scannerPlayback(live), "live");
assert.deepEqual(scannerCaptionWindow(live, 0), { seekSec: 0, timelineStart: 0, durationSec: 12 });
assert.deepEqual(scannerCaptionWindow(live, 2), { seekSec: 0, timelineStart: 24, durationSec: 12 });

const file = "https://cdn.example/clip.mp3";
assert.equal(webScannerUrlError(file), null);
assert.equal(scannerPlayback(file), "file");
assert.deepEqual(scannerCaptionWindow(file, 1), { seekSec: 12, timelineStart: 12, durationSec: 12 });

assert.equal(scannerPlayback("https://cdn.example/live.m3u8"), "hls");
assert.equal(scannerPlayback("https://cdn.example/live.m3u8?token=1"), "hls");
assert.equal(webScannerUrlError("  https://cdn.example/feed.aac  "), null);
assert.equal(normalizeWebScannerUrl("http://radio.example/stream#now"), "http://radio.example/stream");
assert.equal(streamHost(live), "radio.example:8000");

assert.match(
  webScannerUrlError("https://www.broadcastify.com/listen/feed/47291") ?? "",
  /Feed Owner/,
);
assert.match(webScannerUrlError("http://relay.broadcastify.com/136068518") ?? "", /Feed Owner/);
assert.match(webScannerUrlError("https://api.bcfy.io/calls/v1/live/") ?? "", /Calls/);
assert.match(webScannerUrlError("https://www.youtube.com/watch?v=dQw4w9WgXcQ") ?? "", /YouTube/);
assert.match(webScannerUrlError("ftp://radio.example/stream") ?? "", /http or https/);
assert.match(webScannerUrlError("not a url") ?? "", /http or https/);
assert.match(webScannerUrlError("") ?? "", /Enter the stream link/);
assert.match(webScannerUrlError("https://example.com/listen.html") ?? "", /web page/);
assert.match(webScannerUrlError("https://example.com/station.pls") ?? "", /playlist/);
assert.match(webScannerUrlError("http://user:secret@radio.example/stream") ?? "", /password/);

const listed = programAudioSources({
  "src.web.1": {
    type: "scanner.web",
    params: { label: "North", url: live },
  },
  "src.owner.1": {
    type: "broadcastify.owner",
    params: { preset: "custom", feedId: "99" },
  },
});
assert.equal(
  listed.some((item) => item.id === "src.web.1"),
  false,
);
assert.equal(listed.some((item) => item.id === "src.owner.1"), true);

console.log("webScanner.test.ts ok");
