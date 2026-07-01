#!/usr/bin/env node
/**
 * LLMUI TUI — full-screen terminal interface for local Ollama models.
 *
 * Browse and resume conversations you've already started (shared with the web
 * UI's SQLite history), start new ones, and chat with streaming responses.
 * Reads the auth token from ~/.llmui/token and talks to the LLMUI server.
 *
 * Usage:  npm run tui [-- --model <name>] [--tools] [--server <url>]
 */

import React from "react";
import { render } from "ink";
import App from "./App.jsx";
import { configureServer, readToken } from "./api.js";

// ─── Parse CLI flags ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let cliModel;
let cliTools;
let cliServer;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) cliModel = args[++i];
  else if (args[i] === "--tools") cliTools = true;
  else if (args[i] === "--server" && args[i + 1]) cliServer = args[++i];
}

if (cliServer) configureServer(cliServer);

// Validate token early with a friendly error before entering the UI.
try {
  readToken();
} catch {
  console.error("Error: cannot read token from ~/.llmui/token");
  console.error("Start the LLMUI server at least once first: npm run server");
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error("The LLMUI TUI needs an interactive terminal (TTY).");
  console.error("Run it directly in your terminal: npm run tui");
  process.exit(1);
}

// ─── Alternate screen buffer (full-screen feel, restores on exit) ────────────
const enterAltScreen = () => process.stdout.write("\x1b[?1049h\x1b[H");
const exitAltScreen = () => process.stdout.write("\x1b[?1049l");

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  exitAltScreen();
}

enterAltScreen();
process.on("exit", restore);

const { waitUntilExit } = render(<App cliModel={cliModel} cliTools={cliTools} />);

waitUntilExit()
  .then(restore)
  .catch((err) => {
    restore();
    console.error(err);
    process.exit(1);
  });
