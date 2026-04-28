# LLMUI

A web interface for chatting with local LLMs through Ollama. Nothing fancy, just a clean UI that makes it easy to manage models and have conversations.

## What it does

- **Chat** with any model you have installed in Ollama
- **Pull and delete models** directly from the UI
- **GPU monitoring** - see your VRAM usage, temperature, utilization in real-time (NVIDIA only)
- **Conversation history** - saved locally in your browser
- **Hardware guide** - helps figure out what models will run on your system
- Configurable system prompts, temperature, max tokens

## Requirements

- [Node.js](https://nodejs.org/) (v18 or higher)
- [Ollama](https://ollama.ai/) running locally

For GPU stats you'll need an NVIDIA GPU with drivers installed. If you don't have one, the app still works fine - you just won't see the GPU panel.

## Installation

```bash
git clone <repo-url>
cd llmui
npm install
```

## Running

Make sure Ollama is running first:

```bash
ollama serve
```

Then start the UI:

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

## Configuration

Most settings can be changed in the Settings tab:

- **Ollama URL** - defaults to `http://localhost:11434`, change it if your Ollama server is running somewhere else
- **System Prompt** - gets sent at the start of every conversation
- **Temperature** - lower = more focused, higher = more creative
- **Max Tokens** - limit on response length

## Keyboard shortcuts

Press `Ctrl+/` (or `Cmd+/` on Mac) to see all shortcuts.
