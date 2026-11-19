import { test } from "node:test";
import assert from "node:assert/strict";
import { streamSpeeds, liveTokensPerSec } from "./streamSpeed.js";

test("server timings win over client timing", () => {
  const r = streamSpeeds({ predicted_per_second: 32.4, prompt_per_second: 410.2 }, 10, 1000, 2000);
  assert.deepEqual(r, { tokensPerSec: 32.4, promptPerSec: 410.2, source: "server" });
});

test("fallback measures from the first token, not the request", () => {
  // 33 tokens; first arrived at t=5s (after a slow load), last at t=6s
  const r = streamSpeeds(null, 33, 5000, 6000);
  assert.equal(r.source, "client");
  assert.equal(r.tokensPerSec, 32);
  assert.equal(r.promptPerSec, null);
});

test("no rate from fewer than two tokens", () => {
  assert.equal(liveTokensPerSec(1, 1000, 2000), null);
  assert.equal(liveTokensPerSec(5, null, 2000), null);
});
