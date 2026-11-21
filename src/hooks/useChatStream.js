import { useCallback, useEffect } from "react";
import { useChatStore } from "../stores/chatStore.js";
import { useSettingsStore } from "../stores/settingsStore.js";
import { runsApi, readNdjson } from "../services/openaiApi.js";
import { flushDebouncedSave } from "../utils/storage.js";
import { STORAGE_KEYS } from "../constants/config.js";
import { streamSpeeds } from "../utils/streamSpeed.js";

const REATTACH_ATTEMPTS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = () => useChatStore.getState();
const END_TYPES = new Set(["done", "error", "cancelled", "interrupted"]);

/**
 * Read a server-side run's events (docs/api.md §4) until it ends, calling
 * `onEvent` for each. `open(signal)` returns the first response to read (the
 * send itself); after that, or when there's none, it reattaches by run id
 * after the last `seq`, also across a server restart. Gives up (without
 * stopping the run) once `stillOurs()` is false. Resolves
 * { ended, end: <end event or null>, error }.
 */
async function watchRun({ open = null, runId = null, stillOurs, onEvent }) {
  let seq = 0;
  let attempts = 0;
  let response = null;
  let end = null;
  const controller = new AbortController();

  while (!end) {
    try {
      response = response || (await (runId || !open ? runsApi.attach(runId, seq, controller.signal) : open(controller.signal)));
      open = null;
      for await (const e of readNdjson(response.body)) {
        if (!stillOurs()) {
          controller.abort();
          return { ended: false, end: null, error: null };
        }
        if (e.seq) seq = e.seq;
        attempts = 0;
        if (e.type === "start") runId = e.runId;
        onEvent(e);
        if (END_TYPES.has(e.type)) end = e;
      }
      response = null;
      if (!end && !runId) throw new Error("The server closed the connection before the reply started");
    } catch (err) {
      response = null;
      if (err.name === "AbortError" || !stillOurs()) return { ended: false, end: null, error: null };
      // Refused before the run started (409 busy, 400 ...), or the run is gone.
      if (!runId || err.status === 404 || ++attempts > REATTACH_ATTEMPTS) return { ended: true, end: null, error: err.message };
    }
    if (!end) await sleep(Math.min(1000 * attempts, 5000)); // connection dropped (or the server restarted): reattach
  }
  return { ended: true, end, error: end.type === "error" || end.type === "interrupted" ? end.error || "Interrupted" : null };
}

/**
 * Watch a single run, feeding its events into the chat store's streaming
 * fields. Then shows the stored messages.
 */
async function followRun(conversationId, open, { startTime = Date.now(), runId = null } = {}) {
  let timings = null;
  const stillOurs = () => store().streamOwner === conversationId;
  const result = await watchRun({
    open,
    runId,
    stillOurs,
    onEvent: (e) => {
      switch (e.type) {
        case "start":
          store().setActiveRunId(e.runId);
          // Continuing a reply: the stream adds to the text it already has.
          if (e.continues) useChatStore.setState({ streamingContent: e.content || "", streamingThinking: e.thinking || "" });
          // Stop was pressed before the run had an id.
          if (store().stopRequested) runsApi.cancel(e.runId).catch(() => {});
          break;
        case "thinking":
          store().appendStreamThinking(e.content);
          break;
        case "content":
          store().appendStreamContent(e.content);
          break;
        case "tool_call":
          store().appendToolCall({ id: e.id, name: e.name, arguments: e.arguments });
          break;
        case "tool_result":
          store().completeToolCall(e.id, e.result, e.error);
          break;
        case "done":
          timings = e.timings || null;
          break;
      }
    },
  });
  if (!result.ended || !stillOurs()) return;
  const { streamingTokenCount, streamingFirstTokenTime } = store();
  const { tokensPerSec, promptPerSec } = streamSpeeds(timings, streamingTokenCount, streamingFirstTokenTime);
  const extras = { duration: (Date.now() - startTime) / 1000 };
  if (promptPerSec) extras.promptPerSec = promptPerSec;
  // The server stores llama.cpp's own speed; without timings, show ours.
  if (!timings && tokensPerSec) extras.tokensPerSec = tokensPerSec;
  useChatStore.setState({ stopRequested: false });
  // An interrupted reply is stored with its own label; no error bubble for it.
  const error = result.end?.type === "interrupted" ? null : result.error;
  await store().finishRun({ conversationId, messageId: result.end?.messageId ?? null, extras, error });
}

/** Watch one side of a Compare, feeding its events into compareLive.sides[slot]. */
function followCompareSide(conversationId, slot, { open = null, runId = null }) {
  const stillOurs = () => store().streamOwner === conversationId && !!store().compareLive;
  const side = (fn) => store().updateCompareSide(slot, fn);
  return watchRun({
    open,
    runId,
    stillOurs,
    onEvent: (e) => {
      switch (e.type) {
        case "start":
          side(() => ({
            runId: e.runId,
            model: e.model,
            machine: e.machine,
            ...(e.continues ? { content: e.content || "", thinking: e.thinking || "" } : {}),
          }));
          if (store().stopRequested) runsApi.cancel(e.runId).catch(() => {});
          break;
        case "thinking":
          side((s) => ({ thinking: s.thinking + e.content }));
          break;
        case "content":
          side((s) => ({ content: s.content + e.content }));
          break;
        case "tool_call":
          side((s) => ({ toolCalls: [...s.toolCalls, { id: e.id, name: e.name, arguments: e.arguments, status: "calling" }] }));
          break;
        case "tool_result":
          side((s) => ({ toolCalls: s.toolCalls.map((t) => (t.id === e.id ? { ...t, status: "completed", result: e.result, error: e.error } : t)) }));
          break;
        case "done":
          side(() => ({ status: "done", tokensPerSec: e.timings?.predicted_per_second ?? null }));
          break;
        case "error":
          side(() => ({ status: "error", error: e.error }));
          break;
        case "cancelled":
        case "interrupted":
          side(() => ({ status: e.type }));
          break;
      }
    },
  }).then((result) => {
    if (result.ended && !result.end) side(() => ({ status: "error", error: result.error }));
    return result;
  });
}

/** A Compare side as it starts: empty, or the reply being continued. */
const liveSide = ({ model = null, machine = null, runId = null, from = null } = {}) => ({
  runId,
  model,
  machine,
  content: from?.content || "",
  thinking: from?.thinking || "",
  toolCalls: from?.toolCalls || [],
  status: "running",
  error: null,
});

/** Watch Compare sides until all end, then show the stored messages. */
async function followCompare(conversationId, watches) {
  const results = await Promise.all(watches);
  if (store().streamOwner !== conversationId || !results.every((r) => r.ended)) return;
  useChatStore.setState({ stopRequested: false });
  // Per-side errors were shown in their columns while streaming; a request
  // refused outright (nothing started) gets the usual error bubble.
  const refused = results.every((r) => !r.end) ? results[0].error : null;
  await store().finishRun({ conversationId, error: refused });
}

export function useChatStream() {
  const {
    activeConversationId,
    conversations,
    isStreaming,
    streamingContent,
    addMessage,
    setStreaming,
    createConversation,
    updateConversationModel,
    removeLastAssistantMessage,
  } = useChatStore();

  const globalSettings = useSettingsStore();
  const currentConv = conversations.find((c) => c.id === activeConversationId);

  // Per-conversation settings if set, otherwise global. Sent explicitly so
  // the server runs exactly what this page shows.
  const turnSettings = useCallback(
    (model) => {
      const enableTools = currentConv?.enableTools ?? globalSettings.enableTools;
      const enabledTools = currentConv?.enabledTools ?? globalSettings.enabledTools;
      return {
        ...(model ? { model } : {}),
        temperature: currentConv?.temperature ?? globalSettings.temperature,
        maxTokens: currentConv?.maxTokens ?? globalSettings.maxTokens,
        systemPrompt: currentConv?.systemPrompt ?? globalSettings.systemPrompt ?? "",
        enableThinking: !!(currentConv?.enableThinking ?? globalSettings.enableThinking),
        enabledTools: enableTools && enabledTools?.length ? enabledTools : [],
      };
    },
    [currentConv, globalSettings]
  );

  /** Start a run in `convId` with `body` and watch it. `from`: the reply being continued. */
  const run = useCallback(
    async (convId, body, model, from = null) => {
      // Anything this page hasn't stored yet must be on the server first:
      // the server builds the history from what it has.
      await flushDebouncedSave(STORAGE_KEYS.convMessages(convId));
      addMessage({ role: "assistant", content: "", model }, { save: false });
      setStreaming(true, from?.content || "", convId, from?.thinking || "");
      useChatStore.setState({ stopRequested: false });
      await followRun(convId, (signal) => runsApi.send(convId, body, signal));
    },
    [addMessage, setStreaming]
  );

  /** Ensure a chat to send into, creating one for a first message. */
  const chatFor = useCallback(
    async (model) => {
      if (activeConversationId) {
        if (model) updateConversationModel(model);
        return activeConversationId;
      }
      return createConversation(model);
    },
    [activeConversationId, createConversation, updateConversationModel]
  );

  const userMessageFor = (content, images) => {
    const msg = { role: "user", content };
    if (images.length > 0) msg.images = images;
    return msg;
  };
  const imagesBody = (images) =>
    images.length ? images.map(({ name, type, size, data }) => ({ name, type, size, data })) : undefined;

  const sendMessage = useCallback(
    async (content, model, images = []) => {
      if (!model) throw new Error("No model selected");
      const convId = await chatFor(model);
      if (!convId) return;
      addMessage(userMessageFor(content, images), { save: false });
      await run(convId, { ...turnSettings(model), content, images: imagesBody(images) }, model);
    },
    [chatFor, addMessage, run, turnSettings]
  );

  /**
   * Compare: send `content` to two models at once, each on its own machine.
   * `sides`: [{ model, machine }, { model, machine }].
   */
  const sendCompare = useCallback(
    async (content, sides, images = []) => {
      if (sides.length !== 2 || sides.some((s) => !s.model)) throw new Error("Pick two models to compare");
      const convId = await chatFor(null);
      if (!convId) return;
      await flushDebouncedSave(STORAGE_KEYS.convMessages(convId));
      addMessage(userMessageFor(content, images), { save: false });
      store().startCompareLive(convId, null, { 0: liveSide(sides[0]), 1: liveSide(sides[1]) });
      useChatStore.setState({ stopRequested: false });
      let started;
      try {
        started = await runsApi.compare(convId, { ...turnSettings(null), content, images: imagesBody(images), sides });
      } catch (err) {
        await store().finishRun({ conversationId: convId, error: err.message });
        return;
      }
      if (store().streamOwner !== convId) return;
      useChatStore.setState((s) => ({ compareLive: s.compareLive && { ...s.compareLive, group: started.compareGroup } }));
      if (store().stopRequested) started.runs.forEach((r) => runsApi.cancel(r.id).catch(() => {}));
      await followCompare(
        convId,
        started.runs.map((r) => followCompareSide(convId, r.compareSlot, { runId: r.id }))
      );
    },
    [chatFor, addMessage, turnSettings]
  );

  /** One side of a Compare, run again (`regenerate`) or continued, in place. */
  const runCompareSide = useCallback(
    async (message, body) => {
      const convId = store().activeConversationId;
      if (!convId) return;
      await flushDebouncedSave(STORAGE_KEYS.convMessages(convId));
      const from = body.continue ? message : null;
      store().startCompareLive(convId, message.compareGroup, {
        [message.compareSlot]: liveSide({ model: message.model, machine: message.machine, from }),
      });
      useChatStore.setState({ stopRequested: false });
      await followCompare(convId, [
        followCompareSide(convId, message.compareSlot, { open: (signal) => runsApi.send(convId, body, signal) }),
      ]);
    },
    []
  );

  // Answer the chat as it stands (its last message is a user message), e.g.
  // a branch made by editing a message.
  const replyToHistory = useCallback(
    async (model) => {
      if (!model || !store().activeConversationId) return;
      await run(store().activeConversationId, turnSettings(model), model);
    },
    [run, turnSettings]
  );

  const regenerateLastMessage = useCallback(
    async (model) => {
      if (!model) throw new Error("No model selected");
      const convId = store().activeConversationId;
      if (!convId) return;
      removeLastAssistantMessage({ save: false });
      await run(convId, { ...turnSettings(model), regenerate: true }, model);
    },
    [removeLastAssistantMessage, run, turnSettings]
  );

  /**
   * Continue a reply that was cut off (status "interrupted"): the server
   * sends the partial text to the reply's own model and machine and appends
   * the rest to the same message.
   */
  const continueReply = useCallback(
    async (message) => {
      const convId = store().activeConversationId;
      if (!convId || !message) return;
      const body = { ...turnSettings(null), continue: true, messageId: message.id };
      if (message.compareGroup) return runCompareSide(message, body);
      // The streaming bubble takes over showing this reply.
      useChatStore.setState((s) => ({ messages: s.messages.filter((m) => m.id !== message.id) }));
      await run(convId, body, message.model, message);
    },
    [run, runCompareSide, turnSettings]
  );

  /** Retry one reply: a Compare side with its own model and machine, else the usual regenerate. */
  const retryReply = useCallback(
    async (message, model) => {
      if (!message) return;
      if (message.compareGroup) return runCompareSide(message, { ...turnSettings(null), regenerate: true, messageId: message.id });
      await regenerateLastMessage(model);
    },
    [regenerateLastMessage, runCompareSide, turnSettings]
  );

  // Stop generating: the server stores what was written so far and the
  // stream ends with "cancelled".
  const stopStreaming = useCallback(() => {
    const { activeRunId, compareLive } = store();
    const ids = compareLive ? Object.values(compareLive.sides).map((s) => s.runId).filter(Boolean) : [activeRunId].filter(Boolean);
    if (ids.length) ids.forEach((id) => runsApi.cancel(id).catch((err) => console.error("Cancel failed:", err)));
    else useChatStore.setState({ stopRequested: true });
  }, []);

  // Opening a chat whose reply (or Compare) is still being generated (after a
  // reload, on another device, or after switching away): watch it from the start.
  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    (async () => {
      const turn = await runsApi.latestTurn(activeConversationId).catch(() => []);
      const running = turn.filter((r) => r.status === "running");
      if (cancelled || !running.length) return;
      const s = store();
      if (s.activeConversationId !== activeConversationId || s.isStreaming) return;
      if (running[0].compareGroup) {
        const sides = {};
        for (const r of running) sides[r.compareSlot] = liveSide({ model: r.model, machine: r.machine, runId: r.id });
        s.startCompareLive(activeConversationId, running[0].compareGroup, sides);
        await followCompare(
          activeConversationId,
          running.map((r) => followCompareSide(activeConversationId, r.compareSlot, { runId: r.id }))
        );
        return;
      }
      const current = running[0];
      s.addMessage({ role: "assistant", content: "", model: current.model }, { save: false });
      s.setStreaming(true, "", activeConversationId);
      if (current.continues) {
        // Its stored reply is what the stream is adding to: shown by the streaming bubble.
        useChatStore.setState((st) => ({ messages: st.messages.filter((m) => m.id !== current.continues) }));
      }
      await followRun(activeConversationId, null, { runId: current.id, startTime: current.startedAt });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  return {
    sendMessage,
    sendCompare,
    replyToHistory,
    stopStreaming,
    regenerateLastMessage,
    continueReply,
    retryReply,
    isStreaming,
    streamingContent,
  };
}
