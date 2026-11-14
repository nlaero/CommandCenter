import assert from "node:assert/strict";
import {
  alignAudioSlices,
  blocksCaptionDownload,
  captionsVisible,
  cleanCaptionText,
  fileCaptionWindow,
  hlsCaptionPlan,
  hlsHasEmbeddedCaptions,
  parseMediaSegments,
  playlistIsVod,
  slicesAround,
} from "./streamCaptions.ts";

const oceanCity = [
  "#EXTM3U",
  "#EXT-X-VERSION:4",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  '#EXT-X-STREAM-INF:BANDWIDTH=2540826,CODECS="avc1.64001f,mp4a.40.2",CLOSED-CAPTIONS=NONE',
  "playlist_720.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=807717,CODECS="avc1.42c015,mp4a.40.2",CLOSED-CAPTIONS=NONE',
  "playlist_270.m3u8",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac-1",NAME="Alternate Audio",AUTOSELECT=YES,DEFAULT=YES,URI="playlist_audio_en_1.m3u8"',
  "",
].join("\n");

const base = "https://cdn.example/hls/playlist.m3u8";

assert.equal(hlsHasEmbeddedCaptions(oceanCity), false);
assert.deepEqual(hlsCaptionPlan(oceanCity, base), {
  kind: "transcribe",
  audioPlaylistUrl: "https://cdn.example/hls/playlist_audio_en_1.m3u8",
  mediaPlaylistUrl: "https://cdn.example/hls/playlist_720.m3u8",
});

assert.equal(
  hlsHasEmbeddedCaptions('#EXT-X-STREAM-INF:BANDWIDTH=1,CLOSED-CAPTIONS="CC1"\nvid.m3u8\n'),
  true,
);
assert.equal(
  hlsCaptionPlan('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",URI="captions.m3u8"\n', base).kind,
  "embedded",
);
assert.equal(
  hlsHasEmbeddedCaptions("#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID=\"cc\",INSTREAM-ID=\"CC1\"\n"),
  true,
);

const video = [
  "#EXTM3U",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXTINF:6.000,",
  "playlist_720_00001.ts",
  "#EXTINF:6.000,",
  "playlist_720_00002.ts",
  "#EXT-X-ENDLIST",
].join("\n");
const audio = [
  "#EXTM3U",
  "#EXTINF:6.037,",
  "playlist_audio_en_1_00001.aac",
  "#EXTINF:6.016,",
  "playlist_audio_en_1_00002.aac",
  "#EXT-X-ENDLIST",
].join("\n");

assert.equal(playlistIsVod(video), true);
assert.equal(playlistIsVod("#EXTM3U\n#EXTINF:4,\nseg.ts\n"), false);

const aligned = alignAudioSlices(
  parseMediaSegments(video, "https://cdn.example/hls/playlist_720.m3u8"),
  parseMediaSegments(audio, "https://cdn.example/hls/playlist_audio_en_1.m3u8"),
);
assert.equal(aligned.length, 2);
assert.equal(aligned[0].startSec, 0);
assert.equal(aligned[0].durationSec, 6);
assert.equal(aligned[0].url, "https://cdn.example/hls/playlist_audio_en_1_00001.aac");
assert.equal(aligned[1].startSec, 6);
assert.equal(aligned[1].url, "https://cdn.example/hls/playlist_audio_en_1_00002.aac");
assert.equal(slicesAround(aligned, 6.2, 2)[0].startSec, 6);

assert.deepEqual(captionsVisible(true, false), true);
assert.deepEqual(captionsVisible(true, true), true);
assert.deepEqual(captionsVisible(false, true), true);
assert.deepEqual(captionsVisible(false, false), false);

assert.equal(blocksCaptionDownload("https://www.youtube.com/watch?v=abcdefghijk"), true);
assert.equal(blocksCaptionDownload("https://youtu.be/abcdefghijk"), true);
assert.equal(blocksCaptionDownload("https://music.youtube.com/watch?v=abcdefghijk"), true);
assert.equal(blocksCaptionDownload("https://rr3---sn.googlevideo.com/videoplayback"), true);
assert.equal(blocksCaptionDownload("https://cdn.example/hls/playlist.m3u8"), false);

assert.equal(cleanCaptionText("  hello   there "), "hello there");
assert.equal(cleanCaptionText("[BLANK_AUDIO]"), "");
assert.equal(cleanCaptionText("♪ ♪"), "♪ ♪");

assert.deepEqual(fileCaptionWindow(15.2, 12), { startSec: 12, durationSec: 12 });
assert.deepEqual(fileCaptionWindow(0, 12), { startSec: 0, durationSec: 12 });

const mediaOnly = hlsCaptionPlan("#EXTM3U\n#EXTINF:4,\nseg.ts\n", "https://cdn.example/live.m3u8");
assert.deepEqual(mediaOnly, {
  kind: "transcribe",
  audioPlaylistUrl: null,
  mediaPlaylistUrl: null,
});
