import assert from "node:assert/strict";
import { fittedStillBox } from "./fittedStill.ts";

const wideMain = fittedStillBox(1600, 900, 4 / 3);
assert.equal(wideMain.height, 900);
assert.ok(Math.abs(wideMain.width / wideMain.height - 4 / 3) < 1e-9);
assert.ok(wideMain.width < 1600);

const widescreen = fittedStillBox(1600, 900, 16 / 9);
assert.equal(widescreen.width, 1600);
assert.ok(Math.abs(widescreen.height - 900) < 1e-9);

const tall = fittedStillBox(480, 900, 16 / 9);
assert.equal(tall.width, 480);
assert.ok(tall.height < 900);
assert.ok(Math.abs(tall.width / tall.height - 16 / 9) < 1e-9);

const shortStrip = fittedStillBox(1400, 120, 4 / 3);
assert.equal(shortStrip.height, 120);
assert.ok(shortStrip.width < 1400);
assert.ok(Math.abs(shortStrip.width / shortStrip.height - 4 / 3) < 1e-9);

assert.deepEqual(fittedStillBox(0, 900, 4 / 3), { width: 0, height: 0 });
assert.deepEqual(fittedStillBox(1600, 0, 4 / 3), { width: 0, height: 0 });
assert.deepEqual(fittedStillBox(1600, 900, 0), { width: 0, height: 0 });
assert.deepEqual(fittedStillBox(Number.NaN, 900, 4 / 3), { width: 0, height: 0 });
