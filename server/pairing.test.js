import { test } from "node:test";
import assert from "node:assert/strict";
import { publicUrl, pairingText, parsePairingText, PAIR_PREFIX } from "./pairing.js";

test("publicUrl prefers LLMUI_PUBLIC_URL, then the first https allowed origin", () => {
  assert.equal(publicUrl({ LLMUI_PUBLIC_URL: "https://a.example:8452/" }), "https://a.example:8452");
  assert.equal(
    publicUrl({ LLMUI_ALLOWED_ORIGINS: "http://localhost:3000, https://box.tailde6c83.ts.net:8452" }),
    "https://box.tailde6c83.ts.net:8452"
  );
  assert.equal(publicUrl({ LLMUI_PUBLIC_URL: "not a url", LLMUI_ALLOWED_ORIGINS: "http://x:1" }), null);
  assert.equal(publicUrl({}), null);
});

test("pairing text round-trips and rejects other payloads", () => {
  const text = pairingText("https://box.example:8452", "ab".repeat(32));
  assert.ok(text.startsWith(PAIR_PREFIX));
  assert.equal(text, 'llmui-pair:v1:{"url":"https://box.example:8452","token":"' + "ab".repeat(32) + '"}');
  assert.deepEqual(parsePairingText(text), { url: "https://box.example:8452", token: "ab".repeat(32) });
  assert.equal(parsePairingText("llmui-pair:v2:{}"), null);
  assert.equal(parsePairingText("llmui-pair:v1:not json"), null);
  assert.equal(parsePairingText('llmui-pair:v1:{"url":1}'), null);
});
