import assert from "node:assert/strict";
import { programAudioSources, syncSafetyFeeds } from "./feedCaptions.ts";
import { readFeeds } from "./safety.ts";
import {
  PREVIEW_INPUTS,
  appendCaptionLines,
  captionFollowAfterScroll,
  captionListAtLatest,
  captionsWithMemory,
  classifyLocalInput,
  localAudioSaveError,
  previewToneWav,
} from "./localAudio.ts";

assert.equal(classifyLocalInput("alsa_input.pci-0000_00_1f.3.analog-stereo", "Analog stereo"), "jack");
assert.equal(classifyLocalInput("bluez_input.AA_BB_CC_DD_EE_FF", "Galaxy buds"), "bluetooth");
assert.equal(classifyLocalInput("alsa_output.pci.analog-stereo.monitor", "Monitor of analog"), null);
assert.equal(classifyLocalInput("Microphone Array (Intel Smart Sound)", "Microphone Array (Intel Smart Sound)"), null);
assert.equal(classifyLocalInput("Microphone (Realtek(R) Audio)", "Microphone (Realtek(R) Audio)"), "jack");
assert.equal(classifyLocalInput("Headset (Bluetooth Hands-Free)", "Headset (Bluetooth Hands-Free)"), "bluetooth");
assert.equal(classifyLocalInput("Line In (Realtek High Definition Audio)", "Line In"), "jack");
assert.equal(classifyLocalInput("default", "Default input"), null);
assert.equal(classifyLocalInput("preview-jack", "Line in (jack)"), "jack");
assert.equal(classifyLocalInput("preview-bluetooth", "Bluetooth headset"), "bluetooth");

assert.equal(localAudioSaveError({}), "Choose a jack or Bluetooth input.");
assert.equal(localAudioSaveError({ deviceId: "default", deviceLabel: "Default input" }), "Choose a jack or Bluetooth input.");
assert.equal(
  localAudioSaveError({ deviceId: "preview-jack", deviceLabel: "Line in (jack)", inputKind: "jack" }),
  null,
);
assert.equal(localAudioSaveError({ deviceId: "bluez_input.AA", deviceLabel: "Headset" }), null);

assert.equal(captionListAtLatest(0, 400, 100), false);
assert.equal(captionListAtLatest(276, 400, 100), false);
assert.equal(captionListAtLatest(277, 400, 100), true);
assert.equal(captionListAtLatest(0, 80, 100), true);
assert.equal(
  captionFollowAfterScroll({ following: true, userScrolled: true, atLatest: false }),
  false,
);
assert.equal(
  captionFollowAfterScroll({ following: false, userScrolled: true, atLatest: true }),
  true,
);
assert.equal(
  captionFollowAfterScroll({ following: true, userScrolled: false, atLatest: false }),
  true,
);

const keep = (text: string) => text;
const fixClear = (text: string) => text.replace(/channel clear/g, "channel two");

const first = appendCaptionLines(
  [],
  [{ text: "Scanner check, channel clear.", startSec: 0, endSec: 3 }],
  0,
  "win-0",
  keep,
);
assert.equal(first.added, 1);
assert.equal(first.lines[0]?.text, "Scanner check, channel clear.");

const second = appendCaptionLines(
  first.lines,
  [
    { text: "Copy, channel clear.", startSec: 0, endSec: 2 },
    { text: "[BLANK_AUDIO]", startSec: 2, endSec: 3 },
  ],
  12,
  "win-1",
  fixClear,
);
assert.equal(second.added, 1);
assert.equal(second.lines[0]?.text, "Scanner check, channel clear.");
assert.equal(second.lines[0]?.source, "Scanner check, channel clear.");
assert.equal(second.lines[1]?.text, "Copy, channel two.");
assert.equal(second.lines[1]?.source, "Copy, channel clear.");
assert.equal(second.lines[1]?.startSec, 12);

const shown = captionsWithMemory(second.lines, fixClear);
assert.equal(shown[0]?.text, "Scanner check, channel two.");
assert.equal(shown[1]?.text, "Copy, channel two.");
assert.equal(captionsWithMemory(shown, fixClear)[0]?.text, "Scanner check, channel two.");

const many = appendCaptionLines(
  [],
  Array.from({ length: 130 }, (_, index) => ({ text: `Line ${index}`, startSec: 0, endSec: 1 })),
  0,
  "bulk",
);
assert.equal(many.lines.length, 120);
assert.equal(many.lines[0]?.text, "Line 10");
assert.equal(many.lines.at(-1)?.text, "Line 129");

const tone = previewToneWav();
assert.equal(String.fromCharCode(...tone.slice(0, 4)), "RIFF");
assert.equal(String.fromCharCode(...tone.slice(8, 12)), "WAVE");

const sources = {
  "src.local.1": {
    type: "audio.local",
    params: { deviceId: PREVIEW_INPUTS[0]?.id, deviceLabel: "Line in (jack)", inputKind: "jack" },
  },
};
assert.equal(programAudioSources(sources).length, 0);
const synced = readFeeds(syncSafetyFeeds({ feeds: [] }, sources).feeds);
assert.equal(synced.length, 1);
assert.notEqual(synced[0]?.deviceId, "preview-jack");

console.log("localAudio.test.ts ok");
