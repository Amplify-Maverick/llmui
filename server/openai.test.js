import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { streamOpenAITurn } from "./openai.js";

/** A fake llama.cpp /v1/chat/completions that streams `events` as SSE. */
async function fakeRouter(events) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    machine: { id: "test", name: "Test", isDefault: true, openaiUrl: `http://127.0.0.1:${port}/v1`, llamaKeyPath: "/nonexistent" },
    close: () => new Promise((r) => server.close(r)),
  };
}

test("streamOpenAITurn reports thinking, content, tool calls and timings", async () => {
  const router = await fakeRouter([
    { choices: [{ delta: { reasoning_content: "Let me " } }] },
    { choices: [{ delta: { reasoning_content: "think." } }] },
    { choices: [{ delta: { content: "Checking" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calculator", arguments: '{"expr' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"2+2"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], timings: { predicted_n: 12, predicted_ms: 400 } },
    "[DONE]",
  ]);
  const thinking = [];
  const content = [];
  try {
    const turn = await streamOpenAITurn({
      machine: router.machine,
      model: "m",
      messages: [{ role: "user", content: "2+2?" }],
      onContent: (t) => content.push(t),
      onThinking: (t) => thinking.push(t),
    });
    assert.deepEqual(thinking, ["Let me ", "think."]);
    assert.deepEqual(content, ["Checking"]);
    assert.equal(turn.content, "Checking");
    assert.deepEqual(turn.toolCalls, [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expr":"2+2"}' } }]);
    assert.deepEqual(turn.timings, { predicted_n: 12, predicted_ms: 400 });
  } finally {
    await router.close();
  }
});
