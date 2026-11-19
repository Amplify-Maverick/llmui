import { useState, useRef, useCallback } from "react";
import { openaiApi } from "../services/openaiApi.js";
import { llamaApi } from "../services/llamaApi.js";
import { useSettingsStore } from "../stores/settingsStore.js";
import { useModelsStore } from "../stores/modelsStore.js";
import { planCompare } from "../utils/comparePlan.js";
import { streamSpeeds } from "../utils/streamSpeed.js";

/*
 * Two-model compare on a single GPU behind the llama.cpp router.
 *
 * planCompare() picks the mode from measured GPU memory:
 *  - parallel:   free the GPU of other models, load A and B, stream both at once
 *  - sequential: free the GPU, load A, stream A, unload A, load B, stream B
 *
 * Per-model state (local, ephemeral):
 *   status: "queued" | "preparing" | "streaming" | "complete" | "error" | "aborted"
 *   phase:  human-readable step while queued/preparing
 *   content, tokenCount, firstTokenTime, startTime (request sent), endTime,
 *   loadMs (explicit load step, if we did one), timings (llama.cpp),
 *   tokensPerSec, promptPerSec, error
 */

const POLL_MS = 500;
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVE = new Set(["loaded", "loading", "sleeping"]);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function routerModels() {
  const { models, gpu } = await llamaApi.list();
  // Same shape as the models store ({ name, status, failed, memory, ... })
  return { models: models.map((m) => ({ ...m, name: m.id })), gpu };
}

/** Poll the router until `pred(model)` holds. Throws if the model fails to load. */
async function waitFor(id, pred, signal, what) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (true) {
    abortIfNeeded(signal);
    const { models } = await routerModels();
    const m = models.find((x) => x.name === id);
    if (!m) throw new Error(`${id} is no longer on the server`);
    if (pred(m)) return m;
    if (m.failed && what === "loaded") {
      throw new Error(`llama.cpp failed to load ${id}${m.exitCode != null ? ` (exit code ${m.exitCode})` : ""}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${id} to be ${what}`);
    await sleep(POLL_MS, signal);
  }
}

const ignoreAlready = (err) => {
  // "model is already running" / "not running" races are harmless here
  if (!/already|not (running|loaded)/i.test(err.message)) throw err;
};

/** Load a model and wait until it's loaded. Returns ms spent, or 0 if it already was. */
async function ensureLoaded(id, signal) {
  const { models } = await routerModels();
  const m = models.find((x) => x.name === id);
  if (!m) throw new Error(`${id} is not on the server`);
  if (m.status === "loaded") return 0;
  const t0 = Date.now();
  if (m.status !== "loading") await llamaApi.load(id).catch(ignoreAlready);
  await waitFor(id, (x) => x.status === "loaded", signal, "loaded");
  return Date.now() - t0;
}

async function ensureUnloaded(id, signal) {
  await llamaApi.unload(id).catch(ignoreAlready);
  await waitFor(id, (x) => !ACTIVE.has(x.status), signal, "unloaded");
}

export function useCompareStreams() {
  const [streams, setStreams] = useState(new Map());
  const [plan, setPlan] = useState(null);
  const [phase, setPhase] = useState(null); // overall step text
  const abortRef = useRef(null); // whole comparison
  const streamAbortRef = useRef(new Map()); // model → its own stream (Stop on one column)

  const { systemPrompt, temperature, maxTokens } = useSettingsStore();

  const updateStream = useCallback((model, updates) => {
    setStreams((prev) => {
      const next = new Map(prev);
      const cur = next.get(model) || {};
      next.set(model, { ...cur, ...(typeof updates === "function" ? updates(cur) : updates) });
      return next;
    });
  }, []);

  const refreshStore = () => useModelsStore.getState().refreshModels();

  /** Stream one model's reply. Never throws; records the outcome in state. */
  const runOne = useCallback(
    async (model, prompt, signal) => {
      const messages = [];
      if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
      messages.push({ role: "user", content: prompt });

      // Own controller so one column can be stopped; the whole-compare abort
      // still reaches it.
      const local = new AbortController();
      streamAbortRef.current.set(model, local);
      const onAbort = () => local.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) local.abort();

      const startTime = Date.now();
      updateStream(model, { status: "streaming", phase: null, startTime });
      let timings = null;
      let tokenCount = 0;
      let firstTokenTime = null;

      try {
        for await (const chunk of openaiApi.chatStream(model, messages, { temperature, maxTokens, signal: local.signal })) {
          const text = chunk.message?.content;
          if (text || chunk.message?.thinking) {
            tokenCount++;
            firstTokenTime ??= Date.now();
            const ftt = firstTokenTime;
            updateStream(model, (cur) => ({
              content: cur.content + (text || ""),
              tokenCount: cur.tokenCount + 1,
              firstTokenTime: cur.firstTokenTime ?? ftt,
            }));
          }
          if (chunk.timings) timings = chunk.timings;
          if (chunk.done) break;
        }
        const endTime = Date.now();
        const { tokensPerSec, promptPerSec } = streamSpeeds(timings, tokenCount, firstTokenTime, endTime);
        updateStream(model, { status: "complete", endTime, timings, tokensPerSec, promptPerSec });
      } catch (error) {
        const endTime = Date.now();
        if (error.name === "AbortError") {
          const { tokensPerSec } = streamSpeeds(null, tokenCount, firstTokenTime, endTime);
          updateStream(model, { status: "aborted", endTime, tokensPerSec });
        } else {
          updateStream(model, { status: "error", error: error.message, endTime });
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        streamAbortRef.current.delete(model);
      }
    },
    [systemPrompt, temperature, maxTokens, updateStream]
  );

  /** Load step for one model; on failure marks it errored and returns false. */
  const prepare = useCallback(
    async (model, signal) => {
      updateStream(model, { status: "preparing", phase: "Loading model…" });
      try {
        const loadMs = await ensureLoaded(model, signal);
        updateStream(model, { loadMs, phase: "Loaded, waiting to start" });
        return true;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        updateStream(model, { status: "error", error: error.message, endTime: Date.now() });
        return false;
      } finally {
        refreshStore();
      }
    },
    [updateStream]
  );

  /** Unload every active model except `keep`. */
  const freeGpu = useCallback(async (keep, signal) => {
    const { models } = await routerModels();
    const others = models.filter((m) => ACTIVE.has(m.status) && !keep.includes(m.name));
    for (const m of others) {
      setPhase(`Unloading ${m.name} to free the GPU…`);
      await ensureUnloaded(m.name, signal);
    }
    if (others.length) refreshStore();
  }, []);

  const startCompare = useCallback(
    async (prompt, models) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      const [a, b] = models;

      const init = new Map();
      for (const m of models) {
        init.set(m, {
          modelName: m,
          status: "queued",
          phase: "Planning…",
          content: "",
          tokenCount: 0,
          firstTokenTime: null,
          startTime: null,
          endTime: null,
          loadMs: null,
          timings: null,
          tokensPerSec: null,
          promptPerSec: null,
          error: null,
        });
      }
      setStreams(init);
      setPhase("Checking GPU memory…");

      try {
        // Plan from a fresh router snapshot, not the store's last poll.
        const { models: served, gpu } = await routerModels();
        const p = planCompare([a, b].map((id) => served.find((m) => m.name === id) || { name: id }), gpu);
        setPlan(p);

        if (p.mode === "parallel") {
          await freeGpu([a, b], signal);
          setPhase(`Loading ${a}…`);
          const okA = await prepare(a, signal);
          setPhase(`Loading ${b}…`);
          const okB = await prepare(b, signal);
          setPhase("Running both models in parallel");
          await Promise.all([okA && runOne(a, prompt, signal), okB && runOne(b, prompt, signal)]);
        } else {
          updateStream(b, { phase: `Queued: runs after ${a}` });
          await freeGpu([a], signal);
          setPhase(`Loading ${a}…`);
          if (await prepare(a, signal)) {
            setPhase(`Running ${a}`);
            await runOne(a, prompt, signal);
          }
          abortIfNeeded(signal);
          setPhase(`Unloading ${a}…`);
          updateStream(b, { phase: `Waiting for ${a} to unload…` });
          await ensureUnloaded(a, signal);
          refreshStore();
          setPhase(`Loading ${b}…`);
          if (await prepare(b, signal)) {
            setPhase(`Running ${b}`);
            await runOne(b, prompt, signal);
          }
        }
        setPhase(null);
      } catch (error) {
        // Abort or a router failure outside a single model's run: settle
        // every model that hasn't finished.
        const aborted = error.name === "AbortError";
        setPhase(aborted ? null : `Compare failed: ${error.message}`);
        setStreams((prev) => {
          const next = new Map(prev);
          for (const [m, s] of next) {
            if (s.status === "queued" || s.status === "preparing" || s.status === "streaming") {
              next.set(m, {
                ...s,
                status: aborted ? "aborted" : "error",
                error: aborted ? null : error.message,
                phase: null,
                endTime: Date.now(),
              });
            }
          }
          return next;
        });
      } finally {
        refreshStore();
      }
    },
    [freeGpu, prepare, runOne, updateStream]
  );

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Stop one model's generation; in sequential mode the other still runs.
  const stopOne = useCallback((model) => {
    streamAbortRef.current.get(model)?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setStreams(new Map());
    setPlan(null);
    setPhase(null);
  }, []);

  const values = Array.from(streams.values());
  const allComplete =
    values.length > 0 && values.every((s) => s.status === "complete" || s.status === "error" || s.status === "aborted");
  const anyStreaming = values.some((s) => s.status === "queued" || s.status === "preparing" || s.status === "streaming");

  return { streams, plan, phase, startCompare, stopAll, stopOne, reset, allComplete, anyStreaming };
}
