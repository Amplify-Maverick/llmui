# LLMUI

A web interface for chatting with local LLMs through Ollama. 
## What it does

- **Chat** with any model you have installed in Ollama
- **Pull and delete models** directly from the UI
- **GPU monitoring** - see your VRAM usage, temperature, utilization in real-time (NVIDIA only)
- **Conversation history** - saved to `~/.llmui/` on your device
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

This runs both the storage server (port 3001) and the frontend (port 3000). Open http://localhost:3000 in your browser.

## Configuration

Most settings can be changed in the Settings tab:

- **Ollama URL** - defaults to `http://localhost:11434`, change it if your Ollama server is running somewhere else
- **System Prompt** - gets sent at the start of every conversation
- **Temperature** - lower = more focused, higher = more creative
- **Max Tokens** - limit on response length

## Data storage

Conversations and settings are stored in `~/.llmui/` as JSON files. This persists your data independently of the browser.

## Keyboard shortcuts

Press `Ctrl+/` (or `Cmd+/` on Mac) to see all shortcuts.
