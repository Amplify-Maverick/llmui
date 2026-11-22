import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHfLink, looksLikeLink, REPO_ID_RE } from "./hflink.js";

const ok = (repo, revision = null, file = null, quant = null) => ({ repo, revision, file, quant });

test("search words aren't links", () => {
  for (const q of ["", "qwen3 8b", "unsloth/Qwen3-8B-GGUF", "flux gguf"]) {
    assert.equal(parseHfLink(q), null, q);
    assert.equal(looksLikeLink(q), false, q);
  }
});

test("repo, tree, blob and resolve links", () => {
  assert.deepEqual(parseHfLink("https://huggingface.co/unsloth/Qwen3-8B-GGUF"), ok("unsloth/Qwen3-8B-GGUF"));
  assert.deepEqual(parseHfLink("  https://huggingface.co/unsloth/Qwen3-8B-GGUF/  "), ok("unsloth/Qwen3-8B-GGUF"));
  assert.deepEqual(parseHfLink("https://huggingface.co/unsloth/Qwen3-8B-GGUF/tree/main"), ok("unsloth/Qwen3-8B-GGUF", "main"));
  assert.deepEqual(parseHfLink("https://huggingface.co/owner/repo/tree/main/split_files"), ok("owner/repo", "main"));
  assert.deepEqual(
    parseHfLink("https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf"),
    ok("unsloth/Qwen3-8B-GGUF", "main", "Qwen3-8B-Q4_K_M.gguf")
  );
  assert.deepEqual(
    parseHfLink("https://huggingface.co/Comfy-Org/flux1-dev/resolve/fp8/split_files/flux1-dev%20fp8.safetensors?download=true"),
    ok("Comfy-Org/flux1-dev", "fp8", "split_files/flux1-dev fp8.safetensors")
  );
  assert.deepEqual(parseHfLink("https://huggingface.co/o/r/blob/refs%2Fpr%2F3/x.gguf"), ok("o/r", "refs/pr/3", "x.gguf"));
  assert.deepEqual(parseHfLink("https://huggingface.co/o/r#model-card"), ok("o/r"));
  assert.deepEqual(parseHfLink("http://www.huggingface.co/o/r"), ok("o/r"));
});

test("hf.co/owner/repo:QUANT and scheme-less links", () => {
  assert.deepEqual(parseHfLink("hf.co/unsloth/Qwen3-8B-GGUF:q4_k_m"), ok("unsloth/Qwen3-8B-GGUF", null, null, "Q4_K_M"));
  assert.deepEqual(parseHfLink("https://hf.co/unsloth/Qwen3-8B-GGUF:UD-Q4_K_XL"), ok("unsloth/Qwen3-8B-GGUF", null, null, "UD-Q4_K_XL"));
  assert.deepEqual(parseHfLink("huggingface.co/o/r"), ok("o/r"));
});

test("links that can't be installed from", () => {
  const err = (s) => parseHfLink(s)?.error;
  assert.match(err("https://civitai.com/models/4384/dreamshaper"), /civitai\.com/);
  assert.match(err("https://huggingface.co/datasets/o/r"), /dataset/);
  assert.match(err("https://huggingface.co/spaces/o/r"), /Space/);
  assert.match(err("https://huggingface.co/unsloth"), /Link to a model/);
  // URL parsing collapses "..", so these never reach a repo or file path.
  assert.ok(err("https://huggingface.co/../etc"));
  assert.deepEqual(parseHfLink("https://huggingface.co/o/r/blob/main/../../x"), ok("o/r"));
  assert.match(err("https://huggingface.co/o/r:a:b"), /doesn't name/);
  assert.match(err("https://huggingface.co/o/r%ZZ"), /valid URL/);
});

test("REPO_ID_RE matches bare owner/name queries only", () => {
  for (const ok of ["unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF", "leejet/FLUX.1-schnell-gguf", "a/.b"]) assert.ok(REPO_ID_RE.test(ok), ok);
  for (const bad of ["qwen3 8b", "a/b/c", "../x", "a/..", "a/.", "owner/", "/name", "a/b:Q4_K_M"]) assert.ok(!REPO_ID_RE.test(bad), bad);
});
