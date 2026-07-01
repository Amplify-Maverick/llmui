import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { wrapText } from "../text.js";
import { renderMarkdown } from "../markdown.js";

function roleStyle(role) {
  switch (role) {
    case "user":
      return { label: "You", color: "green" };
    case "assistant":
      return { label: null, color: "cyan" };
    case "tool":
      return { label: "tool", color: "yellow" };
    case "system":
      return { label: "system", color: "magenta" };
    default:
      return { label: role, color: "white" };
  }
}

function previewOneLine(value, max) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function toolCardLines(toolCalls, width) {
  const lines = [];
  for (const tc of toolCalls) {
    const name = tc.name || tc.function?.name || "tool";
    let args = tc.arguments ?? tc.function?.arguments;
    if (typeof args !== "string") args = JSON.stringify(args ?? {});
    lines.push([{ text: "⚙ ", color: "yellow" }, { text: name, color: "yellow", bold: true }]);
    lines.push([
      { text: "  ↳ ", color: "gray", dimColor: true },
      { text: previewOneLine(args, width - 4), color: "gray" },
    ]);
    if (tc.error != null) {
      lines.push([
        { text: "  ✗ ", color: "red" },
        { text: previewOneLine(tc.error, width - 4), color: "red" },
      ]);
    } else if (tc.result !== undefined) {
      lines.push([
        { text: "  = ", color: "green" },
        { text: previewOneLine(tc.result, width - 4), dimColor: true },
      ]);
    }
  }
  return lines;
}

function buildMessageLines(messages, width) {
  const out = [];
  for (const m of messages) {
    if (out.length) out.push([]);
    const { label, color } = roleStyle(m.role);
    out.push([{ text: label || m.model || "assistant", color, bold: true }]);
    if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
      for (const ln of toolCardLines(m.toolCalls, width)) out.push(ln);
    }
    for (const ln of renderMarkdown(m.content, width)) out.push(ln);
    if (m.tokensPerSec) {
      out.push([{ text: `${m.tokensPerSec.toFixed(1)} tok/s`, color: "gray", dimColor: true }]);
    }
  }
  return out;
}

function buildStreamingLines(streaming, width) {
  const out = [[{ text: streaming.label || "assistant", color: "cyan", bold: true }]];
  if (Array.isArray(streaming.tools) && streaming.tools.length) {
    for (const ln of toolCardLines(streaming.tools, width)) out.push(ln);
  }
  const body = streaming.content.length ? streaming.content + "▌" : "▌";
  for (const ln of wrapText(body, width)) out.push([{ text: ln }]);
  return out;
}

function Line({ segments }) {
  if (!segments.length) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {segments.map((s, j) => {
        const { text, ...rest } = s;
        return (
          <Text key={j} {...rest}>
            {text}
          </Text>
        );
      })}
    </Text>
  );
}

export default function ChatPane({ messages, streaming, loading, width, height }) {
  const innerWidth = Math.max(10, width - 2);
  const baseLines = useMemo(() => buildMessageLines(messages, innerWidth), [messages, innerWidth]);

  let content;
  if (loading) {
    content = <Text dimColor>loading messages…</Text>;
  } else if (messages.length === 0 && !streaming) {
    content = (
      <Box flexDirection="column">
        <Text dimColor>No messages yet.</Text>
        <Text dimColor>Type below and press ⏎ to start chatting.</Text>
      </Box>
    );
  } else {
    const all = streaming
      ? [...baseLines, [], ...buildStreamingLines(streaming, innerWidth)]
      : baseLines;
    const visible = all.slice(Math.max(0, all.length - height));
    content = visible.map((segments, i) => <Line key={i} segments={segments} />);
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} justifyContent="flex-end">
      {content}
    </Box>
  );
}
