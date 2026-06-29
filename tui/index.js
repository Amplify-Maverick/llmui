#!/usr/bin/env node
/**
 * LLMUI TUI — terminal chat interface for local Ollama models.
 *
 * Reads the auth token from ~/.llmui/token and connects to the LLMUI
 * Express server on localhost:3001. Supports model selection, streaming
 * responses, conversation history, and all built-in tools.
 *
 * Usage:  npm run tui
 *   or:   node tui/index.js [--model <name>] [--tools]
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVER = "http://localhost:3001";
const TOKEN_FILE = path.join(os.homedir(), ".llmui", "token");

// Parse CLI flags
const args = process.argv.slice(2);
let defaultModel = null;
let enableTools = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) defaultModel = args[++i];
  if (args[i] === "--tools") enableTools = true;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf-8").trim();
  } catch {
    console.error(`Error: cannot read token from ${TOKEN_FILE}`);
    console.error("Make sure the LLMUI server has been started at least once (npm run server).");
    process.exit(1);
  }
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiGet(token, path) {
  const res = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

async function* streamChat(token, model, messages, tools) {
  const body = tools
    ? {
        model,
        messages,
        enabledTools: tools,
        options: { modelOptions: { temperature: 0.7 } },
      }
    : { model, messages, stream: true, options: { temperature: 0.7 } };

  const endpoint = tools ? "/ollama/chat-with-tools" : "/ollama/chat";

  const res = await fetch(`${SERVER}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat request failed: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // skip malformed lines
      }
    }
  }
}

// ─── Terminal helpers ─────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";

function print(text = "") {
  process.stdout.write(text + "\n");
}

function printColor(color, text) {
  process.stdout.write(color + text + RESET + "\n");
}

function write(text) {
  process.stdout.write(text);
}

// ─── Model selection ─────────────────────────────────────────────────────────

async function pickModel(token, rl) {
  let models;
  try {
    const data = await apiGet(token, "/ollama/tags");
    models = data.models ?? [];
  } catch (err) {
    console.error(`${RED}Cannot reach Ollama: ${err.message}${RESET}`);
    console.error("Make sure Ollama is running (ollama serve) and LLMUI server is up (npm run server).");
    process.exit(1);
  }

  if (models.length === 0) {
    console.error(`${RED}No Ollama models found. Pull one with: ollama pull <model>${RESET}`);
    process.exit(1);
  }

  if (defaultModel) {
    const found = models.find((m) => m.name === defaultModel || m.name.startsWith(defaultModel));
    if (found) return found.name;
    printColor(YELLOW, `Model "${defaultModel}" not found locally. Available models:`);
  }

  print();
  printColor(BOLD + CYAN, "Available models:");
  models.forEach((m, i) => {
    const size = m.size ? ` ${DIM}(${(m.size / 1e9).toFixed(1)} GB)${RESET}` : "";
    print(`  ${CYAN}${i + 1}.${RESET} ${m.name}${size}`);
  });
  print();

  return new Promise((resolve) => {
    rl.question(`${BOLD}Select model (name or number): ${RESET}`, (answer) => {
      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= models.length) {
        resolve(models[num - 1].name);
      } else {
        const match = models.find((m) => m.name === answer || m.name.startsWith(answer));
        if (match) {
          resolve(match.name);
        } else {
          printColor(YELLOW, "No match — using first model.");
          resolve(models[0].name);
        }
      }
    });
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

function printHelp() {
  print();
  printColor(BOLD, "Commands:");
  print(`  ${CYAN}/clear${RESET}        Clear conversation history`);
  print(`  ${CYAN}/model${RESET}        Switch model`);
  print(`  ${CYAN}/tools${RESET}        Toggle tool use on/off`);
  print(`  ${CYAN}/history${RESET}      Show conversation so far`);
  print(`  ${CYAN}/help${RESET}         Show this message`);
  print(`  ${CYAN}/quit${RESET}  (q)    Exit`);
  print();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const token = readToken();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Prevent readline from printing extra newline on Ctrl+C
  rl.on("SIGINT", () => {
    print();
    print("Bye!");
    process.exit(0);
  });

  print();
  printColor(BOLD + CYAN, "╔══════════════════════════════╗");
  printColor(BOLD + CYAN, "║        LLMUI Terminal        ║");
  printColor(BOLD + CYAN, "╚══════════════════════════════╝");
  print();

  let model = await pickModel(token, rl);
  let messages = [];
  let toolsOn = enableTools;

  print();
  printColor(GREEN, `Model: ${model}`);
  if (toolsOn) printColor(YELLOW, "Tools: enabled");
  printColor(DIM, 'Type /help for commands, /quit to exit.');
  print();

  const prompt = () => {
    rl.question(`${BOLD + GREEN}You:${RESET} `, async (input) => {
      const text = input.trim();

      if (!text) return prompt();

      // Commands
      if (text === "/quit" || text === "q" || text === "/q") {
        print("Bye!");
        process.exit(0);
      }
      if (text === "/help") {
        printHelp();
        return prompt();
      }
      if (text === "/clear") {
        messages = [];
        printColor(DIM, "Conversation cleared.");
        return prompt();
      }
      if (text === "/history") {
        if (messages.length === 0) {
          printColor(DIM, "No messages yet.");
        } else {
          print();
          for (const m of messages) {
            const role = m.role === "user" ? `${GREEN}You${RESET}` : `${CYAN}${model}${RESET}`;
            print(`${BOLD}${role}:${RESET} ${m.content}`);
          }
        }
        return prompt();
      }
      if (text === "/tools") {
        toolsOn = !toolsOn;
        printColor(YELLOW, `Tools: ${toolsOn ? "enabled" : "disabled"}`);
        return prompt();
      }
      if (text === "/model") {
        model = await pickModel(token, rl);
        printColor(GREEN, `Switched to: ${model}`);
        return prompt();
      }

      // Regular message
      messages.push({ role: "user", content: text });

      write(`${BOLD + CYAN}${model}:${RESET} `);

      let assistantContent = "";

      try {
        const toolsParam = toolsOn ? null : undefined; // null = all tools; skip field = no tools
        for await (const chunk of streamChat(token, model, messages, toolsOn ? toolsParam : undefined)) {
          // Basic streaming (no tools)
          if (chunk.message?.content) {
            write(chunk.message.content);
            assistantContent += chunk.message.content;
          }
          // Tool-aware streaming
          if (chunk.type === "content") {
            write(chunk.content);
            assistantContent += chunk.content;
          }
          if (chunk.type === "tool_call") {
            write(`\n${YELLOW}[tool: ${chunk.name}]${RESET} `);
          }
          if (chunk.type === "tool_result") {
            const preview = JSON.stringify(chunk.result ?? chunk.error).slice(0, 120);
            write(`${DIM}→ ${preview}${RESET}\n${BOLD + CYAN}${model}:${RESET} `);
          }
          if (chunk.type === "error") {
            write(`\n${RED}Error: ${chunk.error}${RESET}`);
          }
        }
      } catch (err) {
        write(`\n${RED}Error: ${err.message}${RESET}`);
      }

      print("\n");

      if (assistantContent) {
        messages.push({ role: "assistant", content: assistantContent });
      }

      prompt();
    });
  };

  prompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
