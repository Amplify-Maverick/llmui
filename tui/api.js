/**
 * API client for the LLMUI TUI.
 *
 * Talks to the LLMUI Express server (default http://localhost:3001) using the
 * bearer token stored at ~/.llmui/token. This is the same backend the web UI
 * uses, so conversations created/edited here show up there and vice versa.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN_FILE = path.join(os.homedir(), ".llmui", "token");

let SERVER = process.env.LLMUI_SERVER || "http://localhost:3001";
let TOKEN = null;

export function configureServer(url) {
  if (url) SERVER = url;
}

export function getServer() {
  return SERVER;
}

export function readToken() {
  if (TOKEN) return TOKEN;
  TOKEN = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  return TOKEN;
}

function headers(extra = {}) {
  return { Authorization: `Bearer ${readToken()}`, ...extra };
}

async function request(method, p, body) {
  const opts = {
    method,
    headers: headers(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${SERVER}${p}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${p} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

export const api = {
  listConversations: ({ archived = false, limit = 200 } = {}) =>
    request("GET", `/api/conversations?archived=${archived}&limit=${limit}`),
  getMessages: (id) => request("GET", `/api/conversations/${encodeURIComponent(id)}/messages`),
  createConversation: (model, tags) =>
    request("POST", `/api/conversations`, { model: model || null, source: "tui", tags: tags || [] }),
  appendMessage: (id, message) =>
    request("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, message),
  patchConversation: (id, fields) =>
    request("PATCH", `/api/conversations/${encodeURIComponent(id)}`, fields),
  renameConversation: (id, title) =>
    request("PATCH", `/api/conversations/${encodeURIComponent(id)}`, { title }),
  deleteConversation: (id) =>
    request("DELETE", `/api/conversations/${encodeURIComponent(id)}`),
  // Models known to the llama.cpp router, via the authenticated proxy
  getModels: async () => {
    const data = await request("GET", `/api/llama/models`);
    return (data.models || []).map((m) => ({ name: m.id, size: m.size || 0, status: m.status }));
  },
  getSettings: async () => {
    const res = await request("GET", `/api/settings/llmui_settings`);
    return res.data || null;
  },
};

function buildOptions(temperature, maxTokens) {
  const o = {};
  if (typeof temperature === "number") o.temperature = temperature;
  if (typeof maxTokens === "number" && maxTokens > 0) o.num_predict = maxTokens;
  return o;
}

function* normalize(chunk) {
  if (chunk.type === "content") yield { type: "content", text: chunk.content };
  else if (chunk.type === "tool_call")
    yield { type: "tool_call", id: chunk.id, name: chunk.name, arguments: chunk.arguments };
  else if (chunk.type === "tool_result")
    yield { type: "tool_result", id: chunk.id, name: chunk.name, result: chunk.result, error: chunk.error };
  else if (chunk.type === "error") yield { type: "error", error: chunk.error };
  else if (chunk.type === "done") yield { type: "done", tokensPerSec: null };
}

/**
 * Stream a chat completion. Yields normalized events:
 *   { type: "content", text }
 *   { type: "tool_call", name }
 *   { type: "tool_result", name, preview }
 *   { type: "done", tokensPerSec }
 *   { type: "error", error }
 */
export async function* streamChat({ model, messages, temperature, maxTokens, tools, enabledTools, signal }) {
  // Always use the server-side loop against the /v1 server; with tools off it
  // gets an empty tool list and is a plain streamed completion.
  const body = {
    model,
    messages,
    enabledTools: tools ? enabledTools ?? null : [],
    options: { modelOptions: buildOptions(temperature, maxTokens) },
  };

  const res = await fetch(`${SERVER}/api/chat-with-tools`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chat failed: HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      yield* normalize(parsed);
    }
  }
  if (buf.trim()) {
    try {
      yield* normalize(JSON.parse(buf));
    } catch {
      // ignore trailing partial
    }
  }
}
