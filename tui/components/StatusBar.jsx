import React from "react";
import { Box, Text } from "ink";

export default function StatusBar({ model, toolsOn, streaming, toolStatus, focus, error, columns }) {
  return (
    <Box width={columns} paddingX={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Text color="green">{model || "no model"}</Text>
        <Text dimColor> · </Text>
        <Text color={toolsOn ? "yellow" : "gray"}>tools {toolsOn ? "on" : "off"}</Text>
        <Text dimColor> · </Text>
        {toolStatus ? (
          <Text color="yellow">⚙ {toolStatus}</Text>
        ) : (
          <Text color={streaming ? "magenta" : "gray"}>{streaming ? "streaming…" : "idle"}</Text>
        )}
      </Text>
      <Text wrap="truncate">
        {error ? (
          <Text color="red">⚠ {error}</Text>
        ) : (
          <Text dimColor>
            {focus === "input" ? "tab →chats · esc list" : "tab →input · m model · t tools"}
          </Text>
        )}
      </Text>
    </Box>
  );
}
