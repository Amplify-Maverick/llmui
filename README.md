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

### Linux

1. Install Node.js (if not already installed):
   ```bash
   # Ubuntu/Debian
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs

   # Fedora
   sudo dnf install nodejs

   # Arch
   sudo pacman -S nodejs npm
   ```

2. Install Ollama:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

3. Clone and install:
   ```bash
   git clone <repo-url>
   cd llmui
   npm install
   ```

### Windows

1. Install Node.js:
   - Download from [nodejs.org](https://nodejs.org/) and run the installer
   - Or use winget: `winget install OpenJS.NodeJS`

2. Install Ollama:
   - Download from [ollama.com](https://ollama.com/download) and run the installer

3. Clone and install (in PowerShell or Command Prompt):
   ```powershell
   git clone <repo-url>
   cd llmui
   npm install
   ```

## Running

### Linux

Start Ollama (if not running as a service):
```bash
ollama serve
```

Then start the UI:
```bash
npm run dev
```

### Windows

Ollama runs automatically after installation. If needed, start it from the Start Menu.

Then start the UI (in PowerShell or Command Prompt):
```powershell
npm run dev
```

Open http://localhost:3000 in your browser. This runs both the storage server (port 3001) and the frontend (port 3000).

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
