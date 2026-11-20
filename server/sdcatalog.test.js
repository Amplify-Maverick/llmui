import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GiB,
  classifyFiles,
  candidateFiles,
  lineage,
  detectFamily,
  inferRecipe,
  variantOf,
  extraNeeds,
  fitLevel,
  describeRepo,
  recipeDefaults,
  validateSetup,
  isAdapterRepo,
} from "./sdcatalog.js";

// Trimmed copies of recipes from sd-server 532d2c1's GET /sdcpp/v1/recipes.
const ckptSlots = [
  { id: "model", label: "Checkpoint", category: "checkpoints", categories: ["checkpoints"], required: true },
  { id: "vae", label: "VAE", category: "vae", categories: ["vae"], required: false },
  { id: "tae", label: "TAE", category: "vae", categories: ["vae", "vae_approx"], required: false },
];
const fluxSlots = [
  { id: "diffusion_model", label: "Diffusion model", category: "diffusion_models", categories: ["diffusion_models"], required: true },
  { id: "clip_l", label: "CLIP-L", category: "text_encoders", categories: ["text_encoders"], required: true },
  { id: "t5xxl", label: "T5", category: "text_encoders", categories: ["text_encoders"], required: true },
  { id: "vae", label: "VAE", category: "vae", categories: ["vae"], required: false },
  { id: "tae", label: "TAE", category: "vae", categories: ["vae", "vae_approx"], required: false },
];
const RECIPES = [
  { id: "sd1-checkpoint", name: "SD 1.x", model_url: "https://huggingface.co/CompVis/stable-diffusion-v1-4", slots: ckptSlots,
    defaults: { cfg_scale: 7, height: 512, width: 512, sampling_method: "euler_a", steps: 20 } },
  { id: "sd1-inpainting", name: "SD 1.5 Inpainting", slots: ckptSlots },
  { id: "sdxl-checkpoint", name: "SDXL", model_url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0", slots: ckptSlots,
    defaults: { height: 1024, width: 1024, steps: 20 } },
  { id: "sdxl-turbo", name: "SDXL Turbo", model_url: "https://huggingface.co/stabilityai/sdxl-turbo", slots: ckptSlots },
  { id: "sdxl-inpainting", name: "SDXL Inpainting", slots: ckptSlots },
  { id: "flux1-dev", name: "FLUX.1 dev", model_url: "https://huggingface.co/black-forest-labs/FLUX.1-dev", slots: fluxSlots, required_any: [["vae", "tae"]] },
  { id: "flux1-canny", name: "FLUX.1 Canny dev", model_url: "https://huggingface.co/black-forest-labs/FLUX.1-Canny-dev", slots: fluxSlots, required_any: [["vae", "tae"]], features: ["control_image"] },
  { id: "flux1-schnell", name: "FLUX.1 schnell", model_url: "https://huggingface.co/black-forest-labs/FLUX.1-schnell", slots: fluxSlots, required_any: [["vae", "tae"]] },
  { id: "anima", name: "Anima", model_url: "https://huggingface.co/circlestone-labs/Anima", slots: fluxSlots.slice(0, 2) },
  { id: "anima-edit", name: "Anima Edit (LoRA)", model_url: "https://huggingface.co/circlestone-labs/Anima", slots: fluxSlots.slice(0, 2), features: ["ref_images"] },
];

const file = (path, size) => ({ type: "file", path, size: 100, lfs: { size } });

test("classifyFiles keeps root checkpoints and ComfyUI components, drops diffusers parts, LoRAs and shards", () => {
  const files = classifyFiles([
    file("v1-5-pruned-emaonly.safetensors", 4.27e9),
    file("unet/diffusion_pytorch_model.safetensors", 3.4e9),
    file("text_encoder/model.safetensors", 0.5e9),
    file("vae/diffusion_pytorch_model.safetensors", 0.3e9),
    file("diffusion_pytorch_model.safetensors", 3.4e9),
    file("split_files/diffusion_models/flux1-canny-dev.safetensors", 23e9),
    file("split_files/text_encoders/t5xxl_fp16.safetensors", 9e9),
    file("split_files/vae/ae.safetensors", 0.33e9),
    file("loras/style.safetensors", 0.3e9),
    file("my_style_lora.safetensors", 0.4e9),
    file("tiny.safetensors", 1e6),
    file("model-00001-of-00002.safetensors", 5e9),
    file("clip_l.safetensors", 0.25e9),
    file("weights.ckpt", 4e9),
    { type: "directory", path: "unet" },
  ]);
  assert.deepEqual(
    files.map((f) => [f.path, f.kind, f.category]),
    [
      ["v1-5-pruned-emaonly.safetensors", "model", null],
      ["split_files/diffusion_models/flux1-canny-dev.safetensors", "model", "diffusion_models"],
      ["split_files/text_encoders/t5xxl_fp16.safetensors", "component", "text_encoders"],
      ["split_files/vae/ae.safetensors", "component", "vae"],
      ["clip_l.safetensors", "component", "text_encoders"],
    ]
  );
  assert.equal(candidateFiles([file("a.gguf", 2e9), file("vae/ae.safetensors", 3e8)]).length, 1);
});

test("lineage reads card base_model and base_model tags, skipping adapters", () => {
  assert.deepEqual(
    lineage({
      id: "city96/FLUX.1-dev-gguf",
      cardData: { base_model: "black-forest-labs/FLUX.1-dev" },
      tags: ["base_model:quantized:black-forest-labs/FLUX.1-dev", "base_model:adapter:x/y", "gguf"],
    }),
    ["city96/FLUX.1-dev-gguf", "black-forest-labs/FLUX.1-dev"]
  );
  assert.equal(isAdapterRepo({ tags: ["base_model:adapter:x/y"] }), true);
  assert.equal(isAdapterRepo({ tags: ["lora"] }), true);
  assert.equal(isAdapterRepo({ tags: ["diffusers"] }), false);
});

test("detectFamily from diffusers class, tags and names", () => {
  assert.equal(detectFamily({ id: "a/b", config: { diffusers: { _class_name: "StableDiffusionXLPipeline" } } }), "sdxl");
  assert.equal(detectFamily({ id: "a/b", tags: ["stable-diffusion"] }), "sd1");
  assert.equal(detectFamily({ id: "a/b", tags: ["stable-diffusion"], cardData: { base_model: "stabilityai/stable-diffusion-2-1" } }), "sd2");
  assert.equal(detectFamily({ id: "a/flux-3-image-klein-ggufs" }), "flux3");
  assert.equal(detectFamily({ id: "a/b" }), null);
});

test("inferRecipe: lineage via model_url, family fallback, filename variants", () => {
  const sdxlTuned = { id: "x/animagine", cardData: { base_model: "stabilityai/stable-diffusion-xl-base-1.0" } };
  assert.equal(inferRecipe(sdxlTuned, "animagine.safetensors", RECIPES).recipe.id, "sdxl-checkpoint");

  const sd1Repo = { id: "Lykon/DreamShaper", tags: ["stable-diffusion"], config: { diffusers: { _class_name: "StableDiffusionPipeline" } } };
  assert.equal(inferRecipe(sd1Repo, "DreamShaper_8.safetensors", RECIPES).recipe.id, "sd1-checkpoint");
  assert.equal(inferRecipe(sd1Repo, "DreamShaper8_INPAINTING.inpainting.safetensors", RECIPES).recipe.id, "sd1-inpainting");
  assert.equal(inferRecipe(sd1Repo, "DreamShaperXL1.0Alpha2_half.safetensors", RECIPES).recipe.id, "sdxl-checkpoint");
  assert.equal(inferRecipe(sd1Repo, "DreamShaperXL_Turbo_half.safetensors", RECIPES).recipe.id, "sdxl-turbo");

  const flux = { id: "Comfy-Org/Flux-1-Dev", cardData: { base_model: "black-forest-labs/FLUX.1-dev" } };
  assert.equal(inferRecipe(flux, "flux1-dev-fp8.safetensors", RECIPES).recipe.id, "flux1-dev");
  assert.equal(inferRecipe(flux, "flux1-canny-dev.safetensors", RECIPES).recipe.id, "flux1-canny");

  // Several recipes share a model_url: prefer plain text-to-image.
  assert.equal(inferRecipe({ id: "circlestone-labs/Anima" }, "anima.safetensors", RECIPES).recipe.id, "anima");

  const unknown = inferRecipe({ id: "a/b" }, "thing.gguf", RECIPES);
  assert.equal(unknown.recipe, null);
  assert.match(unknown.reason, /unknown base model/);

  // A family whose recipe the live server doesn't have.
  const sd3 = inferRecipe({ id: "a/b", tags: ["sd3"] }, "sd3.safetensors", RECIPES);
  assert.equal(sd3.recipe, null);
  assert.match(sd3.reason, /no SD 3 recipe/);
});

test("variantOf stays put without a matching token", () => {
  const dev = RECIPES.find((r) => r.id === "flux1-dev");
  assert.equal(variantOf(dev, "flux1-dev-Q4_K_S.gguf", RECIPES).id, "flux1-dev");
  assert.equal(variantOf(dev, "flux1-schnell-Q4.gguf", RECIPES).id, "flux1-schnell");
});

test("extraNeeds lists required slots and one-of groups", () => {
  const needs = extraNeeds(RECIPES.find((r) => r.id === "flux1-dev"));
  assert.deepEqual(needs.map((n) => [n.slots, n.categories]), [
    [["clip_l"], ["text_encoders"]],
    [["t5xxl"], ["text_encoders"]],
    [["vae", "tae"], ["vae", "vae_approx"]],
  ]);
  assert.deepEqual(extraNeeds(RECIPES[0]), []);
});

test("fitLevel against an 8 GiB card", () => {
  assert.equal(fitLevel(2 * GiB, 8 * GiB), "fits");
  assert.equal(fitLevel(7 * GiB, 8 * GiB), "tight");
  assert.equal(fitLevel(8.5 * GiB, 8 * GiB), "nofit");
  assert.equal(fitLevel(0, 8 * GiB), "unknown");
});

test("describeRepo maps files to folder, recipe and installed state", () => {
  const info = { id: "city96/FLUX.1-dev-gguf", sha: "abc", cardData: { base_model: "black-forest-labs/FLUX.1-dev" }, downloads: 5 };
  const r = describeRepo(info, [file("flux1-dev-Q4_K_S.gguf", 6.8e9), file("flux1-dev-F16.gguf", 23.8e9)], RECIPES, {
    gpuBytes: 8 * GiB,
    installed: new Set(["diffusion_models/flux1-dev-Q4_K_S.gguf"]),
  });
  assert.equal(r.sha, "abc");
  assert.deepEqual(r.files.map((f) => [f.name, f.recipe, f.category, f.fit, f.installed]), [
    ["flux1-dev-Q4_K_S.gguf", "flux1-dev", "diffusion_models", "fits", true],
    ["flux1-dev-F16.gguf", "flux1-dev", "diffusion_models", "nofit", false],
  ]);
  assert.equal(r.files[0].needs.length, 3);

  // A checkpoint shipped in checkpoints/ can't feed a diffusion_model slot.
  const bad = describeRepo(info, [file("checkpoints/flux1-dev-aio.safetensors", 17e9)], RECIPES, { gpuBytes: 8 * GiB });
  assert.equal(bad.files[0].recipe, null);
  assert.match(bad.files[0].reason, /expects diffusion_models/);
});

test("recipeDefaults maps sd-server names to LLMUI params", () => {
  assert.deepEqual(recipeDefaults(RECIPES[0]), { width: 512, height: 512, steps: 20, cfgScale: 7, sampler: "euler_a" });
  assert.deepEqual(recipeDefaults({}), {});
});

test("validateSetup checks recipe, categories and required components", () => {
  const files = [
    { id: "checkpoints/sd15.safetensors", category: "checkpoints" },
    { id: "diffusion_models/flux.gguf", category: "diffusion_models" },
    { id: "text_encoders/clip_l.safetensors", category: "text_encoders" },
    { id: "text_encoders/t5.gguf", category: "text_encoders" },
    { id: "vae/ae.safetensors", category: "vae" },
  ];
  assert.deepEqual(validateSetup({ model: "checkpoints/sd15.safetensors", recipe: "sd1-checkpoint" }, RECIPES, files), {
    setup: { recipe: "sd1-checkpoint", slot: "model", components: {} },
  });
  assert.match(validateSetup({ model: "checkpoints/sd15.safetensors", recipe: "nope" }, RECIPES, files).error, /no recipe/);
  assert.match(validateSetup({ model: "checkpoints/sd15.safetensors", recipe: "flux1-dev" }, RECIPES, files).error, /expects/);
  assert.match(validateSetup({ model: "diffusion_models/flux.gguf", recipe: "flux1-dev" }, RECIPES, files).error, /needs CLIP-L/);
  assert.match(
    validateSetup({ model: "diffusion_models/flux.gguf", recipe: "flux1-dev", components: { clip_l: "text_encoders/clip_l.safetensors", t5xxl: "text_encoders/t5.gguf" } }, RECIPES, files).error,
    /needs VAE or TAE/
  );
  assert.match(
    validateSetup({ model: "diffusion_models/flux.gguf", recipe: "flux1-dev", components: { clip_l: "vae/ae.safetensors" } }, RECIPES, files).error,
    /must come from text_encoders/
  );
  const ok = validateSetup({
    model: "diffusion_models/flux.gguf",
    recipe: "flux1-dev",
    components: { clip_l: "text_encoders/clip_l.safetensors", t5xxl: "text_encoders/t5.gguf", tae: "vae/ae.safetensors", vae: "" },
  }, RECIPES, files);
  assert.deepEqual(ok.setup, {
    recipe: "flux1-dev",
    slot: "diffusion_model",
    components: { clip_l: "text_encoders/clip_l.safetensors", t5xxl: "text_encoders/t5.gguf", tae: "vae/ae.safetensors" },
  });
});
