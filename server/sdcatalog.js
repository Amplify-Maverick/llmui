/**
 * Image-model catalog logic for sd-server: which Hugging Face files are
 * single-file checkpoints, which sd-server recipe and folder each one needs,
 * and whether a model setup (recipe + files) is complete.
 *
 * Pure functions. Recipes always come from the live sd-server
 * (GET /sdcpp/v1/recipes); the tables below only name recipe ids, and a name
 * that the server doesn't list simply means "won't load".
 */

export const GiB = 1024 ** 3;

// Top-level folders of a diffusers-format repo. Files under them are pipeline
// components, not single-file checkpoints, and sd-server can't load the
// folder layout through its catalog. (vae/ and controlnet/ are also ComfyUI
// folder names; diffusers files there are caught by DIFFUSERS_FILE_RE.)
const DIFFUSERS_DIRS = new Set([
  "unet", "transformer", "text_encoder", "text_encoder_2", "text_encoder_3",
  "tokenizer", "tokenizer_2", "tokenizer_3", "vae_decoder", "vae_encoder",
  "scheduler", "safety_checker", "feature_extractor", "image_encoder",
  "prior", "decoder", "movq",
]);
const DIFFUSERS_FILE_RE = /^(diffusion_pytorch_model|model|pytorch_model|adapter_model|pytorch_lora_weights)([.-].*)?\.(safetensors|gguf)$/i;

// ComfyUI-style folders in a repo path ("split_files/text_encoders/x.safetensors")
// say what a file is. Values are sd-server categories; null = skip.
const FOLDER_CATEGORY = {
  checkpoints: "checkpoints",
  diffusion_models: "diffusion_models",
  unet: "diffusion_models",
  text_encoders: "text_encoders",
  clip: "text_encoders",
  vae: "vae",
  clip_vision: "clip_vision",
  loras: null,
  lora: null,
  controlnet: null,
  model_patches: null,
  upscale_models: null,
  embeddings: null,
};
const COMPONENT_CATEGORIES = new Set(["text_encoders", "vae", "clip_vision"]);

// Root-level names that are components or adapters, not checkpoints.
const NOT_CHECKPOINT_RE =
  /(^|[-_.])(lora|lycoris|loha|vae|taesd|textual|embedding|controlnet|clip|clip_l|clip_g|t5xxl|t5|umt5|mmproj|ip[-_]?adapter|motion|text[-_]?encoder)([-_.]|$)/i;
const ROOT_TEXT_ENCODER_RE = /^(clip_[lg]|t5xxl|umt5|t5)([-_.]|$)/i;
const ROOT_VAE_RE = /(^ae\.safetensors$|(^|[-_.])vae([-_.]|$))/i;

// Real checkpoints are hundreds of MB at least; LoRAs and embeddings are smaller.
export const MIN_CHECKPOINT_BYTES = 300 * 1024 * 1024;

const fileSize = (f) => f.lfs?.size ?? f.size ?? 0;

/**
 * The .safetensors/.gguf files in a recursive HF tree listing that sd-server
 * can use as single files: kind "model" (a checkpoint or diffusion model) or
 * kind "component" (text encoder / VAE / CLIP vision, with its category).
 */
export function classifyFiles(tree) {
  const out = [];
  for (const f of tree || []) {
    if (f.type !== "file" || !/\.(safetensors|gguf)$/i.test(f.path)) continue;
    const segments = f.path.split("/");
    const name = segments.at(-1);
    const dirs = segments.slice(0, -1).map((d) => d.toLowerCase());
    if (dirs.length && DIFFUSERS_DIRS.has(dirs[0])) continue;
    if (DIFFUSERS_FILE_RE.test(name)) continue;
    // Split shards can't be loaded as one catalog file.
    if (/-\d{5}-of-\d{5}\.(safetensors|gguf)$/i.test(name)) continue;
    const size = fileSize(f);

    const folder = [...dirs].reverse().find((d) => d in FOLDER_CATEGORY);
    let category = folder ? FOLDER_CATEGORY[folder] : undefined;
    if (category === null) continue; // loras/, controlnet/, ...
    if (category === undefined) {
      if (ROOT_TEXT_ENCODER_RE.test(name)) category = "text_encoders";
      else if (ROOT_VAE_RE.test(name)) category = "vae";
      else if (NOT_CHECKPOINT_RE.test(name)) continue;
    }
    if (COMPONENT_CATEGORIES.has(category)) {
      out.push({ path: f.path, name, size, kind: "component", category });
      continue;
    }
    if (size < MIN_CHECKPOINT_BYTES) continue;
    out.push({ path: f.path, name, size, kind: "model", category: category || null });
  }
  return out;
}

/** Just the checkpoint / diffusion-model files. */
export const candidateFiles = (tree) => classifyFiles(tree).filter((f) => f.kind === "model");

/** True for LoRA / adapter repos, whose .safetensors aren't checkpoints. */
export function isAdapterRepo(info) {
  const tags = info.tags || [];
  return tags.some((t) => t === "lora" || t.startsWith("base_model:adapter:") || t === "textual_inversion");
}

/** The repo itself, then the models it says it derives from. */
export function lineage(info) {
  const ids = [info.id];
  const base = info.cardData?.base_model;
  for (const b of Array.isArray(base) ? base : base ? [base] : []) if (typeof b === "string") ids.push(b);
  for (const t of info.tags || []) {
    const m = /^base_model:(?:(?:finetune|quantized|merge):)?(.+)$/.exec(t);
    if (m && !t.startsWith("base_model:adapter:")) ids.push(m[1]);
  }
  return [...new Set(ids.map((x) => x.trim()).filter((x) => /^[\w.-]+\/[\w.-]+$/.test(x)))];
}

// Family fallbacks when no lineage entry matches a recipe's model_url.
// Each names the recipe ids to try, in order.
export const FAMILIES = {
  sd1: { label: "SD 1.x", recipes: ["sd1-checkpoint"] },
  sd2: { label: "SD 2.x", recipes: ["sd2-768-checkpoint"] },
  sd2base: { label: "SD 2.x (512)", recipes: ["sd2-512-checkpoint"] },
  sdxl: { label: "SDXL", recipes: ["sdxl-checkpoint"] },
  sd3: { label: "SD 3", recipes: ["sd3-medium"] },
  sd35: { label: "SD 3.5", recipes: ["sd35-medium", "sd35-large"] },
  flux1: { label: "FLUX.1", recipes: ["flux1-dev"] },
  flux2: { label: "FLUX.2", recipes: ["flux2-dev"] },
  flux3: { label: "FLUX.3", recipes: ["flux3-klein"] },
  chroma: { label: "Chroma", recipes: ["chroma"] },
  pixartSigma: { label: "PixArt Sigma", recipes: ["pixart-sigma"] },
  pixartAlpha: { label: "PixArt Alpha", recipes: ["pixart-alpha-1024"] },
  qwenImage: { label: "Qwen Image", recipes: ["qwen-image"] },
  zImage: { label: "Z-Image", recipes: ["z-image-turbo", "z-image"] },
  pix2pix: { label: "Instruct-Pix2Pix", recipes: ["instruct-pix2pix"] },
};

const CLASS_FAMILY = {
  StableDiffusionPipeline: "sd1",
  LatentConsistencyModelPipeline: "sd1",
  StableDiffusionXLPipeline: "sdxl",
  StableDiffusion3Pipeline: "sd3",
  FluxPipeline: "flux1",
  Flux2Pipeline: "flux2",
  ChromaPipeline: "chroma",
  PixArtSigmaPipeline: "pixartSigma",
  PixArtAlphaPipeline: "pixartAlpha",
  QwenImagePipeline: "qwenImage",
  ZImagePipeline: "zImage",
  StableDiffusionInstructPix2PixPipeline: "pix2pix",
};

/** Base-model family from the diffusers class, tags and lineage names. */
export function detectFamily(info) {
  const names = lineage(info).join(" ").toLowerCase();
  const tags = new Set((info.tags || []).map((t) => t.toLowerCase()));
  const cls = info.config?.diffusers?._class_name;
  let family = CLASS_FAMILY[cls] || null;
  if (!family) {
    if (tags.has("stable-diffusion-xl") || tags.has("sdxl") || /sdxl|stable-diffusion-xl|[-_]xl[-_]/.test(names)) family = "sdxl";
    else if (/stable-diffusion-3\.5|sd3\.5/.test(names)) family = "sd35";
    else if (tags.has("sd3") || tags.has("stable-diffusion-3") || /stable-diffusion-3/.test(names)) family = "sd3";
    else if (/flux[-_.]?3/.test(names)) family = "flux3";
    else if (/flux[-_.]?2/.test(names)) family = "flux2";
    else if (tags.has("flux") || /flux/.test(names)) family = "flux1";
    else if (tags.has("stable-diffusion") || tags.has("stable-diffusion-diffusers")) family = "sd1";
  }
  if (family === "sd1" && /stable-diffusion-2/.test(names)) family = /stable-diffusion-2(-1)?-base/.test(names) ? "sd2base" : "sd2";
  if (family === "sd3" && /stable-diffusion-3\.5|sd3\.5/.test(names)) family = "sd35";
  return family;
}

const hfRepoOf = (url) => {
  const m = /^https:\/\/huggingface\.co\/([\w.-]+\/[\w.-]+)/i.exec(url || "");
  return m ? m[1].toLowerCase() : null;
};

/** Recipe slot that takes the model file itself ("model" or "diffusion_model"). */
export function primarySlot(recipe) {
  return (
    recipe.slots?.find((s) => s.required && (s.id === "model" || s.id === "diffusion_model")) ||
    recipe.slots?.find((s) => s.required) ||
    null
  );
}

/** Other things a recipe needs besides its primary file: required slots and "one of" groups. */
export function extraNeeds(recipe) {
  const primary = primarySlot(recipe);
  const needs = [];
  for (const s of recipe.slots || []) {
    if (s.required && s !== primary) needs.push({ slots: [s.id], label: s.label || s.id, categories: s.categories || [s.category] });
  }
  for (const group of recipe.required_any || []) {
    const slots = (recipe.slots || []).filter((s) => group.includes(s.id));
    needs.push({
      slots: group,
      label: slots.map((s) => s.label || s.id).join(" or "),
      categories: [...new Set(slots.flatMap((s) => s.categories || [s.category]))],
    });
  }
  return needs;
}

// Recipes for editing/reference workflows, video or adapters are never the
// first choice for a plain text-to-image checkpoint.
const isPlainT2I = (r) =>
  !/edit|inpaint|controlnet|ip-adapter|photomaker|pulid|canny|depth|fill|kontext|animatediff|l2p/i.test(r.id) &&
  !(r.features || []).includes("ref_images") &&
  !r.video_constraints;

const tokens = (s) => new Set(s.toLowerCase().replace(/\.(safetensors|gguf)$/, "").split(/[^a-z0-9]+/).filter(Boolean));

/**
 * A sibling recipe that names a variant the file name also names: flux1-dev
 * → flux1-canny for "flux1-canny-dev.safetensors", krea2-raw → krea2-turbo
 * for "krea2_turbo_bf16", sd1-checkpoint → sd1-inpainting, ...
 * Siblings share the recipe id's first part ("flux1", "sdxl", "qwen").
 */
export function variantOf(recipe, fileName, recipes) {
  const prefix = recipe.id.split("-")[0];
  const fileTok = tokens(fileName);
  // "fluxdev", "flux-2-klein": also match tokens glued back together.
  const glued = fileName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const has = (t) => fileTok.has(t) || (t.length > 3 && glued.includes(t));
  const base = tokens(recipe.id);
  let best = recipe;
  let bestScore = 0;
  for (const r of recipes) {
    if (r === recipe || r.video_constraints || (r.id !== prefix && !r.id.startsWith(prefix + "-"))) continue;
    const extra = [...tokens(r.id)].filter((t) => !base.has(t));
    if (!extra.length || !extra.every(has)) continue;
    if (extra.length > bestScore) {
      best = r;
      bestScore = extra.length;
    }
  }
  return best;
}

/**
 * Recipe for one file of a repo, using the live recipe list.
 * Returns { recipe, how } or { recipe: null, reason }.
 */
export function inferRecipe(info, fileName, recipes) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const name = fileName.toLowerCase();
  let family = detectFamily(info);

  // A file named like SDXL in an SD 1.x repo (e.g. Lykon/DreamShaper) is SDXL.
  if ((family === "sd1" || !family) && /sdxl|xl(?=[^a-z]|$)/.test(name)) family = "sdxl";

  // 1. Lineage: the repo or a base model is a recipe's reference model.
  if (!(family === "sdxl" && detectFamily(info) === "sd1")) {
    for (const id of lineage(info)) {
      const matches = recipes.filter((r) => hfRepoOf(r.model_url) === id.toLowerCase());
      if (!matches.length) continue;
      const plain = matches.filter(isPlainT2I);
      const pick = variantOf((plain.length ? plain : matches)[0], fileName, recipes);
      return { recipe: pick, family, how: `base model ${id}` };
    }
  }

  // 2. Family table.
  if (family && FAMILIES[family]) {
    const fam = FAMILIES[family];
    const recipe = fam.recipes.map((id) => byId.get(id)).find(Boolean);
    if (recipe) return { recipe: variantOf(recipe, fileName, recipes), family, how: fam.label };
    return { recipe: null, family, reason: `sd-server has no ${fam.label} recipe` };
  }
  return { recipe: null, family: null, reason: "unknown base model" };
}

/** VRAM fit for a file of `size` bytes on a `gpuBytes` card. */
export function fitLevel(size, gpuBytes) {
  if (!size || !gpuBytes) return "unknown";
  if (size > gpuBytes) return "nofit";
  if (size > gpuBytes - 1.5 * GiB) return "tight";
  return "fits";
}

/**
 * One search result: the repo plus its loadable files.
 * `installed` is a Set of "category/name" ids already on the server.
 */
export function describeRepo(info, tree, recipes, { gpuBytes, installed = new Set() } = {}) {
  const files = classifyFiles(tree).map((f) => {
    const safeName = f.name.replace(/[^A-Za-z0-9._+-]/g, "_");
    const common = { path: f.path, name: f.name, size: f.size, kind: f.kind, fit: fitLevel(f.size, gpuBytes) };
    if (f.kind === "component") {
      return { ...common, category: f.category, recipe: null, recipeName: null, how: null, reason: null, needs: [],
        installed: installed.has(`${f.category}/${safeName}`) };
    }
    let { recipe, how, reason } = inferRecipe(info, f.name, recipes);
    let slot = recipe ? primarySlot(recipe) : null;
    const slotCats = slot ? slot.categories || [slot.category] : [];
    // A file sitting in checkpoints/ can't feed a diffusion_model slot, and vice versa.
    if (recipe && f.category && !slotCats.includes(f.category)) {
      reason = `${recipe.name} expects ${slotCats.join("/")}/ but the repo ships it as ${f.category}/`;
      recipe = null;
      slot = null;
    }
    const category = slot ? slot.category || slotCats[0] : f.category;
    return {
      ...common,
      recipe: recipe ? recipe.id : null,
      recipeName: recipe ? recipe.name : null,
      how: how || null,
      reason: recipe ? null : reason,
      category,
      needs: recipe ? extraNeeds(recipe) : [],
      installed: !!category && installed.has(`${category}/${safeName}`),
    };
  });
  return {
    id: info.id,
    sha: info.sha || null,
    downloads: info.downloads || 0,
    likes: info.likes || 0,
    gated: info.gated || false,
    updatedAt: info.lastModified || null,
    files,
  };
}

/** Recipe defaults as LLMUI generation params (only the keys the recipe sets). */
export function recipeDefaults(recipe) {
  const d = recipe?.defaults || {};
  const out = {};
  if (Number.isInteger(d.width)) out.width = d.width;
  if (Number.isInteger(d.height)) out.height = d.height;
  if (Number.isInteger(d.steps)) out.steps = d.steps;
  if (typeof d.cfg_scale === "number") out.cfgScale = d.cfg_scale;
  if (typeof d.sampling_method === "string") out.sampler = d.sampling_method;
  return out;
}

/**
 * Check a model setup against the live recipes and catalog files.
 * files: sd-server /model-files entries ({ id, category }).
 * Returns { error } or { setup: { recipe, slot, components } }.
 */
export function validateSetup({ model, recipe: recipeId, components = {} }, recipes, files) {
  const recipe = recipes.find((r) => r.id === recipeId);
  if (!recipe) return { error: `sd-server has no recipe "${recipeId}"` };
  const byId = new Map(files.map((f) => [f.id, f]));
  const file = byId.get(model);
  if (!file) return { error: `${model} is not in sd-server's model list` };
  const slot = primarySlot(recipe);
  if (!slot) return { error: `recipe ${recipe.id} has no model slot` };
  const cats = slot.categories || [slot.category];
  if (!cats.includes(file.category)) {
    return { error: `${recipe.name} expects its ${slot.label || slot.id} in ${cats.join("/")}/, not ${file.category}/` };
  }
  if (typeof components !== "object" || Array.isArray(components)) return { error: "components must be an object" };
  const clean = {};
  for (const [slotId, fileId] of Object.entries(components)) {
    if (!fileId) continue;
    const s = recipe.slots.find((x) => x.id === slotId);
    if (!s || s === slot) return { error: `recipe ${recipe.id} has no "${slotId}" slot` };
    const f = byId.get(fileId);
    if (!f) return { error: `${fileId} is not in sd-server's model list` };
    const sc = s.categories || [s.category];
    if (!sc.includes(f.category)) return { error: `${s.label || s.id} must come from ${sc.join("/")}/` };
    clean[slotId] = fileId;
  }
  for (const need of extraNeeds(recipe)) {
    if (!need.slots.some((id) => clean[id])) return { error: `${recipe.name} needs ${need.label}` };
  }
  return { setup: { recipe: recipe.id, slot: slot.id, components: clean } };
}
