import React from "react";
import { Box, Text } from "ink";

function badge(source) {
  if (source === "tui") return "⌨";
  if (source && source !== "local") return source[0];
  return "◷"; // web/local
}

export default function Sidebar({ conversations, selectedIndex, focused, activeId, showArchived, width, height }) {
  const listHeight = Math.max(1, height - 4); // header + spacer + two hint lines

  let start = 0;
  if (selectedIndex >= listHeight) start = selectedIndex - listHeight + 1;
  const visible = conversations.slice(start, start + listHeight);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text bold color={showArchived ? "yellow" : focused ? "cyanBright" : "cyan"} wrap="truncate">
        {showArchived ? "Archived" : "Chats"} ({conversations.length})
      </Text>
      {conversations.length === 0 ? (
        <Text dimColor wrap="truncate">{showArchived ? "nothing archived" : "no chats yet — press n"}</Text>
      ) : (
        visible.map((c, i) => {
          const idx = start + i;
          const selected = idx === selectedIndex;
          const isActive = c.id === activeId;
          const marker = isActive ? "●" : selected ? "›" : " ";
          const title = c.title || "Untitled";
          return (
            <Text
              key={c.id}
              wrap="truncate"
              inverse={selected && focused}
              bold={isActive}
              color={selected ? "white" : isActive ? "cyan" : undefined}
            >
              {marker} {badge(c.source)} {title}
            </Text>
          );
        })
      )}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">⏎ open · n new · r rename</Text>
      <Text dimColor wrap="truncate">a {showArchived ? "unarc" : "archive"} · d del · A archived</Text>
    </Box>
  );
}
