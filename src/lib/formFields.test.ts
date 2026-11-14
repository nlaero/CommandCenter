import assert from "node:assert/strict";
import { booleanFieldChecked } from "./formFields.ts";

const on = { defaultChecked: true };
const off = { defaultChecked: false };

assert.equal(booleanFieldChecked(on, undefined), true);
assert.equal(booleanFieldChecked(on, null), true);
assert.equal(booleanFieldChecked(on, false), false);
assert.equal(booleanFieldChecked(on, "false"), false);
assert.equal(booleanFieldChecked(on, "off"), false);
assert.equal(booleanFieldChecked(off, undefined), false);
assert.equal(booleanFieldChecked(off, true), true);
assert.equal(booleanFieldChecked(off, "yes"), true);
console.log("formFields.test.ts ok");
