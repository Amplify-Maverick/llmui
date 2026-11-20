/**
 * Image models: Hugging Face search, install/delete through the sd-fetch
 * helper, and per-model setups (recipe + component files) in sd_config.json.
 * Mounted at /api/images/models (behind requireAuth and routeTo("image"), via
 * images.js): everything acts on req.machine's sd-server, helper and config.
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
  sdStatus,
} from "../sd.js";
import { fetchHelper, helperConfigured, FetchHelperError } from "../sdfetch.js";
import { publicMachine } from "../backends.js";
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

const gpuBytes = (machine) => (Number(getSdConfig(machine).gpuMemoryGiB) || 8) * GiB;

const sendError = (res, err) =>
  res.status(err instanceof FetchHelperError ? err.status : err.status && err.status < 500 ? err.status : 502)
    .json({ error: err.message });

// ── sd-server catalog (recipes are cached briefly; files are not) ───────

const recipeCache = new Map(); // machine id → { at, recipes }

async function liveRecipes(machine, { fresh = false } = {}) {
  const hit = recipeCache.get(machine.id);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.recipes;
  const data = await sdFetch(machine, "/sdcpp/v1/recipes");
  const recipes = data.recipes || [];
  recipeCache.set(machine.id, { at: Date.now(), recipes });
  return recipes;
}

async function liveFiles(machine) {
  return (await sdFetch(machine, "/sdcpp/v1/model-files")).files || [];
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
    const m = req.machine;
    const recipes = await liveRecipes(m).catch((err) => {
      throw Object.assign(new Error(`Can't read recipes from sd-server: ${err.message}`), { status: 502 });
    });
    // Installed = in sd-server's catalog or on the helper's disk (it may not have rescanned yet).
    const [catalog, onDisk] = await Promise.all([
      liveFiles(m).catch(() => []),
      fetchHelper(m, "/v1/files").then((d) => d.files || []).catch(() => []),
    ]);
    const installed = new Set([...catalog.map((f) => f.relative_path || f.id), ...onDisk.map((f) => f.path)]);
    const infos = await searchRepos(q);
    const repos = await mapLimit(infos, 8, async (info) => {
      try {
        return describeRepo(info, await repoTree(info.id, info.sha), recipes, { gpuBytes: gpuBytes(m), installed });
      } catch (err) {
        console.warn(`HF file list for ${info.id} failed:`, err.message);
        return null;
      }
    });
    res.json({
      machine: publicMachine(m),
      gpuBytes: gpuBytes(m),
      // Only repos with at least one single-file checkpoint / diffusion model.
      repos: repos.filter((r) => r && r.files.some((f) => f.kind === "model")).slice(0, 25),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.status ? err.message : `Hugging Face unreachable: ${err.message}` });
  }
});

// ── Installed files ─────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const m = req.machine;
  const cfg = getSdConfig(m);
  const helper = { ...(await helperConfigured(m)), ok: false, error: null, disk: null, hfToken: null };

  // A read-only listing for another machine (System page) doesn't rescan its
  // catalog; files the helper sees but sd-server hasn't scanned still show.
  if (!req.machineFromQuery) await refreshSdCatalog(m);
  let recipes = [];
  let catalog = [];
  let sdError = null;
  let loadedIds = new Set(); // file ids sd-server has loaded (or is loading) right now
  try {
    const [r, c, status] = await Promise.all([
      liveRecipes(m, { fresh: !req.machineFromQuery }),
      liveFiles(m),
      sdStatus(m).catch(() => null),
    ]);
    recipes = r;
    catalog = c;
    if (status && (status.state === "ready" || status.state === "loading")) {
      loadedIds = new Set(Object.values(status.models || {}).filter((v) => typeof v === "string"));
    }
  } catch (err) {
    sdError = err.message;
  }

  let helperFiles = [];
  if (helper.configured) {
    try {
      const [files, health] = await Promise.all([fetchHelper(m, "/v1/files"), fetchHelper(m, "/v1/health")]);
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
    const setup = resolveModelSetup(m, id);
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
      loaded: !!id && loadedIds.has(id),
      usedByDefault: Object.values(cfg.components || {}).includes(id),
      fit: h?.size ? (h.size > gpuBytes(m) ? "nofit" : h.size > gpuBytes(m) - 1.5 * GiB ? "tight" : "fits") : "unknown",
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
    machine: publicMachine(m),
    configFile: `~/.llmui/${m.sdConfigFile}`,
    files,
    recipes: recipeSummaries(recipes),
    default: { model: cfg.model, recipe: cfg.recipe, components: cfg.components || {} },
    gpuBytes: gpuBytes(m),
    sdError,
    helper,
  });
});

// ── Install / cancel / delete ───────────────────────────────────────────

const refreshedJob = new Map(); // machine id → last completed job id we refreshed for

router.post("/install", async (req, res) => {
  const m = req.machine;
  const { repo, path: filePath, revision, category, recipe: recipeId } = req.body || {};
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return res.status(400).json({ error: "invalid repo" });
  if (typeof filePath !== "string" || !filePath) return res.status(400).json({ error: "invalid path" });
  try {
    let recipe = null;
    if (recipeId) {
      recipe = (await liveRecipes(m)).find((r) => r.id === recipeId);
      if (!recipe) return res.status(400).json({ error: `sd-server has no recipe "${recipeId}"` });
      const slot = primarySlot(recipe);
      if (!(slot.categories || [slot.category]).includes(category)) {
        return res.status(400).json({ error: `${recipe.name} expects ${slot.categories.join("/")}/, not ${category}/` });
      }
    }
    const job = await fetchHelper(m, "/v1/downloads", { method: "POST", body: { repo, path: filePath, revision, category } });
    if (recipe) {
      const cfg = getSdConfig(m);
      await saveSdConfig(m, {
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
    res.status(202).json({ ...job, machine: m.id });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/install/current", async (req, res) => {
  try {
    const m = req.machine;
    const { job } = await fetchHelper(m, "/v1/downloads/current");
    // Make sd-server see a finished download right away.
    if (job?.state === "completed" && refreshedJob.get(m.id) !== job.id) {
      refreshedJob.set(m.id, job.id);
      await refreshSdCatalog(m);
    }
    res.json({ job, machine: m.id });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/install/:id/cancel", async (req, res) => {
  if (!/^[0-9a-f]{1,32}$/.test(req.params.id)) return res.status(400).json({ error: "invalid job id" });
  try {
    res.json(await fetchHelper(req.machine, `/v1/downloads/${req.params.id}/cancel`, { method: "POST", body: {} }));
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/files/:category/:name", async (req, res) => {
  const { category, name } = req.params;
  const id = `${category}/${name}`;
  const m = req.machine;
  const cfg = getSdConfig(m);
  if (isImageJobActive(m)) return res.status(409).json({ error: "An image is being generated; try again when it finishes" });
  if (id === cfg.model) return res.status(409).json({ error: "This is the default image model; make another model the default first" });
  if (Object.values(cfg.components || {}).includes(id)) {
    return res.status(409).json({ error: "The default image model uses this file; change the default first" });
  }
  try {
    const result = await fetchHelper(m, `/v1/files/${encodeURIComponent(category)}/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (cfg.models?.[id]) {
      const { [id]: _, ...rest } = cfg.models;
      await saveSdConfig(m, { models: rest });
    }
    await refreshSdCatalog(m);
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
  const m = req.machine;
  try {
    const [recipes, files] = await Promise.all([liveRecipes(m, { fresh: true }), liveFiles(m)]);
    const { error, setup } = validateSetup({ model, recipe, components: components || {} }, recipes, files);
    if (error) return res.status(400).json({ error });
    const r = recipes.find((x) => x.id === setup.recipe);
    const defaults = recipeDefaults(r);
    const cfg = getSdConfig(m);
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
    await saveSdConfig(m, patch);
    res.json({ ok: true, setup, defaults, isDefault: !!makeDefault });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
