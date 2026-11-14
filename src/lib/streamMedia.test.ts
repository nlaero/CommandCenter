import assert from "node:assert/strict";
import {
  absolutizePlaylist,
  classifyPlayback,
  prefersChannelLive,
  youtubeChannelId,
  youtubeEmbedSrc,
  youtubeFromPage,
  youtubeVideoId,
} from "./streamMedia.ts";

const master = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=2540826,RESOLUTION=1280x720",
  "playlist_720.m3u8",
  "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac-1\",URI=\"playlist_audio_en_1.m3u8\"",
  "",
].join("\n");

const absolute = absolutizePlaylist(
  master,
  "https://cdn.example/a30/hls/de3f/playlist.m3u8",
);
assert.match(absolute, /https:\/\/cdn\.example\/a30\/hls\/de3f\/playlist_720\.m3u8/);
assert.match(absolute, /URI="https:\/\/cdn\.example\/a30\/hls\/de3f\/playlist_audio_en_1\.m3u8"/);
assert.equal(absolute.includes("\nplaylist_720.m3u8"), false);

const kept = absolutizePlaylist(
  "#EXTM3U\nhttps://cdn.example/already.ts\n",
  "https://cdn.example/hls/playlist.m3u8",
);
assert.match(kept, /https:\/\/cdn\.example\/already\.ts/);

assert.equal(
  classifyPlayback(
    "https://cdn.flowplayer.com/a30bd6bc-f98b-47bc-abf5-97633d4faea0/hls/de3f6ca7-2db3-4689-8160-0f574a5996ad/playlist.m3u8",
  ),
  "hls",
);
assert.equal(classifyPlayback("https://cam.example/snap.jpg"), "image");
assert.equal(classifyPlayback("https://cam.example/clip.mp4"), "file");
assert.equal(classifyPlayback("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
assert.equal(classifyPlayback("https://youtu.be/dQw4w9WgXcQ", "camera.http_image"), "youtube");
assert.equal(classifyPlayback("not a url", "video.youtube"), "youtube");

assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=12"), "dQw4w9WgXcQ");
assert.equal(youtubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(
  youtubeVideoId("https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live"),
  null,
);
assert.equal(
  youtubeChannelId("https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live"),
  "UCLA_DiR1FfKNvjuUpBHmylQ",
);
assert.equal(prefersChannelLive("https://www.youtube.com/@NASA/live"), true);
assert.equal(prefersChannelLive("https://www.youtube.com/live/dQw4w9WgXcQ"), false);

const embed = youtubeEmbedSrc("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "http://localhost:1420");
assert.ok(embed?.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?"));
assert.match(embed ?? "", /mute=1/);
assert.match(embed ?? "", /cc_load_policy=1/);
assert.match(embed ?? "", /origin=http%3A%2F%2Flocalhost%3A1420/);

const channel = youtubeEmbedSrc("https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live");
assert.match(channel ?? "", /embed\/live_stream\?/);
assert.match(channel ?? "", /channel=UCLA_DiR1FfKNvjuUpBHmylQ/);

const page = youtubeFromPage(
  `<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk"><script>"channelId":"UCLA_DiR1FfKNvjuUpBHmylQ"</script>`,
);
assert.equal(page.videoId, "abcdefghijk");
assert.equal(page.channelId, "UCLA_DiR1FfKNvjuUpBHmylQ");

const livePage = youtubeFromPage(
  `"videoId":"aaaaaaaaaaa" watch?v=bbbbbbbbbbb "videoId":"FX6GYpj-PnA" "isLive":true "channelId":"UCLA_DiR1FfKNvjuUpBHmylQ"`,
);
assert.equal(livePage.videoId, "FX6GYpj-PnA");

console.log("stream media checks ok");
