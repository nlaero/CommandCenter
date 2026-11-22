import assert from "node:assert/strict";
import { updateProgressLabel, updateProgressPercent, type UpdateProgress } from "./updateProgress.ts";

const downloading: UpdateProgress = {
  product: "command-center",
  phase: "downloading",
  received: 50,
  total: 100,
};

assert.equal(updateProgressPercent(downloading), 50);
assert.equal(updateProgressLabel(downloading), "Downloading 50%");
assert.equal(
  updateProgressLabel({ ...downloading, received: 0, total: null }),
  "Downloading…",
);
assert.equal(
  updateProgressLabel({ ...downloading, received: 2.5 * 1024 * 1024, total: null }),
  "Downloading 2.5 MB",
);
assert.equal(
  updateProgressLabel({ ...downloading, phase: "closing" }),
  "Closing Command Center so setup can replace it.",
);
assert.equal(updateProgressPercent({ ...downloading, total: 0 }), null);
assert.equal(updateProgressPercent({ ...downloading, received: 250, total: 100 }), 100);
