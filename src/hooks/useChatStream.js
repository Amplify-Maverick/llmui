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

/**
 * Watch a server-side run (docs/api.md §4.1) until it ends, feeding its
 * events into the chat store. `open(after, signal)` returns the response to
 * read: the send itself first, then reattaches by run id after `seq` if the
 * connection drops. Stops watching (without stopping the run) if the user
 * leaves the chat. Then shows the stored messages.
 */
async function followRun(conversationId, open, { startTime = Date.now(), runId = null } = {}) {
  let seq = 0;
  let timings = null;
  let messageId = null;
  let error = null;
  let ended = false;
  let attempts = 0;
  let response = null;
  const controller = new AbortController();
  const stillOurs = () => store().streamOwner === conversationId;

  while (!ended) {
    try {
      response = response || (await (runId ? runsApi.attach(runId, seq, controller.signal) : open(controller.signal)));
      for await (const e of readNdjson(response.body)) {
        if (!stillOurs()) {
          controller.abort();
          return;
        }
        if (e.seq) seq = e.seq;
        attempts = 0;
        switch (e.type) {
          case "start":
            runId = e.runId;
            store().setActiveRunId(e.runId);
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
            messageId = e.messageId;
            ended = true;
            break;
          case "error":
            error = e.error;
            messageId = e.messageId;
            ended = true;
            break;
          case "cancelled":
            messageId = e.messageId;
            ended = true;
            break;
        }
      }
      response = null;
      if (!ended && !runId) throw new Error("The server closed the connection before the reply started");
    } catch (err) {
      response = null;
      if (err.name === "AbortError" || !stillOurs()) return;
      // Refused before the run started (409 busy, 400 ...), or the run is gone.
      if (!runId || err.status === 404 || ++attempts > REATTACH_ATTEMPTS) {
        error = err.message;
        ended = true;
        break;
      }
    }
    if (!ended) await sleep(Math.min(1000 * attempts, 5000)); // connection dropped: reattach
  }

  if (!stillOurs()) return;
  const { streamingTokenCount, streamingFirstTokenTime } = store();
  const { tokensPerSec, promptPerSec } = streamSpeeds(timings, streamingTokenCount, streamingFirstTokenTime);
  const extras = { duration: (Date.now() - startTime) / 1000 };
  if (promptPerSec) extras.promptPerSec = promptPerSec;
  // The server stores llama.cpp's own speed; without timings, show ours.
  if (!timings && tokensPerSec) extras.tokensPerSec = tokensPerSec;
  useChatStore.setState({ stopRequested: false });
  await store().finishRun({ conversationId, messageId, extras, error });
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
        model,
        temperature: currentConv?.temperature ?? globalSettings.temperature,
        maxTokens: currentConv?.maxTokens ?? globalSettings.maxTokens,
        systemPrompt: currentConv?.systemPrompt ?? globalSettings.systemPrompt ?? "",
        enableThinking: !!(currentConv?.enableThinking ?? globalSettings.enableThinking),
        enabledTools: enableTools && enabledTools?.length ? enabledTools : [],
      };
    },
    [currentConv, globalSettings]
  );

  /** Start a run in `convId` with `body` and watch it. */
  const run = useCallback(
    async (convId, body, model) => {
      // Anything this page hasn't stored yet must be on the server first:
      // the server builds the history from what it has.
      await flushDebouncedSave(STORAGE_KEYS.convMessages(convId));
      addMessage({ role: "assistant", content: "", model }, { save: false });
      setStreaming(true, "", convId);
      useChatStore.setState({ stopRequested: false });
      await followRun(convId, (signal) => runsApi.send(convId, body, signal));
    },
    [addMessage, setStreaming]
  );

  const sendMessage = useCallback(
    async (content, model, images = []) => {
      if (!model) throw new Error("No model selected");
      let convId = activeConversationId;
      if (!convId) {
        convId = await createConversation(model);
        if (!convId) return;
      } else {
        updateConversationModel(model);
      }
      const userMessage = { role: "user", content };
      if (images.length > 0) userMessage.images = images;
      addMessage(userMessage, { save: false });
      await run(
        convId,
        {
          ...turnSettings(model),
          content,
          images: images.length ? images.map(({ name, type, size, data }) => ({ name, type, size, data })) : undefined,
        },
        model
      );
    },
    [activeConversationId, createConversation, updateConversationModel, addMessage, run, turnSettings]
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

  // Stop generating: the server stores what was written so far and the
  // stream ends with "cancelled".
  const stopStreaming = useCallback(() => {
    const { activeRunId } = store();
    if (activeRunId) runsApi.cancel(activeRunId).catch((err) => console.error("Cancel failed:", err));
    else useChatStore.setState({ stopRequested: true });
  }, []);

  // Opening a chat whose reply is still being generated (after a reload, on
  // another device, or after switching away): watch it from the start.
  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    (async () => {
      const current = await runsApi.forConversation(activeConversationId).catch(() => null);
      if (cancelled || current?.status !== "running") return;
      const s = store();
      if (s.activeConversationId !== activeConversationId || s.isStreaming) return;
      s.addMessage({ role: "assistant", content: "", model: current.model }, { save: false });
      s.setStreaming(true, "", activeConversationId);
      await followRun(activeConversationId, null, { runId: current.id, startTime: current.startedAt });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  return {
    sendMessage,
    replyToHistory,
    stopStreaming,
    regenerateLastMessage,
    isStreaming,
    streamingContent,
  };
}
