import React from "react";
import { Box, Text } from "ink";

export default function InputBar({ value, focus, streaming, columns }) {
  return (
    <Box
      width={columns}
      borderStyle="round"
      borderColor={focus && !streaming ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text color="green">{"› "}</Text>
      {streaming ? (
        <Text dimColor>waiting for response…</Text>
      ) : value.length === 0 && !focus ? (
        <Text dimColor>press tab or ⏎ to type a message…</Text>
      ) : (
        <Text>
          {value}
          {focus ? <Text inverse> </Text> : null}
        </Text>
      )}
    </Box>
  );
}
