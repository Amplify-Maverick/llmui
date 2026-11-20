import { test } from "node:test";
import assert from "node:assert/strict";
import { pngSize, imageMeta } from "./images.js";

function pngHeader(width, height) {
  const buf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

test("pngSize reads the IHDR size and rejects non-PNG bytes", () => {
  assert.deepEqual(pngSize(pngHeader(768, 1344)), { width: 768, height: 1344 });
  assert.equal(pngSize(Buffer.from("not a png at all, just some text")), null);
  assert.equal(pngSize(null), null);
});

const base = {
  image_id: "img1",
  generation_id: "gen1",
  filename: "sd_gen1_0.png",
  stored_width: 512,
  stored_height: 512,
  position: 0,
  image_created_at: 1000,
  file_size: 557382,
  head: pngHeader(512, 512),
  image_count: 1,
  prompt: "a red fox",
  negative_prompt: "",
  model: "checkpoints/sd15.safetensors",
  width: 512,
  height: 512,
  steps: 20,
  cfg_scale: 7,
  sampler: "euler_a",
  scheduler: null,
  seed: 42,
  batch_count: 1,
  created_at: 1000,
};

test("imageMeta: an old row without machine/recipe/timings reports them as null", () => {
  const m = imageMeta({ ...base, machine_id: null, machine_name: null, recipe: null, components_json: null, total_ms: null, generate_ms: null });
  assert.equal(m.schema, "llmui.image/v1");
  assert.equal(m.id, "img1");
  assert.equal(m.machine, null);
  assert.equal(m.recipe, null);
  assert.equal(m.components, null);
  assert.equal(m.timings, null);
  assert.equal(m.negativePrompt, null);
  assert.equal(m.fileSize, 557382);
  assert.equal(m.width, 512);
  assert.equal(m.settings.seed, 42);
});

test("imageMeta: a new row carries machine, recipe, components and timings", () => {
  const m = imageMeta({
    ...base,
    head: pngHeader(1024, 768),
    negative_prompt: "blurry",
    machine_id: "workstation",
    machine_name: "Workstation",
    recipe: "sdxl-checkpoint",
    components_json: JSON.stringify({ model: "checkpoints/x.safetensors", vae: "vae/y.safetensors" }),
    total_ms: 23000,
    generate_ms: 21000,
  });
  assert.deepEqual(m.machine, { id: "workstation", name: "Workstation" });
  assert.equal(m.recipe, "sdxl-checkpoint");
  assert.equal(m.components.vae, "vae/y.safetensors");
  assert.deepEqual(m.timings, { totalMs: 23000, generateMs: 21000 });
  assert.equal(m.negativePrompt, "blurry");
  // Pixel size comes from the PNG itself, not the requested size.
  assert.equal(m.width, 1024);
  assert.equal(m.height, 768);
});
