import assert from "node:assert/strict";
import { applyCorrections, emptyMemory, mergeMemory, upsertCorrection } from "./aiMemory.ts";

const engine = upsertCorrection(emptyMemory(), "engine twelve", "Engine 12");
assert.equal(applyCorrections("Engine Twelve responding", engine), "Engine 12 responding");

const unit = upsertCorrection(emptyMemory(), "unit", "Engine 12");
assert.equal(applyCorrections("the unit is holding", unit), "the Engine 12 is holding");
assert.equal(applyCorrections("community meeting", unit), "community meeting");

const medic = upsertCorrection(emptyMemory(), "medic four", "Medic 4");
const merged = mergeMemory(medic, engine);
assert.equal(merged.corrections.length, 2);

const stronger = upsertCorrection(emptyMemory(), "engine twelve", "E12");
stronger.corrections[0].count = 1;
const remote = upsertCorrection(emptyMemory(), "engine twelve", "Engine 12");
remote.corrections[0].count = 4;
const kept = mergeMemory(stronger, remote);
assert.equal(kept.corrections[0].says, "Engine 12");
assert.equal(kept.corrections[0].count, 4);

console.log("ai memory checks ok");
