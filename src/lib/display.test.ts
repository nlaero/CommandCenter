import assert from "node:assert/strict";
import { tvRowHeight } from "./cast.ts";
import {
  applyDisplayPrefs,
  boardGridMetrics,
  clampBoardDensity,
  gridBlockHeight,
  panelsThatFit,
  readDisplayPrefs,
} from "./display.ts";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  },
  configurable: true,
});

const layout = { cols: 48, rowHeight: 12, margin: [4, 4] as [number, number] };

assert.equal(clampBoardDensity(undefined), 1);
assert.equal(clampBoardDensity("dense"), 0.5);
assert.equal(clampBoardDensity("larger"), 1.35);
assert.equal(clampBoardDensity(9), 1.5);
assert.equal(clampBoardDensity(0.1), 0.45);

const standard = boardGridMetrics(layout, 1);
assert.equal(standard.rowHeight, 12);
assert.deepEqual(standard.margin, [4, 4]);
assert.equal(standard.padding, 8);

const dense = boardGridMetrics(layout, 0.5);
assert.equal(dense.rowHeight, 6);
assert.ok(dense.rowHeight < standard.rowHeight);

const larger = boardGridMetrics(layout, 1.35);
assert.equal(larger.rowHeight, 16);
assert.ok(larger.rowHeight > standard.rowHeight);
assert.ok(gridBlockHeight(14, 1.35) > gridBlockHeight(14, 1));

const windowPx = 860;
const standardFit = panelsThatFit(14, windowPx, 1);
const denseFit = panelsThatFit(14, windowPx, 0.5);
const largerFit = panelsThatFit(14, windowPx, 1.35);
assert.equal(standardFit, 3);
assert.ok(denseFit > 3);
assert.ok(denseFit > standardFit);
assert.ok(largerFit < standardFit);

assert.equal(tvRowHeight(12, 32, 2160), 63);
assert.equal(tvRowHeight(12, 1, 2160), 160);
assert.equal(tvRowHeight(12, 40, 400), 8);
assert.equal(tvRowHeight(12, 32, 2160, 1), 63);

const standardTv = tvRowHeight(12, 66, 2160, 1);
const denseTv = tvRowHeight(12, 66, 2160, 0.5);
assert.ok(denseTv < standardTv);
assert.ok(denseTv <= 16);
assert.equal(tvRowHeight(12, 1, 2160, 1.35), 200);
assert.ok(tvRowHeight(12, 32, 2160, 1.35) >= tvRowHeight(12, 32, 2160));

const six = 22 * 6;
const cell = tvRowHeight(12, six, 2160, 0.5);
const chrome = 4 * 2 + 2 * (six - 1);
assert.ok(six * cell + chrome <= 2160);

memory.set(
  "command-center.display.v1",
  JSON.stringify({ mode: "fixed", width: 1920, height: 1080, label: "1920 × 1080" }),
);
assert.equal(readDisplayPrefs().density, 1);
assert.equal(readDisplayPrefs().width, 1920);

const saved = await applyDisplayPrefs({ ...readDisplayPrefs(), density: 0.5 });
assert.equal(saved.density, 0.5);
assert.equal(readDisplayPrefs().width, 1920);
assert.deepEqual(readDisplayPrefs().screens, []);

const withScreens = await applyDisplayPrefs({
  ...readDisplayPrefs(),
  screens: ["hdmi", " hdmi ", "", "tv"],
});
assert.deepEqual(withScreens.screens, ["hdmi", "tv"]);
assert.equal(withScreens.density, 0.5);

const sized = await applyDisplayPrefs({
  ...readDisplayPrefs(),
  mode: "fixed",
  width: 1600,
  height: 900,
  label: "Custom",
});
assert.equal(sized.density, 0.5);
assert.equal(sized.width, 1600);
assert.equal(sized.height, 900);
assert.deepEqual(sized.screens, ["hdmi", "tv"]);
