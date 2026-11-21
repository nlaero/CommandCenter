import assert from "node:assert/strict";
import {
  applyFeedSound,
  directStreamStarted,
  nextFeedMute,
  playDecodedWindows,
  playbackErrorText,
  watchDirectPlayback,
} from "./feedPlayback.ts";

assert.equal(directStreamStarted(0, 0.2, false), true);
assert.equal(directStreamStarted(4, 4.1, false), false);
assert.equal(directStreamStarted(0, 5, true), false);

assert.deepEqual(nextFeedMute({ muted: false, volume: 0 }), { muted: false, volume: 1 });
assert.deepEqual(nextFeedMute({ muted: true, volume: 0 }), { muted: true, volume: 0 });
assert.deepEqual(nextFeedMute({ muted: false, volume: 0.4 }), { muted: false, volume: 0.4 });

{
  let played = 0;
  const el = {
    muted: true,
    volume: 0,
    play: () => {
      played += 1;
      return Promise.resolve();
    },
  };
  applyFeedSound(el, true);
  assert.equal(el.muted, false);
  assert.equal(el.volume, 1);
  assert.equal(played, 1);
  applyFeedSound(el, false);
  assert.equal(el.muted, true);
  assert.equal(played, 1);
}

assert.equal(
  playbackErrorText('{"message":"The relay refused the audio (HTTP 403). Audio was not uploaded."}'),
  "The relay refused the audio (HTTP 403). Audio was not uploaded.",
);
assert.equal(playbackErrorText(""), "Couldn't play the relay.");

{
  const outcome = await watchDirectPlayback({
    sample: () => ({ currentTime: 0, errored: true }),
    baseline: 0,
    waitMs: 5_000,
    cancelled: () => false,
  });
  assert.equal(outcome, "failed");
}

{
  let reads = 0;
  let plays = 0;
  let live = true;
  await playDecodedWindows({
    read: async () => {
      reads += 1;
      return new Uint8Array([reads]);
    },
    play: async (bytes) => {
      plays += 1;
      assert.equal(bytes[0], plays);
      live = false;
    },
    live: () => live,
  });
  assert.equal(plays, 1);
  assert.equal(reads, 2);
}
