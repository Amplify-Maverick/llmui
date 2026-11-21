import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "./clipboard.js";

test("copies with the Clipboard API when it's there", async () => {
  const written = [];
  assert.equal(await copyText("llmui-pair:v1:{}", { writeText: async (t) => written.push(t) }), true);
  assert.deepEqual(written, ["llmui-pair:v1:{}"]);
});

test("reports false when there's no Clipboard API or the write is refused", async () => {
  assert.equal(await copyText("x", undefined), false);
  assert.equal(await copyText("x", {}), false);
  assert.equal(await copyText("x", { writeText: async () => { throw new DOMException("denied", "NotAllowedError"); } }), false);
});
