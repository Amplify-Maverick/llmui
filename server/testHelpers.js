/**
 * Helpers for server tests. Call isolateHome() before importing anything that
 * touches ~/.llmui (the database, auth, machines): it points HOME at a fresh
 * temp directory, so tests never see or change real data.
 */

import fs from "fs";
import os from "os";
import path from "path";

export function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llmui-test-"));
  process.env.HOME = home;
  return home;
}

/** Listen on a random loopback port. Resolves { url, close }. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Read every NDJSON object of a fetch() response (until the server ends it). */
export async function readAllNdjson(response) {
  const text = await response.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Read every SSE `data:` JSON event of a fetch() response. */
export async function readAllSse(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"))
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}

/**
 * Read NDJSON events from a response until `until(event)` is true, then
 * cancel the body (the client disconnects). Returns the events read.
 */
export async function readNdjsonUntil(response, until) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return events;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      events.push(e);
      if (until(e)) {
        await reader.cancel();
        return events;
      }
    }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns a truthy value (or time out). */
export async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(interval);
  }
}
