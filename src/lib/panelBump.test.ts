import assert from "node:assert/strict";
import { cloneLayout, moveElement, noCompactor } from "react-grid-layout/core";
import { settleCoveredPanels, type PanelRect } from "./panelBump.ts";

function rect(i: string, x: number, y: number, w: number, h: number): PanelRect {
  return { i, x, y, w, h };
}

function yOf(items: readonly PanelRect[], id: string): number {
  const item = items.find((entry) => entry.i === id);
  assert.ok(item, id);
  return item.y;
}

/** Place the mover where the pointer is, then settle from the drag-start layout. */
function drag(baseline: PanelRect[], moverId: string, x: number, y: number): readonly PanelRect[] {
  const live = baseline.map((item) => ({ ...item }));
  const mover = live.find((item) => item.i === moverId);
  assert.ok(mover);
  mover.x = x;
  mover.y = y;
  return settleCoveredPanels(live, baseline, moverId);
}

const stacked = [
  rect("A", 0, 0, 4, 10),
  rect("B", 0, 10, 4, 10),
  rect("C", 0, 20, 4, 10),
  rect("D", 0, 30, 4, 10),
];

const nudged = drag(stacked, "A", 0, 1);
assert.equal(yOf(nudged, "A"), 1);
assert.equal(yOf(nudged, "B"), 11);
assert.equal(yOf(nudged, "C"), 21);
assert.equal(yOf(nudged, "D"), 31);

const shoved = drag(stacked, "A", 0, 1);
assert.notEqual(yOf(shoved, "B"), 10 + 10);

const frame = drag(stacked, "A", 0, 2);
assert.equal(yOf(frame, "B"), 12);
const again = frame.map((item) => ({ ...item }));
const mover = again.find((item) => item.i === "A");
assert.ok(mover);
mover.y = 3;
settleCoveredPanels(again, stacked, "A");
assert.equal(yOf(again, "B"), 13);

const back = drag(stacked, "A", 0, 0);
assert.equal(yOf(back, "B"), 10);
assert.equal(yOf(back, "C"), 20);

const beside = [
  rect("A", 0, 0, 8, 6),
  rect("B", 0, 6, 4, 4),
  rect("C", 4, 6, 4, 4),
  rect("D", 0, 16, 4, 4),
];
const side = drag(beside, "A", 0, 1);
assert.equal(yOf(side, "B"), 7);
assert.equal(yOf(side, "C"), 7);
assert.equal(yOf(side, "D"), 16);

const neighbor = [rect("T", 0, 0, 4, 20), rect("A", 4, 0, 4, 6), rect("B", 2, 6, 4, 4)];
const cleared = drag(neighbor, "A", 4, 2);
assert.equal(yOf(cleared, "T"), 0);
assert.equal(yOf(cleared, "A"), 2);
assert.equal(yOf(cleared, "B"), 20);

const elsewhere = [rect("A", 0, 0, 2, 2), rect("B", 10, 0, 4, 6), rect("C", 10, 4, 4, 6)];
const untouched = drag(elsewhere, "A", 0, 1);
assert.equal(yOf(untouched, "B"), 0);
assert.equal(yOf(untouched, "C"), 4);

const hanging = [rect("A", 0, 0, 4, 20), rect("B", 0, 10, 4, 8)];
const flush = drag(hanging, "A", 0, 9);
assert.equal(yOf(flush, "A"), 9);
assert.equal(yOf(flush, "B"), 29);

const lifted = [rect("U", 0, 0, 4, 10), rect("L", 0, 10, 4, 10)];
const crossed = drag(lifted, "L", 0, 8);
assert.equal(yOf(crossed, "L"), 8);
assert.equal(yOf(crossed, "U"), 18);

assert.equal(settleCoveredPanels([rect("A", 0, 0, 1, 1)], null, "A")[0]?.y, 0);

function gridMove(layout: PanelRect[], y: number, allowOverlap: boolean): PanelRect[] {
  const current = cloneLayout(layout);
  const item = current.find((entry) => entry.i === "A");
  assert.ok(item);
  return moveElement(
    current,
    item,
    0,
    y,
    true,
    noCompactor.preventCollision ?? false,
    noCompactor.type,
    48,
    allowOverlap,
  );
}

const library = gridMove(stacked, 1, false);
assert.equal(yOf(library, "A"), 10);
assert.equal(yOf(library, "B"), 20);

const start = stacked.map((item) => ({ ...item }));
let live = stacked.map((item) => ({ ...item }));
for (const y of [1, 2, 3]) {
  const next = gridMove(live, y, true);
  settleCoveredPanels(next, start, "A");
  live = next.map((item) => ({ ...item }));
}
assert.equal(yOf(live, "A"), 3);
assert.equal(yOf(live, "B"), 13);
assert.equal(yOf(live, "C"), 23);
assert.equal(yOf(live, "D"), 33);

const restored = gridMove(live, 0, true);
settleCoveredPanels(restored, start, "A");
assert.equal(yOf(restored, "A"), 0);
assert.equal(yOf(restored, "B"), 10);
assert.equal(yOf(restored, "C"), 20);
assert.equal(yOf(restored, "D"), 30);

console.log("panel bump ok");
