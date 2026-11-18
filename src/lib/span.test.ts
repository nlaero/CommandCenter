import assert from "node:assert/strict";
import {
  displayWallSummary,
  spanRows,
  splitPanels,
  televisionWallDecision,
  type SpanBox,
  type WallScreen,
} from "./span.ts";

function screen(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  current = false,
): WallScreen {
  return {
    id,
    name: id,
    x,
    y,
    width,
    height,
    current,
    sharp: width >= 3840 && height >= 2160,
  };
}

function panel(i: string, x: number, y: number, w: number, h: number): SpanBox {
  return { i, x, y, w, h, minW: 6, minH: 8 };
}

const cols = 48;
const rows = 32;

const sideBySide = splitPanels(
  [
    panel("left", 0, 0, 16, 14),
    panel("right", 30, 2, 10, 8),
    panel("straddle", 20, 0, 16, 10),
  ],
  [screen("left-screen", 0, 0, 1920, 1080), screen("right-screen", 1920, 0, 1920, 1080)],
  cols,
  rows,
);

const leftSlice = sideBySide.slices.find((item) => item.id === "left-screen");
const rightSlice = sideBySide.slices.find((item) => item.id === "right-screen");
assert.ok(leftSlice);
assert.ok(rightSlice);
assert.equal(leftSlice.colStart, 0);
assert.equal(leftSlice.colCount, 24);
assert.equal(rightSlice.colStart, 24);
assert.equal(rightSlice.colCount, 24);
assert.equal(leftSlice.rowCount, rows);
assert.equal(rightSlice.rowCount, rows);

const leftItems = sideBySide.panels.find((item) => item.id === "left-screen")?.items ?? [];
const rightItems = sideBySide.panels.find((item) => item.id === "right-screen")?.items ?? [];
assert.deepEqual(
  leftItems.map((item) => item.i),
  ["left"],
);
assert.deepEqual(
  rightItems.map((item) => item.i),
  ["right", "straddle"],
);
assert.equal(leftItems.length + rightItems.length, 3);

const moved = rightItems.find((item) => item.i === "right");
assert.equal(moved?.x, 6);
assert.equal(moved?.y, 2);
assert.equal(moved?.w, 10);

const clipped = rightItems.find((item) => item.i === "straddle");
assert.equal(clipped?.x, 0);
assert.ok((clipped?.w ?? 0) <= rightSlice.colCount);
assert.ok((clipped?.x ?? 0) + (clipped?.w ?? 0) <= rightSlice.colCount);

const wide = splitPanels(
  [panel("wide-left", 0, 0, 10, 8), panel("wide-right", 20, 0, 10, 8)],
  [screen("narrow", 0, 0, 1920, 1080), screen("wide", 1920, 0, 3840, 1080, true)],
  cols,
  rows,
);
const narrow = wide.slices.find((item) => item.id === "narrow");
const wider = wide.slices.find((item) => item.id === "wide");
assert.equal(narrow?.colCount, 16);
assert.equal(wider?.colCount, 32);
assert.equal((narrow?.colCount ?? 0) + (wider?.colCount ?? 0), cols);

const stacked = splitPanels(
  [panel("top", 0, 0, 12, 8), panel("bottom", 0, 20, 12, 8)],
  [screen("top-screen", 0, 0, 3840, 2160), screen("bottom-screen", 0, 2160, 3840, 2160)],
  cols,
  rows,
);
assert.equal(stacked.slices.find((item) => item.id === "top-screen")?.rowCount, 16);
assert.equal(stacked.slices.find((item) => item.id === "bottom-screen")?.rowStart, 16);
assert.deepEqual(
  stacked.panels.find((item) => item.id === "top-screen")?.items.map((item) => item.i),
  ["top"],
);
assert.deepEqual(
  stacked.panels.find((item) => item.id === "bottom-screen")?.items.map((item) => item.i),
  ["bottom"],
);

const quad = [
  screen("tl", 0, 0, 1920, 1080),
  screen("tr", 1920, 0, 1920, 1080),
  screen("bl", 0, 1080, 1920, 1080),
  screen("br", 1920, 1080, 1920, 1080),
];
const quadSplit = splitPanels(
  [
    panel("a", 2, 2, 8, 8),
    panel("b", 30, 2, 8, 8),
    panel("c", 2, 20, 8, 8),
    panel("d", 30, 20, 8, 8),
  ],
  quad,
  cols,
  rows,
);
const seen = quadSplit.panels.flatMap((entry) => entry.items.map((item) => item.i));
assert.deepEqual(seen.sort(), ["a", "b", "c", "d"]);
assert.equal(new Set(seen).size, 4);
for (const entry of quadSplit.panels) {
  const slice = quadSplit.slices.find((item) => item.id === entry.id);
  assert.ok(slice);
  for (const item of entry.items) {
    assert.ok(item.x >= 0 && item.y >= 0);
    assert.ok(item.x + item.w <= slice.colCount);
    assert.ok(item.y + item.h <= slice.rowCount);
    assert.ok((item.minW ?? 1) <= slice.colCount);
    assert.ok((item.minH ?? 1) <= slice.rowCount);
  }
}

const gapped = splitPanels(
  [panel("near-left", 4, 0, 8, 8), panel("near-right", 36, 0, 8, 8)],
  [screen("gap-left", 0, 0, 1000, 1000), screen("gap-right", 2000, 0, 1000, 1000)],
  cols,
  rows,
);
assert.equal(gapped.panels.find((item) => item.id === "gap-left")?.items[0]?.i, "near-left");
assert.equal(gapped.panels.find((item) => item.id === "gap-right")?.items[0]?.i, "near-right");

const only = splitPanels(
  [panel("solo", 4, 1, 12, 10)],
  [screen("only", 0, 0, 1920, 1080, true)],
  cols,
  rows,
);
assert.equal(only.slices[0]?.colCount, cols);
assert.equal(only.panels[0]?.items[0]?.x, 4);
assert.equal(only.panels[0]?.items[0]?.w, 12);

assert.equal(spanRows([]), 1);
assert.equal(spanRows([{ y: 10, h: 14 }]), 24);

const refused = televisionWallDecision([
  { name: "Samsung", width: 1920, height: 1080, current: false, sharp: false },
  { name: "LG", width: 3840, height: 2160, current: false, sharp: true },
]);
assert.equal(refused.ok, false);
assert.match(refused.reason, /1920 × 1080/);
assert.match(refused.reason, /58-inch/);
assert.match(refused.reason, /3840 × 2160/);

const computer = televisionWallDecision([
  { name: "Built-in", width: 3840, height: 2160, current: true, sharp: true },
  { name: "LG", width: 3840, height: 2160, current: false, sharp: true },
]);
assert.equal(computer.ok, false);
assert.match(computer.reason, /Setup stays here/);

const wall = televisionWallDecision([
  { name: "LG", width: 3840, height: 2160, current: false, sharp: true },
  { name: "Sony", width: 3840, height: 2160, current: false, sharp: true },
]);
assert.equal(wall.ok, true);
assert.match(wall.reason, /splits across 2 screens/);
assert.match(wall.reason, /Setup stays on this computer/);

const desk = displayWallSummary([
  { name: "Built-in", width: 1920, height: 1080, current: true, sharp: false },
  { name: "Dell", width: 1920, height: 1080, current: false, sharp: false },
]);
assert.match(desk, /shows its part and keeps setup/);
assert.match(desk, /Dell is 1920 × 1080/);
assert.match(desk, /58-inch/);

assert.equal(
  displayWallSummary([{ name: "Built-in", width: 1920, height: 1080, current: true, sharp: false }]),
  "The board stays in this window.",
);
