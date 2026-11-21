import { test } from "node:test";
import assert from "node:assert/strict";
import { runToolLoop, MAX_TOOL_ITERATIONS } from "./chatLoop.js";

const machine = { id: "m1" };

/** A streamTurn that plays back scripted turns. */
function scripted(turns) {
  const calls = [];
  const streamTurn = async (opts) => {
    calls.push(opts.messages.map((m) => ({ ...m })));
    const t = turns[Math.min(calls.length - 1, turns.length - 1)];
    if (t.thinking) opts.onThinking(t.thinking);
    if (t.content) opts.onContent(t.content);
    return { content: t.content || "", toolCalls: structuredClone(t.toolCalls || []), timings: t.timings || null, machine };
  };
  return { streamTurn, calls };
}

test("runs a tool call, feeds the result back, and ends on a plain answer", async () => {
  const { streamTurn, calls } = scripted([
    { thinking: "use calc", toolCalls: [{ type: "function", function: { name: "calculator", arguments: '{"expression":"17*23"}' } }], timings: { predicted_n: 4, predicted_ms: 100, prompt_n: 10, prompt_ms: 50 } },
    { content: "391", timings: { predicted_n: 6, predicted_ms: 100, prompt_n: 20, prompt_ms: 50 } },
  ]);
  const events = [];
  const result = await runToolLoop({
    machine,
    model: "m",
    messages: [{ role: "user", content: "17*23?" }],
    tools: [],
    emit: (e) => events.push(e),
    streamTurn,
    executeTool: async (name, args) => ({ success: true, result: { name, args, value: 391 } }),
  });
  assert.equal(result.iterations, 2);
  assert.equal(result.timings.predicted_n, 10);
  assert.equal(result.timings.predicted_per_second, 50);
  assert.deepEqual(events.map((e) => e.type), ["thinking", "tool_call", "tool_result", "content"]);
  const call = events[1];
  assert.match(call.id, /^call_/);
  assert.deepEqual(call.arguments, { expression: "17*23" });
  assert.equal(events[2].id, call.id);
  assert.equal(events[2].error, null);
  // Second turn saw the assistant tool call and the tool result.
  assert.deepEqual(calls[1].map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(calls[1][2].tool_call_id, call.id);
});

test("stops after MAX_TOOL_ITERATIONS turns that keep calling tools", async () => {
  const { streamTurn, calls } = scripted([{ toolCalls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] }]);
  await assert.rejects(
    runToolLoop({ machine, model: "m", messages: [], tools: [], emit: () => {}, streamTurn, executeTool: async () => ({ success: false, error: "nope" }) }),
    (err) => err.code === "max_iterations"
  );
  assert.equal(calls.length, MAX_TOOL_ITERATIONS);
});

test("an aborted signal stops before the next turn", async () => {
  const controller = new AbortController();
  const { streamTurn, calls } = scripted([{ toolCalls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] }]);
  await assert.rejects(
    runToolLoop({
      machine, model: "m", messages: [], tools: [], emit: () => {}, streamTurn, signal: controller.signal,
      executeTool: async () => {
        controller.abort();
        return { success: true, result: 1 };
      },
    }),
    (err) => err.name === "AbortError"
  );
  assert.equal(calls.length, 1);
});
