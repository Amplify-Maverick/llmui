import React from "react";
import { Box, Text } from "ink";

const ROWS = [
  { target: "local", label: "Mini Mode (this machine)" },
  { target: "remote", label: "GPU Mode (remote)" },
];

export default function ServerPicker({ index, activeTarget, remoteConfigured, remoteStatus, width, height }) {
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text bold color="cyanBright">Switch mode</Text>
      {ROWS.map((row, idx) => {
        const selected = idx === index;
        const isCurrent = row.target === activeTarget;
        const disabled = row.target === "remote" && !remoteConfigured;
        return (
          <Text
            key={row.target}
            wrap="truncate"
            inverse={selected}
            dimColor={disabled}
            color={selected ? "white" : isCurrent ? "green" : undefined}
          >
            {selected ? "›" : isCurrent ? "●" : " "} {row.label}
            {row.target === "remote" && remoteConfigured && (
              <Text color={remoteStatus?.online ? "green" : remoteStatus?.online === false ? "red" : "gray"}>
                {" "}{remoteStatus?.online ? "●" : remoteStatus?.online === false ? "○" : "?"}
              </Text>
            )}
            {disabled && <Text dimColor> (not configured)</Text>}
          </Text>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">↑↓ move · ⏎ select · esc cancel</Text>
    </Box>
  );
}
