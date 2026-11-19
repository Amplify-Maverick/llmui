import { test } from "node:test";
import assert from "node:assert/strict";
import { mmprojAllowance, mmprojAllowanceForFile, MMPROJ_FLAT_BYTES } from "./mmproj.js";

const GiB = 1024 ** 3;

test("no mmproj sidecar → no allowance", () => {
  assert.equal(mmprojAllowance({ sidecars: [] }), 0);
  assert.equal(mmprojAllowance({}), 0);
});

test("mmproj with known size → size × 1.5", () => {
  assert.equal(mmprojAllowance({ sidecars: ["mmproj"], mmprojFileSize: 2 * GiB }), 3 * GiB);
});

test("mmproj with unknown size → flat 1.25 GiB", () => {
  assert.equal(mmprojAllowance({ sidecars: ["mmproj"] }), MMPROJ_FLAT_BYTES);
  assert.equal(mmprojAllowanceForFile(null), 1.25 * GiB);
});
