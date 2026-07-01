import React from "react";
import { Box, Text } from "ink";

function sizeLabel(bytes) {
  if (!bytes) return "";
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function ModelPicker({ models, index, current, width, height }) {
  const listHeight = Math.max(1, height - 2);
  let start = 0;
  if (index >= listHeight) start = index - listHeight + 1;
  const visible = models.slice(start, start + listHeight);

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text bold color="cyanBright">Pick a model ({models.length})</Text>
      {visible.map((m, i) => {
        const idx = start + i;
        const selected = idx === index;
        const isCurrent = m.name === current;
        return (
          <Text key={m.name} wrap="truncate" inverse={selected} color={selected ? "white" : isCurrent ? "green" : undefined}>
            {selected ? "›" : isCurrent ? "●" : " "} {m.name}
            {m.size ? <Text dimColor> ({sizeLabel(m.size)})</Text> : null}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">↑↓ move · ⏎ select · esc cancel</Text>
    </Box>
  );
}
