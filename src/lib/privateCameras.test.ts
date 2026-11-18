import assert from "node:assert/strict";
import { classifyPlayback, playbackHasAudio } from "./streamMedia.ts";
import { PRIVATE_BRANDS, brandId, canonicalStreamUrl, streamLinkError } from "./privateCameras.ts";

assert.equal(streamLinkError(""), "Paste the stream link from the camera system.");
assert.equal(streamLinkError("   "), "Paste the stream link from the camera system.");
assert.match(streamLinkError("rtsp://camera/stream") ?? "", /UDP or RTSP/);
assert.match(streamLinkError("udp://239.0.0.1:5000") ?? "", /UDP or RTSP/);
assert.match(streamLinkError("srt://host:9000") ?? "", /UDP or RTSP/);
assert.equal(streamLinkError("ftp://camera/snap.jpg"), "Enter an http or https link.");
assert.equal(streamLinkError("https://nvr.local/live/playlist.m3u8"), null);
assert.equal(streamLinkError("https://cam.local/snap.jpg"), null);
assert.equal(streamLinkError("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
assert.equal(streamLinkError("https://youtu.be/dQw4w9WgXcQ"), null);
assert.equal(
  canonicalStreamUrl("https://cam.local/snap.jpg"),
  "https://cam.local/snap.jpg",
);

assert.equal(classifyPlayback("https://cam.local/snap.jpg", "camera.private"), "image");
assert.equal(classifyPlayback("https://nvr.local/live/playlist.m3u8", "camera.public"), "hls");
assert.equal(
  classifyPlayback("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "camera.public"),
  "youtube",
);
assert.equal(playbackHasAudio("image"), false);
assert.equal(playbackHasAudio("youtube"), true);

assert.ok(PRIVATE_BRANDS.length >= 8);
assert.equal(PRIVATE_BRANDS[0]?.id, "custom");
for (const brand of PRIVATE_BRANDS) {
  assert.ok(brand.steps.length >= 3, brand.id);
  assert.ok(brand.placeholder.startsWith("http"), brand.id);
  assert.equal(brandId(brand.id), brand.id);
}
assert.equal(brandId("nope"), "custom");
assert.equal(brandId(undefined), "custom");

console.log("privateCameras.test.ts ok");
