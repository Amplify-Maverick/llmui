/**
 * Image models: Hugging Face search, install/delete through the sd-fetch
 * helper, and per-model setups (recipe + component files) in sd_config.json.
 * Mounted at /api/images/models (behind requireAuth, via images.js).
 *
 *  GET    /hf/search?q=            text-to-image repos with single-file checkpoints, mapped to recipes
 *  GET    /                        installed files, image recipes, default, helper status
 *  POST   /install                 { repo, path, revision, category, recipe? } → helper job
 *  GET    /install/current         latest helper job (progress)
 *  POST   /install/:id/cancel
 *  DELETE /files/:category/:name
 *  PUT    /setup                   { model, recipe, components, makeDefault }
 */

import { Router } from "express";
import {
  getSdConfig,
  saveSdConfig,
  sdFetch,
  refreshSdCatalog,
  resolveModelSetup,
  isImageJobActive,
} from "../sd.js";
import { fetchHelper, helperConfigured, FetchHelperError } from "../sdfetch.js";
import {
  GiB,
  describeRepo,
  isAdapterRepo,
  primarySlot,
  extraNeeds,
  recipeDefaults,
  validateSetup,
} from "../sdcatalog.js";

const router = Router();

const MODEL_CATEGORIES = new Set(["checkpoints", "diffusion_models"]);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const gpuBytes = () => (Number(getSdConfig().gpuMemoryGiB) || 8) * GiB;

const sendError = (res, err) =>
  res.status(err instanceof FetchHelperError ? err.status : err.status && err.status < 500 ? err.status : 502)
    .json({ error: err.message });

// ── sd-server catalog (recipes are cached briefly; files are not) ───────

let recipeCache = { at: 0, recipes: null };

async function liveRecipes({ fresh = false } = {}) {
  if (!fresh && recipeCache.recipes && Date.now() - recipeCache.at < 60000) return recipeCache.recipes;
  const data = await sdFetch("/sdcpp/v1/recipes");
  recipeCache = { at: Date.now(), recipes: data.recipes || [] };
  return recipeCache.recipes;
}

async function liveFiles() {
  return (await sdFetch("/sdcpp/v1/model-files")).files || [];
}

/** Image (not video) recipes, trimmed for the browser. */
function recipeSummaries(recipes) {
  return recipes
    .filter((r) => !r.video_constraints && primarySlot(r))
    .map((r) => {
      const slot = primarySlot(r);
      return {
        id: r.id,
        name: r.name,
        description: r.description || null,
        primarySlot: slot.id,
        primaryCategories: slot.categories || [slot.category],
        needs: extraNeeds(r),
        slots: (r.slots || []).map((s) => ({ id: s.id, label: s.label || s.id, categories: s.categories || [s.category], required: !!s.required })),
        defaults: recipeDefaults(r),
      };
    });
}

// ── Hugging Face search ─────────────────────────────────────────────────

const HF = "https://huggingface.co/api";
const hfFetch = (url) => fetch(url, { headers: { "User-Agent": "llmui" }, signal: AbortSignal.timeout(20000) });

const treeCache = new Map(); // "repo@sha" → tree
const searchCache = new Map(); // query → { at, infos }

async function repoTree(id, sha) {
  const key = `${id}@${sha}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const [owner, name] = id.split("/");
  const response = await hfFetch(
    `${HF}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree/${encodeURIComponent(sha || "main")}?recursive=true`
  );
  if (!response.ok) throw new Error(`tree ${id}: HTTP ${response.status}`);
  const tree = await response.json();
  treeCache.set(key, tree);
  if (treeCache.size > 300) treeCache.delete(treeCache.keys().next().value);
  return tree;
}

async function searchRepos(q) {
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.infos;
  const params = new URLSearchParams({ pipeline_tag: "text-to-image", sort: "downloads", direction: "-1", limit: "40" });
  if (q) params.set("search", q);
  for (const e of ["sha", "tags", "cardData", "config", "downloads", "likes", "gated", "lastModified"]) params.append("expand[]", e);
  const response = await hfFetch(`${HF}/models?${params}`);
  if (!response.ok) throw Object.assign(new Error(`Hugging Face search failed (HTTP ${response.status})`), { status: 502 });
  const infos = (await response.json()).filter((info) => REPO_RE.test(info.id) && !isAdapterRepo(info));
  searchCache.set(q, { at: Date.now(), infos });
  if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value);
  return infos;
}

/** Run fn over items, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

router.get("/hf/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  try {
    const recipes = await liveRecipes().catch((err) => {
      throw Object.assign(new Error(`Can't read recipes from sd-server: ${err.message}`), { status: 502 });
    });
    // Installed = in sd-server's catalog or on the helper's disk (it may not have rescanned yet).
    const [catalog, onDisk] = await Promise.all([
      liveFiles().catch(() => []),
      fetchHelper("/v1/files").then((d) => d.files || []).catch(() => []),
    ]);
    const installed = new Set([...catalog.map((f) => f.relative_path || f.id), ...onDisk.map((f) => f.path)]);
    const infos = await searchRepos(q);
    const repos = await mapLimit(infos, 8, async (info) => {
      try {
        return describeRepo(info, await repoTree(info.id, info.sha), recipes, { gpuBytes: gpuBytes(), installed });
      } catch (err) {
        console.warn(`HF file list for ${info.id} failed:`, err.message);
        return null;
      }
    });
    res.json({
      gpuBytes: gpuBytes(),
      // Only repos with at least one single-file checkpoint / diffusion model.
      repos: repos.filter((r) => r && r.files.some((f) => f.kind === "model")).slice(0, 25),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.status ? err.message : `Hugging Face unreachable: ${err.message}` });
  }
});

// ── Installed files ─────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const cfg = getSdConfig();
  const helper = { ...(await helperConfigured()), ok: false, error: null, disk: null, hfToken: null };

  await refreshSdCatalog();
  let recipes = [];
  let catalog = [];
  let sdError = null;
  try {
    [recipes, catalog] = await Promise.all([liveRecipes({ fresh: true }), liveFiles()]);
  } catch (err) {
    sdError = err.message;
  }

  let helperFiles = [];
  if (helper.configured) {
    try {
      const [files, health] = await Promise.all([fetchHelper("/v1/files"), fetchHelper("/v1/health")]);
      helperFiles = files.files || [];
      helper.disk = files.disk || null;
      helper.ok = true;
      helper.hfToken = !!health.hf_token;
    } catch (err) {
      helper.error = err.message;
    }
  } else {
    helper.error = helper.reason;
  }

  // Merge: sd-server's catalog (ids to load with) + the helper's sizes/deletability.
  const byPath = new Map(helperFiles.map((f) => [f.path, f]));
  const seen = new Set();
  const files = [];
  const add = (id, category, name, relPath, h) => {
    const setup = resolveModelSetup(id);
    files.push({
      id,
      category,
      name,
      path: relPath,
      size: h?.size ?? null,
      deletable: !!h?.deletable,
      inCatalog: !!id && catalog.some((f) => f.id === id),
      kind: MODEL_CATEGORIES.has(category) ? "model" : "component",
      setup: setup ? { recipe: setup.recipe, components: { ...setup.models } } : null,
      isDefault: id === cfg.model,
      usedByDefault: Object.values(cfg.components || {}).includes(id),
      fit: h?.size ? (h.size > gpuBytes() ? "nofit" : h.size > gpuBytes() - 1.5 * GiB ? "tight" : "fits") : "unknown",
    });
  };
  for (const f of catalog) {
    const rel = f.relative_path || f.id;
    seen.add(rel);
    add(f.id, f.category, f.name, rel, f.id === rel ? byPath.get(rel) : null);
  }
  for (const h of helperFiles) {
    if (!seen.has(h.path)) add(h.path, h.category, h.name, h.path, h); // e.g. loras/, or not rescanned yet
  }
  files.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "model" ? -1 : 1));

  res.json({
    files,
    recipes: recipeSummaries(recipes),
    default: { model: cfg.model, recipe: cfg.recipe, components: cfg.components || {} },
    gpuBytes: gpuBytes(),
    sdError,
    helper,
  });
});

// ── Install / cancel / delete ───────────────────────────────────────────

let refreshedJob = null;

router.post("/install", async (req, res) => {
  const { repo, path: filePath, revision, category, recipe: recipeId } = req.body || {};
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return res.status(400).json({ error: "invalid repo" });
  if (typeof filePath !== "string" || !filePath) return res.status(400).json({ error: "invalid path" });
  try {
    let recipe = null;
    if (recipeId) {
      recipe = (await liveRecipes()).find((r) => r.id === recipeId);
      if (!recipe) return res.status(400).json({ error: `sd-server has no recipe "${recipeId}"` });
      const slot = primarySlot(recipe);
      if (!(slot.categories || [slot.category]).includes(category)) {
        return res.status(400).json({ error: `${recipe.name} expects ${slot.categories.join("/")}/, not ${category}/` });
      }
    }
    const job = await fetchHelper("/v1/downloads", { method: "POST", body: { repo, path: filePath, revision, category } });
    if (recipe) {
      const cfg = getSdConfig();
      await saveSdConfig({
        models: {
          ...cfg.models,
          [job.file_id]: {
            recipe: recipe.id,
            slot: primarySlot(recipe).id,
            components: {},
            defaults: recipeDefaults(recipe),
            source: { repo, path: filePath, revision: job.revision },
          },
        },
      });
    }
    res.status(202).json(job);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/install/current", async (req, res) => {
  try {
    const { job } = await fetchHelper("/v1/downloads/current");
    // Make sd-server see a finished download right away.
    if (job?.state === "completed" && refreshedJob !== job.id) {
      refreshedJob = job.id;
      await refreshSdCatalog();
    }
    res.json({ job });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/install/:id/cancel", async (req, res) => {
  if (!/^[0-9a-f]{1,32}$/.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  try {
    res.json(await fetchHelper(`/v1/downloads/${req.params.id}/cancel`, { method: "POST", body: {} }));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/files/:category/:name", async (req, res) => {
  const { category, name } = req.params;
  const id = `${category}/${name}`;
  const cfg = getSdConfig();
  if (isImageJobActive()) return res.status(409).json({ error: "An image is being generated; try again when it finishes" });
  if (id === cfg.model) return res.status(409).json({ error: "This is the default image model; make another model the default first" });
  if (Object.values(cfg.components || {}).includes(id)) {
    return res.status(409).json({ error: "The default image model uses this file; change the default first" });
  }
  try {
    const result = await fetchHelper(`/v1/files/${encodeURIComponent(category)}/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (cfg.models?.[id]) {
      const { [id]: _, ...rest } = cfg.models;
      await saveSdConfig({ models: rest });
    }
    await refreshSdCatalog();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// ── Setup / default ─────────────────────────────────────────────────────

router.put("/setup", async (req, res) => {
  const { model, recipe, components, makeDefault } = req.body || {};
  if (typeof model !== "string" || typeof recipe !== "string") {
    return res.status(400).json({ error: "model and recipe are required" });
  }
  try {
    const [recipes, files] = await Promise.all([liveRecipes({ fresh: true }), liveFiles()]);
    const { error, setup } = validateSetup({ model, recipe, components: components || {} }, recipes, files);
    if (error) return res.status(400).json({ error });
    const r = recipes.find((x) => x.id === setup.recipe);
    const defaults = recipeDefaults(r);
    const cfg = getSdConfig();
    const patch = {
      models: { ...cfg.models, [model]: { ...cfg.models?.[model], ...setup, defaults } },
    };
    if (makeDefault) {
      Object.assign(patch, {
        model,
        recipe: setup.recipe,
        slot: setup.slot,
        components: setup.components,
        ...(defaults.width ? { width: defaults.width } : {}),
        ...(defaults.height ? { height: defaults.height } : {}),
        ...(defaults.steps ? { steps: defaults.steps } : {}),
        ...(defaults.cfgScale !== undefined ? { cfg: defaults.cfgScale } : {}),
        ...(defaults.sampler ? { sampler: defaults.sampler } : {}),
      });
    }
    await saveSdConfig(patch);
    res.json({ ok: true, setup, defaults, isDefault: !!makeDefault });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
