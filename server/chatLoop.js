/**
 * The chat turn loop shared by POST /api/chat-with-tools (client-managed
 * history) and server-side runs (POST /api/conversations/:id/send): stream a
 * model turn, run any tool calls, feed the results back, and repeat until the
 * model answers without tools or MAX_TOOL_ITERATIONS is hit.
 *
 * Events passed to emit() are the NDJSON events documented in docs/api.md §4.2:
 * thinking, content, tool_call, tool_result. The caller emits done / error.
 */

import { nanoid } from "nanoid";
import { streamOpenAITurn, combineTimings } from "./openai.js";
import { executeTool as realExecuteTool } from "./tools/index.js";

export const MAX_TOOL_ITERATIONS = 5;

const aborted = () => new DOMException("Request aborted", "AbortError");

/**
 * Returns { iterations, machine, timings }. Throws AbortError when `signal`
 * aborts, an Error with code "max_iterations" after MAX_TOOL_ITERATIONS turns,
 * or the upstream error. `track(machine)` is called if a turn falls back to
 * another machine (so it can be counted as in flight there).
 */
export async function runToolLoop({
  machine,
  model,
  messages,
  tools,
  modelOptions = {},
  enableThinking = false,
  signal,
  emit,
  res,
  track,
  executeTool = realExecuteTool,
  streamTurn = streamOpenAITurn,
}) {
  const current = messages.slice();
  const turnTimings = [];
  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    if (signal?.aborted) throw aborted();
    iterations++;
    const turn = await streamTurn({
      machine,
      res,
      track,
      model,
      messages: current,
      tools,
      modelOptions,
      enableThinking,
      signal,
      onContent: (text) => emit({ type: "content", content: text }),
      onThinking: (text) => emit({ type: "thinking", content: text }),
    });
    machine = turn.machine;
    turnTimings.push(turn.timings);

    if (turn.toolCalls.length === 0) {
      return { iterations, machine, timings: combineTimings(turnTimings) };
    }

    // Every call needs an id so its tool result can reference it
    for (const tc of turn.toolCalls) tc.id ||= `call_${nanoid()}`;
    current.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });

    for (const tc of turn.toolCalls) {
      if (signal?.aborted) throw aborted();
      let args = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args || "{}");
        } catch {
          args = {};
        }
      }
      emit({ type: "tool_call", id: tc.id, name: tc.function.name, arguments: args });
      const result = await executeTool(tc.function.name, args);
      if (signal?.aborted) throw aborted();
      emit({
        type: "tool_result",
        id: tc.id,
        name: tc.function.name,
        result: result.success ? result.result : null,
        error: result.success ? null : result.error,
      });
      current.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result.success ? result.result : { error: result.error }),
      });
    }
  }
  throw Object.assign(new Error("Max tool iterations reached"), { code: "max_iterations" });
}
