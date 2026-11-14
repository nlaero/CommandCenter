import assert from "node:assert/strict";
import { describeError, locationFailure } from "./location.ts";

const address = "No place matched that address. Try a street, city, and region.";

assert.equal(locationFailure({ message: address }), address);
assert.equal(locationFailure({ message: { message: "Type an address first." } }), "Type an address first.");
assert.equal(locationFailure(new Error("That address is too long.")), "That address is too long.");
assert.equal(
  locationFailure('{"message":"No place matched that address. Try a street, city, and region."}'),
  address,
);
assert.equal(locationFailure({ message: "[object Object]", error: address }), address);
assert.equal(locationFailure({ message: "[object Object]" }), "Command Center could not confirm a location.");
assert.equal(describeError({ lat: 1, lon: 2 }, "fallback"), "fallback");
assert.equal(locationFailure({ message: address }).includes("[object Object]"), false);
assert.equal(String({ message: address }), "[object Object]");

console.log("location.test.ts ok");
