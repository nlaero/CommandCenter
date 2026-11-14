import assert from "node:assert/strict";
import { captionFailureText } from "./captionFailure.ts";

const relay = "The relay refused the audio (HTTP 403). Audio was not uploaded.";
const missing =
  "Local AI is not installed. Settings → Local AI downloads Tiny English onto this computer. Audio stays here.";
const model = "The local model could not transcribe that clip. failed to load ggml model";

assert.equal(captionFailureText(new Error(relay)), relay);
assert.equal(captionFailureText({ message: missing }), missing);
assert.equal(captionFailureText(model), model);
assert.equal(captionFailureText(JSON.stringify({ message: relay })), relay);
assert.equal(captionFailureText({ error: { message: model } }), model);
assert.equal(
  captionFailureText({ message: { foo: 1 } }),
  "Couldn't create captions on this device.",
);
assert.equal(
  captionFailureText(new Error("[object Object]")),
  "Couldn't create captions on this device.",
);
assert.equal(captionFailureText("[object Object]"), "Couldn't create captions on this device.");
assert.equal(
  captionFailureText({ message: "[object Object]" }),
  "Couldn't create captions on this device.",
);
