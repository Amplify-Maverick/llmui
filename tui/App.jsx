import React, { useEffect, useState, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { api, streamChat } from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import ChatPane from "./components/ChatPane.jsx";
import StatusBar from "./components/StatusBar.jsx";
import InputBar from "./components/InputBar.jsx";
import ModelPicker from "./components/ModelPicker.jsx";
import ServerPicker from "./components/ServerPicker.jsx";

const REMOTE_STATUS_POLL_MS = 15000;

// Must match src/constants/modeTags.js — TUI doesn't import from src/, so the
// tag IDs are duplicated here rather than shared.
const MODE_TAG_IDS = { local: "mode-mini", remote: "mode-gpu" };

const DEFAULTS = {
  defaultModel: "",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  enableTools: false,
  enabledTools: ["web_search", "get_current_time"],
};

const STATUS_ROWS = 1;
const INPUT_ROWS = 3; // round border (top + bottom) + 1 content row

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => stdout.off("resize", onResize);
  }, [stdout]);
  return size;
}

export default function App({ cliModel, cliTools }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [error, setError] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeConvId, setActiveConvId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const [models, setModels] = useState([]);
  const [model, setModel] = useState(cliModel || "");
  const [toolsOn, setToolsOn] = useState(Boolean(cliTools));
  const [settings, setSettings] = useState(DEFAULTS);

  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState("list"); // 'list' | 'input'
  const [mode, setMode] = useState("normal"); // 'normal' | 'rename' | 'confirmDelete' | 'model' | 'server' | 'confirmRemoteSwitch'
  const [prompt, setPrompt] = useState(""); // rename buffer
  const [pickerIndex, setPickerIndex] = useState(0);
  const [streaming, setStreaming] = useState(null); // { content, label, tools } | null
  const [toolStatus, setToolStatus] = useState(null);

  const [ollamaConfig, setOllamaConfig] = useState({
    activeTarget: null,
    remoteOllamaUrl: null,
    remoteStatus: { configured: false, online: null },
  });
  const [serverPickerIndex, setServerPickerIndex] = useState(0);

  // ─── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [savedSettings, modelsData, convData, config] = await Promise.all([
          api.getSettings().catch(() => null),
          api.getModels(),
          api.listConversations(),
          api.getOllamaConfig().catch(() => null),
        ]);
        if (config) setOllamaConfig(config);

        const s = { ...DEFAULTS, ...(savedSettings || {}) };
        setSettings(s);

        const list = modelsData.models || [];
        setModels(list);
        if (list.length === 0) {
          setFatal("No Ollama models found. Pull one first: ollama pull <model>");
          return;
        }
        const chosen =
          (cliModel && list.find((m) => m.name === cliModel || m.name.startsWith(cliModel))?.name) ||
          (s.defaultModel && list.find((m) => m.name === s.defaultModel)?.name) ||
          list[0].name;
        setModel(chosen);

        if (cliTools === undefined) setToolsOn(Boolean(s.enableTools));

        setConversations(convData.conversations || []);
        setReady(true);
      } catch (err) {
        setFatal(err.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll GPU-server reachability in the background, matching the server's own
  // poll cadence — no value in checking faster than the source refreshes.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(async () => {
      try {
        const remoteStatus = await api.getRemoteStatus();
        setOllamaConfig((c) => ({ ...c, remoteStatus }));
      } catch {
        // keep last known status on a transient failure
      }
    }, REMOTE_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [ready]);

  // Keep the sidebar selection in range as the list changes.
  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, Math.max(0, conversations.length - 1))));
  }, [conversations.length]);

  const loadConversations = useCallback(
    async (keepId, archived = showArchived) => {
      try {
        const data = await api.listConversations({ archived });
        const list = data.conversations || [];
        setConversations(list);
        if (keepId) {
          const idx = list.findIndex((c) => c.id === keepId);
          if (idx >= 0) setSelectedIndex(idx);
        }
      } catch (err) {
        setError(err.message);
      }
    },
    [showArchived]
  );

  const openConversation = useCallback(async (conv) => {
    if (!conv) return;
    setError(null);
    setActiveConvId(conv.id);
    setFocus("input");
    setLoadingMessages(true);
    setMessages([]);
    if (conv.model) setModel(conv.model);
    try {
      const data = await api.getMessages(conv.id);
      setMessages(
        (data.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          model: m.model,
          tokensPerSec: m.tokensPerSec,
          toolCalls: m.toolCalls,
        }))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const newChat = useCallback(() => {
    setActiveConvId(null);
    setMessages([]);
    setError(null);
    setFocus("input");
  }, []);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setError(null);

    let convId = activeConvId;
    try {
      if (!convId) {
        const modeTag = MODE_TAG_IDS[ollamaConfig.activeTarget] || MODE_TAG_IDS.local;
        const conv = await api.createConversation(model, [modeTag]);
        convId = conv.id;
        setActiveConvId(convId);
        setConversations((prev) => [conv, ...prev]);
        setSelectedIndex(0);
      }

      const userMsg = { role: "user", content: text };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      await api.appendMessage(convId, { role: "user", content: text });

      const payload = [];
      if (settings.systemPrompt) payload.push({ role: "system", content: settings.systemPrompt });
      for (const m of nextMessages) {
        if (m.role === "user" || m.role === "assistant" || m.role === "system") {
          payload.push({ role: m.role, content: m.content });
        }
      }

      const toolCalls = [];
      let acc = "";
      let tps = null;
      const pushStream = () =>
        setStreaming({ content: acc, label: model, tools: toolCalls.map((t) => ({ ...t })) });
      pushStream();

      try {
        for await (const ev of streamChat({
          model,
          messages: payload,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          tools: toolsOn,
          enabledTools: settings.enabledTools,
        })) {
          if (ev.type === "content") {
            acc += ev.text;
            pushStream();
          } else if (ev.type === "tool_call") {
            setToolStatus(ev.name);
            toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
            pushStream();
          } else if (ev.type === "tool_result") {
            let t = ev.id ? toolCalls.find((x) => x.id === ev.id) : null;
            if (!t) t = [...toolCalls].reverse().find((x) => x.name === ev.name && x.result === undefined && x.error == null);
            if (t) {
              t.result = ev.result;
              t.error = ev.error;
            }
            setToolStatus(null);
            pushStream();
          } else if (ev.type === "done") {
            if (ev.tokensPerSec) tps = ev.tokensPerSec;
          } else if (ev.type === "error") {
            setError(ev.error);
          }
        }
      } catch (err) {
        setError(err.message);
      }

      setStreaming(null);
      setToolStatus(null);

      if (acc || toolCalls.length) {
        const persistTools = toolCalls.length ? toolCalls : undefined;
        const assistantMsg = { role: "assistant", content: acc, model, tokensPerSec: tps, toolCalls: persistTools };
        setMessages((prev) => [...prev, assistantMsg]);
        await api
          .appendMessage(convId, { role: "assistant", content: acc, model, tokensPerSec: tps, toolCalls: persistTools })
          .catch((err) => setError(err.message));
      }

      loadConversations(convId);
    } catch (err) {
      setStreaming(null);
      setToolStatus(null);
      setError(err.message);
    }
  }, [draft, streaming, activeConvId, model, messages, settings, toolsOn, loadConversations, ollamaConfig.activeTarget]);

  // ─── Conversation management ───────────────────────────────────────────────
  const startRename = useCallback(() => {
    const conv = conversations[selectedIndex];
    if (!conv) return;
    setPrompt(conv.title || "");
    setMode("rename");
  }, [conversations, selectedIndex]);

  const commitRename = useCallback(async () => {
    const conv = conversations[selectedIndex];
    setMode("normal");
    if (!conv) return;
    const title = prompt.trim();
    if (!title || title === conv.title) return;
    setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, title } : c)));
    try {
      await api.renameConversation(conv.id, title);
    } catch (err) {
      setError(err.message);
    }
  }, [conversations, selectedIndex, prompt]);

  const toggleArchiveSelected = useCallback(async () => {
    const conv = conversations[selectedIndex];
    if (!conv) return;
    try {
      await api.patchConversation(conv.id, { archived: !showArchived });
      loadConversations();
    } catch (err) {
      setError(err.message);
    }
  }, [conversations, selectedIndex, showArchived, loadConversations]);

  const confirmDelete = useCallback(async () => {
    const conv = conversations[selectedIndex];
    setMode("normal");
    if (!conv) return;
    try {
      await api.deleteConversation(conv.id);
      if (conv.id === activeConvId) {
        setActiveConvId(null);
        setMessages([]);
      }
      loadConversations();
    } catch (err) {
      setError(err.message);
    }
  }, [conversations, selectedIndex, activeConvId, loadConversations]);

  const toggleArchivedView = useCallback(() => {
    setShowArchived((prev) => {
      const next = !prev;
      loadConversations(null, next);
      return next;
    });
  }, [loadConversations]);

  const openModelPicker = useCallback(() => {
    const idx = models.findIndex((m) => m.name === model);
    setPickerIndex(idx >= 0 ? idx : 0);
    setMode("model");
  }, [models, model]);

  const chooseModel = useCallback(async () => {
    const chosen = models[pickerIndex];
    setMode("normal");
    if (!chosen) return;
    setModel(chosen.name);
    if (activeConvId) {
      setConversations((prev) => prev.map((c) => (c.id === activeConvId ? { ...c, model: chosen.name } : c)));
      api.patchConversation(activeConvId, { model: chosen.name }).catch((err) => setError(err.message));
    }
  }, [models, pickerIndex, activeConvId]);

  // ─── Server mode switching ──────────────────────────────────────────────
  const openServerSwitch = useCallback(() => {
    setServerPickerIndex(ollamaConfig.activeTarget === "remote" ? 1 : 0);
    setMode("server");
  }, [ollamaConfig.activeTarget]);

  const applyServerSwitch = useCallback(
    async (target) => {
      try {
        const result = await api.switchServer(target);
        setOllamaConfig((c) => ({ ...c, activeTarget: result.activeTarget }));
        const modelsData = await api.getModels();
        const list = modelsData.models || [];
        setModels(list);
        if (!list.find((m) => m.name === model)) {
          setModel(list[0]?.name || "");
        }
      } catch (err) {
        setError(err.message);
      }
    },
    [model]
  );

  const chooseServerTarget = useCallback(() => {
    const target = serverPickerIndex === 0 ? "local" : "remote";
    if (target === ollamaConfig.activeTarget) {
      setMode("normal");
      return;
    }
    if (target === "remote" && !ollamaConfig.remoteOllamaUrl) {
      setError("No GPU server configured. Set it up in the web UI Settings first.");
      setMode("normal");
      return;
    }
    if (target === "remote" && ollamaConfig.remoteStatus?.online === false) {
      setMode("confirmRemoteSwitch");
      return;
    }
    setMode("normal");
    applyServerSwitch(target);
  }, [serverPickerIndex, ollamaConfig, applyServerSwitch]);

  const confirmRemoteSwitch = useCallback(() => {
    setMode("normal");
    applyServerSwitch("remote");
  }, [applyServerSwitch]);

  // ─── Keyboard ────────────────────────────────────────────────────────────
  useInput((input, key) => {
    // Modal: rename
    if (mode === "rename") {
      if (key.return) return commitRename();
      if (key.escape) return setMode("normal");
      if (key.backspace || key.delete) return setPrompt((d) => d.slice(0, -1));
      if (key.ctrl || key.meta) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;
      if (input) setPrompt((d) => d + input);
      return;
    }

    // Modal: confirm delete
    if (mode === "confirmDelete") {
      if (input === "y" || input === "Y" || key.return) return confirmDelete();
      if (input === "n" || input === "N" || key.escape) return setMode("normal");
      return;
    }

    // Modal: model picker
    if (mode === "model") {
      if (key.escape) return setMode("normal");
      if (key.return) return chooseModel();
      if (key.upArrow) return setPickerIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) return setPickerIndex((i) => Math.min(models.length - 1, i + 1));
      return;
    }

    // Modal: server (mode) picker
    if (mode === "server") {
      if (key.escape) return setMode("normal");
      if (key.return) return chooseServerTarget();
      if (key.upArrow || key.downArrow) return setServerPickerIndex((i) => (i === 0 ? 1 : 0));
      return;
    }

    // Modal: confirm switching to an offline-looking GPU server
    if (mode === "confirmRemoteSwitch") {
      if (input === "y" || input === "Y" || key.return) return confirmRemoteSwitch();
      if (input === "n" || input === "N" || key.escape) return setMode("server");
      return;
    }

    // Normal mode
    if (key.tab) {
      setFocus((f) => (f === "input" ? "list" : "input"));
      return;
    }

    if (focus === "list") {
      if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
      else if (key.downArrow) setSelectedIndex((i) => Math.min(conversations.length - 1, i + 1));
      else if (key.return) openConversation(conversations[selectedIndex]);
      else if (input === "n") newChat();
      else if (input === "t") setToolsOn((t) => !t);
      else if (input === "m") openModelPicker();
      else if (input === "s") openServerSwitch();
      else if (input === "r") startRename();
      else if (input === "a") toggleArchiveSelected();
      else if (input === "A") toggleArchivedView();
      else if (input === "d") {
        if (conversations[selectedIndex]) setMode("confirmDelete");
      } else if (input === "q") exit();
      return;
    }

    // focus === "input"
    if (streaming) return;
    if (key.escape) return setFocus("list");
    if (key.return) return sendMessage();
    if (key.backspace || key.delete) return setDraft((d) => d.slice(0, -1));
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (input) setDraft((d) => d + input);
  });

  // ─── Render ──────────────────────────────────────────────────────────────
  if (fatal) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>Cannot start LLMUI TUI</Text>
        <Text>{fatal}</Text>
        <Text dimColor>Is the server running? Try: npm run server</Text>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box padding={1}>
        <Text color="cyan">Connecting to LLMUI server…</Text>
      </Box>
    );
  }

  const sidebarWidth = Math.min(34, Math.max(22, Math.floor(columns * 0.3)));
  const chatWidth = columns - sidebarWidth;
  const mainHeight = Math.max(3, rows - STATUS_ROWS - INPUT_ROWS);
  const selectedConv = conversations[selectedIndex];

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box height={mainHeight}>
        <Sidebar
          conversations={conversations}
          selectedIndex={selectedIndex}
          focused={focus === "list" && mode === "normal"}
          activeId={activeConvId}
          showArchived={showArchived}
          width={sidebarWidth}
          height={mainHeight}
        />
        {mode === "model" ? (
          <ModelPicker models={models} index={pickerIndex} current={model} width={chatWidth} height={mainHeight} />
        ) : mode === "server" || mode === "confirmRemoteSwitch" ? (
          <ServerPicker
            index={serverPickerIndex}
            activeTarget={ollamaConfig.activeTarget}
            remoteConfigured={Boolean(ollamaConfig.remoteOllamaUrl)}
            remoteStatus={ollamaConfig.remoteStatus}
            width={chatWidth}
            height={mainHeight}
          />
        ) : (
          <ChatPane
            messages={messages}
            streaming={streaming}
            loading={loadingMessages}
            width={chatWidth}
            height={mainHeight}
          />
        )}
      </Box>

      <StatusBar
        model={model}
        toolsOn={toolsOn}
        streaming={Boolean(streaming)}
        toolStatus={toolStatus}
        focus={focus}
        error={error}
        columns={columns}
        activeTarget={ollamaConfig.activeTarget}
        remoteStatus={ollamaConfig.remoteStatus}
      />

      {mode === "rename" ? (
        <Box width={columns} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">rename › </Text>
          <Text>{prompt}</Text>
          <Text inverse> </Text>
          <Box flexGrow={1} />
          <Text dimColor>⏎ save · esc cancel</Text>
        </Box>
      ) : mode === "confirmDelete" ? (
        <Box width={columns} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">Delete “{selectedConv?.title || "this chat"}”? </Text>
          <Text dimColor>y / n</Text>
        </Box>
      ) : mode === "model" ? (
        <Box width={columns} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text dimColor>choosing model — ↑↓ ⏎ esc</Text>
        </Box>
      ) : mode === "server" ? (
        <Box width={columns} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text dimColor>choosing mode — ↑↓ ⏎ esc</Text>
        </Box>
      ) : mode === "confirmRemoteSwitch" ? (
        <Box width={columns} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">GPU server appears offline. Switch anyway? </Text>
          <Text dimColor>y / n</Text>
        </Box>
      ) : (
        <InputBar value={draft} focus={focus === "input"} streaming={Boolean(streaming)} columns={columns} />
      )}
    </Box>
  );
}
