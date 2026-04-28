#!/bin/bash

set -e

echo "=== LLMUI Install Script ==="
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    echo "   https://nodejs.org/"
    exit 1
fi
echo "✓ Node.js $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi
echo "✓ npm $(npm --version)"

# Install Ollama if not present
if command -v ollama &> /dev/null; then
    echo "✓ Ollama $(ollama --version 2>/dev/null | head -1 || echo 'installed')"
else
    echo "→ Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
    echo "✓ Ollama installed"
fi

# Install npm dependencies if needed
cd "$(dirname "$0")/.."

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
    echo "✓ npm dependencies already installed"
else
    echo "→ Installing npm dependencies..."
    npm install
    echo "✓ npm dependencies installed"
fi

echo
echo "=== Installation complete ==="
echo
echo "To start the app:"
echo "  npm run dev"
echo
echo "Make sure Ollama is running:"
echo "  ollama serve"
