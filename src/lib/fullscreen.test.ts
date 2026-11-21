import assert from "node:assert/strict";
import { fullscreenKeyAction } from "./fullscreen.ts";

const plain = { alt: false, ctrl: false, meta: false, shift: false };

assert.equal(fullscreenKeyAction("F11", false, plain), "enter");
assert.equal(fullscreenKeyAction("F11", true, plain), "exit");
assert.equal(fullscreenKeyAction("Escape", false, plain), null);
assert.equal(fullscreenKeyAction("Escape", true, plain), "exit");
assert.equal(fullscreenKeyAction("Escape", true, { ...plain, shift: true }), null);
assert.equal(fullscreenKeyAction("F11", false, { ...plain, ctrl: true }), null);
assert.equal(fullscreenKeyAction("e", true, plain), null);
