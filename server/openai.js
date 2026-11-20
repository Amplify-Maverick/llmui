/**
 * OpenAI-compatible backend (llama.cpp server, vLLM, LM Studio, ...).
 *
 * This is LLMUI's only model source.
 *
 * - `openaiRouter`: authenticated streaming passthrough mounted at /openai/v1.
 *   The browser never talks to the upstream directly.
 * - `streamOpenAITurn`: one model turn for the server-side tool loop, parsing
 *   SSE and accumulating streamed tool-call deltas.
 *
 * Requests go to the machine chat is routed to (req.machine, set by chatGate
 * or resolveMachine("chat"); see server/backends.js). Every upstream request
 * carries that machine's API key (see llama.js).
 */

import express from "express";
import { OPENAI_BASE_URL, llamaHeaders, upstreamError } from "./llama.js";
import {
  defaultMachine,
  resolveMachine,
  markServiceDown,
  isConnectError,
  networkErrorText,
} from "./backends.js";
import { isImageJobActive, trackChat, imageBusyBody, IMAGE_BUSY_MESSAGE } from "./sd.js";

export { OPENAI_BASE_URL };

// ------------------------------------------------------------
// Upstream fetch with fallback to the default machine
// ------------------------------------------------------------

const openaiRequest = (machine, upstreamPath, init) =>
  fetch(`${machine.openaiUrl}${upstreamPath}`, { ...init, headers: llamaHeaders(machine, init.headers) });

/**
 * fetch() a path under a machine's /v1. If the machine isn't the default and
 * can't be reached at all (no response), its router is marked down and the
 * request is retried on the default machine, unless an image job holds that
 * GPU (then it throws with status 409). `res`, if given, is counted as an
 * in-flight chat on the fallback machine. Returns { response, machine }.
 */
export async function openaiFetch(machine, upstreamPath, init = {}, { res } = {}) {
  try {
    return { response: await openaiRequest(machine, upstreamPath, init), machine };
  } catch (err) {
    if (machine.isDefault || !isConnectError(err)) throw err;
    const reason = networkErrorText(err);
    markServiceDown(machine, "chat", reason);
    const fallback = defaultMachine();
    console.warn(`${machine.name} router unreachable (${reason}); retrying on ${fallback.name}`);
    if (isImageJobActive(fallback)) {
      throw Object.assign(new Error(IMAGE_BUSY_MESSAGE), { status: 409 });
    }
    if (res) trackChat(fallback, res);
    return { response: await openaiRequest(fallback, upstreamPath, init), machine: fallback };
  }
}

// ------------------------------------------------------------
// SSE parsing
// ------------------------------------------------------------

/** Yield the `data:` payload of each SSE event, buffering across chunks. */
export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

// ------------------------------------------------------------
// Message conversion (app message shape → OpenAI)
// ------------------------------------------------------------

/** Convert an app message ({ role, content, images?: [base64] }) to OpenAI format. */
export function toOpenAIMessage(msg) {
  if (!msg.images || msg.images.length === 0) {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: [
      { type: "text", text: msg.content },
      ...msg.images.map((b64) => ({
        type: "image_url",
        image_url: {
          url: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`,
        },
      })),
    ],
  };
}

// ------------------------------------------------------------
// Authenticated passthrough
// ------------------------------------------------------------

/**
 * Forward a request upstream and pipe the response back unchanged, chunk by
 * chunk. Aborts the upstream request if the client disconnects so the model
 * stops generating.
 */
async function forward(req, res, upstreamPath, init = {}) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const target = req.machine || resolveMachine("chat").machine;

  try {
    const { response, machine } = await openaiFetch(
      target,
      upstreamPath,
      { ...init, signal: controller.signal },
      { res }
    );

    res.status(response.status);
    res.setHeader("X-LLMUI-Machine", machine.id);
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentType?.includes("text/event-stream")) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no"); // nginx: don't buffer SSE
    }
    res.flushHeaders();

    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    if (err.name === "AbortError") {
      if (!res.writableEnded) res.end();
      return;
    }
    if (err.status === 409 && !res.headersSent) {
      return res.status(409).json(imageBusyBody("openai"));
    }
    console.error(`Error proxying ${upstreamPath} to ${target.name}'s model server:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: `Failed to connect to ${target.name}'s model server` },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export const openaiRouter = express.Router();

openaiRouter.get("/models", (req, res) => forward(req, res, "/models"));

openaiRouter.post("/chat/completions", (req, res) =>
  forward(req, res, "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: req.body?.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(req.body),
  })
);

// ------------------------------------------------------------
// Tool loop: a single streamed turn
// ------------------------------------------------------------

/**
 * Run one streamed chat turn against the OpenAI-compatible server.
 * Calls onContent(text) for each content delta as it arrives.
 * `machine` is where to send it (falls back like openaiFetch; `res` is the
 * client response, counted as in flight on a fallback machine).
 * Returns { content, toolCalls, timings, machine } with tool calls in OpenAI format
 * ({ id, type, function: { name, arguments: string } }) and llama.cpp's
 * server-measured `timings` (null if the server doesn't send them).
 * Throws an Error with the upstream message on a non-2xx response.
 */
export async function streamOpenAITurn({
  machine,
  res,
  model,
  messages,
  tools,
  modelOptions = {},
  enableThinking = false,
  signal,
  onContent,
}) {
  const body = {
    model,
    messages,
    stream: true,
    chat_template_kwargs: { enable_thinking: !!enableThinking },
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (modelOptions.temperature != null) body.temperature = modelOptions.temperature;
  if (modelOptions.num_predict != null) body.max_tokens = modelOptions.num_predict;

  const { response, machine: usedMachine } = await openaiFetch(
    machine,
    "/chat/completions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    },
    { res }
  );
  if (!response.ok) {
    throw new Error(await upstreamError(response));
  }

  let content = "";
  let timings = null;
  const calls = []; // accumulated by delta index

  for await (const data of readSSE(response.body)) {
    if (data === "[DONE]") break;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.error) {
      throw new Error(event.error.message || String(event.error));
    }
    // llama.cpp attaches timings to the final chunk
    if (event.timings) timings = event.timings;
    const delta = event.choices?.[0]?.delta || {};
    if (delta.content) {
      content += delta.content;
      onContent(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? calls.length;
      const call = (calls[i] ||= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  }

  return { content, toolCalls: calls.filter(Boolean), timings, machine: usedMachine };
}

/**
 * Combine llama.cpp `timings` from several turns (tool loop) into one, with
 * rates recomputed from summed token counts and milliseconds.
 */
export function combineTimings(list) {
  const valid = list.filter(Boolean);
  if (valid.length === 0) return null;
  const sum = (k) => valid.reduce((acc, t) => acc + (Number(t[k]) || 0), 0);
  const predicted_n = sum("predicted_n");
  const predicted_ms = sum("predicted_ms");
  const prompt_n = sum("prompt_n");
  const prompt_ms = sum("prompt_ms");
  return {
    predicted_n,
    predicted_ms,
    predicted_per_second: predicted_ms > 0 ? (predicted_n / predicted_ms) * 1000 : null,
    prompt_n,
    prompt_ms,
    prompt_per_second: prompt_ms > 0 ? (prompt_n / prompt_ms) * 1000 : null,
  };
}
