import { test } from "node:test";
import assert from "node:assert/strict";
import { groupQuants, normalizeEvent, gpuBytes } from "./llama.js";

const f = (path, size) => ({ type: "file", path, size: 1, lfs: { size } });

test("groupQuants groups by quant, sums shards, skips mmproj and non-gguf", () => {
  const r = groupQuants([
    f("Qwen3-8B-Q4_K_M.gguf", 5e9),
    f("Qwen3-8B-Q8_0.gguf", 8.7e9),
    f("BF16/Qwen3-8B-BF16-00001-of-00002.gguf", 9e9),
    f("BF16/Qwen3-8B-BF16-00002-of-00002.gguf", 7e9),
    f("Qwen3-8B-UD-Q4_K_XL.gguf", 5.1e9),
    f("Qwen3-8B-IQ3_XXS.gguf", 3.3e9),
    f("mmproj-F16.gguf", 0.6e9),
    f("README.md", 10),
    { type: "directory", path: "BF16" },
  ]);
  assert.equal(r.hasMmproj, true);
  assert.deepEqual(
    r.quants.map((q) => [q.quant, q.size]),
    [["IQ3_XXS", 3.3e9], ["Q4_K_M", 5e9], ["UD-Q4_K_XL", 5.1e9], ["Q8_0", 8.7e9], ["BF16", 16e9]]
  );
  assert.equal(r.quants.at(-1).files.length, 2);
});

test("normalizeEvent handles JSON {model,event,data} and event: framing", () => {
  assert.deepEqual(
    normalizeEvent(null, '{"model":"a/b:Q4","event":"download_progress","data":{"u":{"done":1,"total":2}}}'),
    { type: "download_progress", model: "a/b:Q4", data: { u: { done: 1, total: 2 } } }
  );
  assert.deepEqual(
    normalizeEvent("model_status", '{"model":"a/b:Q4","status":"loaded"}'),
    { type: "model_status", model: "a/b:Q4", data: { model: "a/b:Q4", status: "loaded" } }
  );
  assert.equal(normalizeEvent(null, "not json"), null);
  assert.equal(normalizeEvent(null, '{"foo":1}'), null);
});

test("gpuBytes sums model+context+compute on the GPU device only", () => {
  const snap = {
    n_ctx: 8192,
    devices: [
      { kind: "device", name: "Vulkan0", model: 100, context: 20, compute: 3, total: 1000 },
      { kind: "host", name: "Host", model: 50, context: 0, compute: 5 },
    ],
  };
  assert.equal(gpuBytes(snap), 123);
  assert.equal(gpuBytes(null), null);
});

import { combineTimings } from "../openai.js";

test("combineTimings sums tool-loop turns and recomputes rates", () => {
  const t = combineTimings([
    { predicted_n: 30, predicted_ms: 1000, prompt_n: 400, prompt_ms: 1000 },
    null,
    { predicted_n: 34, predicted_ms: 1000, prompt_n: 100, prompt_ms: 250 },
  ]);
  assert.equal(t.predicted_per_second, 32);
  assert.equal(t.prompt_per_second, 400);
  assert.equal(combineTimings([null, undefined]), null);
});
