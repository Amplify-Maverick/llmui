import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { listen } from "../testHelpers.js";
import router, { isChatRepo, gpuInfo, groupQuants } from "./llama.js";

// ── Fake Hugging Face: every huggingface.co request is answered from here ──
const realFetch = globalThis.fetch;
const hfCalls = [];
let searchHits = [];
const repoInfos = new Map(); // "owner/name" → model info
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== "huggingface.co") return realFetch(input, init);
  hfCalls.push(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/models") return json(searchHits);
  const m = /^\/api\/models\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const info = repoInfos.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
    return info ? json(info) : json({ error: "Repository not found" }, 401);
  }
  return json({ error: "unexpected" }, 500);
};

const app = express();
app.use((req, _res, next) => ((req.machine = { id: "test", name: "Test" }), next()));
app.use("/api/llama", router);
const server = await listen(app);
after(async () => {
  await server.close();
  globalThis.fetch = realFetch;
});
const search = async (q) => (await realFetch(`${server.url}/api/llama/hf/search?q=${encodeURIComponent(q)}`)).json();

// The real unsloth repo has no pipeline_tag, which used to hide it from search.
const UNSLOTH = { id: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF", pipeline_tag: undefined, tags: ["gguf", "qwen3", "conversational"], downloads: 90000, likes: 300 };
const TENSORBLOCK = { id: "tensorblock/unsloth_Qwen3-30B-A3B-Instruct-2507-GGUF", pipeline_tag: "text-generation", tags: ["gguf"], downloads: 50, likes: 1 };

test("isChatRepo: chat pipelines yes, other pipelines no, untagged unless tags say non-chat", () => {
  assert.equal(isChatRepo({ pipeline_tag: "text-generation" }), true);
  assert.equal(isChatRepo({ pipeline_tag: "image-text-to-text" }), true);
  assert.equal(isChatRepo({ pipeline_tag: "feature-extraction" }), false);
  assert.equal(isChatRepo(UNSLOTH), true);
  assert.equal(isChatRepo({ id: "a/Model-Instruct-GGUF", tags: ["gguf"] }), true);
  assert.equal(isChatRepo({ id: "a/gemma-3-4b-it-GGUF", tags: ["gguf"] }), true);
  // No chat signal, or a sign of something else.
  assert.equal(isChatRepo({ id: "a/b-GGUF", tags: ["gguf"] }), false);
  assert.equal(isChatRepo({ id: "a/Qwen3-VL-Embedding-8B-GGUF", tags: ["gguf", "conversational"] }), false);
  assert.equal(isChatRepo({ id: "a/whisper-chat-GGUF", tags: ["gguf", "chat"] }), false);
  assert.equal(isChatRepo({ id: "a/b-GGUF", tags: ["gguf", "chat", "speech-to-text"] }), false);
  assert.equal(isChatRepo({ id: "leejet/FLUX.1-schnell-gguf", tags: ["gguf", "sd.cpp"] }), false);
});

test("search keeps repos without a pipeline_tag", async () => {
  searchHits = [UNSLOTH, TENSORBLOCK, { id: "x/embed-GGUF", pipeline_tag: "feature-extraction", tags: ["gguf"] }];
  const r = await search("qwen3 30b");
  assert.deepEqual(r.repos.map((x) => x.id), [UNSLOTH.id, TENSORBLOCK.id]);
  assert.equal(r.repos[0].pipelineTag, null);
});

test("a repo-id query looks the repo up directly and lists it first, once", async () => {
  repoInfos.set(UNSLOTH.id, { ...UNSLOTH, lastModified: "2025-08-01T00:00:00.000Z" });
  // Search misses the exact repo entirely (as HF's search sometimes does).
  searchHits = [TENSORBLOCK];
  let r = await search(UNSLOTH.id);
  assert.deepEqual(r.repos.map((x) => x.id), [UNSLOTH.id, TENSORBLOCK.id]);
  assert.equal(r.repos[0].updatedAt, "2025-08-01T00:00:00.000Z");
  // Search finds it too: still first, not duplicated.
  searchHits = [TENSORBLOCK, UNSLOTH];
  r = await search(UNSLOTH.id);
  assert.deepEqual(r.repos.map((x) => x.id), [UNSLOTH.id, TENSORBLOCK.id]);
});

test("a repo-id query for a missing repo falls back to plain search; words don't trigger a lookup", async () => {
  searchHits = [TENSORBLOCK];
  let r = await search("nobody/nothing-GGUF");
  assert.deepEqual(r.repos.map((x) => x.id), [TENSORBLOCK.id]);
  hfCalls.length = 0;
  r = await search("qwen3 30b");
  assert.deepEqual(hfCalls.map((u) => u.pathname), ["/api/models"]);
});

test("groupQuants keeps a repo's single-file quants beside its split ones", () => {
  const f = (path, size) => ({ type: "file", path, lfs: { size } });
  const r = groupQuants([
    { type: "directory", path: "BF16" },
    f("BF16/Qwen3-30B-A3B-Instruct-2507-BF16-00001-of-00002.gguf", 49655151200),
    f("BF16/Qwen3-30B-A3B-Instruct-2507-BF16-00002-of-00002.gguf", 11440652032),
    f("Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf", 18556686752),
    f("UD-Q8_K_XL/Qwen3-30B-A3B-Instruct-2507-UD-Q8_K_XL-00001-of-00003.gguf", 12e9),
    f("UD-Q8_K_XL/Qwen3-30B-A3B-Instruct-2507-UD-Q8_K_XL-00002-of-00003.gguf", 12e9),
    f("UD-Q8_K_XL/Qwen3-30B-A3B-Instruct-2507-UD-Q8_K_XL-00003-of-00003.gguf", 11e9),
  ]);
  assert.deepEqual(
    r.quants.map((q) => [q.quant, q.size, q.files.length]),
    [["Q4_K_M", 18556686752, 1], ["UD-Q8_K_XL", 35e9, 3], ["BF16", 61095803232, 2]]
  );
});

test("gpuInfo reports free host RAM only when the router gives it", () => {
  const dev = { kind: "device", name: "Vulkan0", model: 1, context: 1, compute: 1, total: 8e9 };
  const model = (host) => ({ memory: { min: { devices: [dev, host] } } });
  assert.equal(gpuInfo([model({ kind: "host", name: "Host", model: 1 })]).ramFree, null);
  const g = gpuInfo([model({ kind: "host", name: "Host", model: 1, free: 24e9 })]);
  assert.deepEqual(g, { name: "Vulkan0", total: 8e9, source: "measured", ramFree: 24e9 });
  assert.equal(gpuInfo([]).source, "assumed");
});
