#!/bin/bash

set -e

echo "=== LLMUI Install Script ==="
echo

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed. Please install Node.js first."
    echo "   https://nodejs.org/"
    exit 1
fi
echo "[OK] Node.js $(node --version)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "[ERROR] npm is not installed. Please install npm first."
    exit 1
fi
echo "[OK] npm $(npm --version)"

# Install npm dependencies if needed
cd "$(dirname "$0")/.."

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
    echo "[OK] npm dependencies already installed"
else
    echo "Installing npm dependencies..."
    npm install
    echo "[OK] npm dependencies installed"
fi

echo
echo "=== Installation complete ==="
echo
echo "To start the app:"
echo "  npm run dev"
echo
echo "Models come from an OpenAI-compatible server (llama.cpp, vLLM, ...)."
echo "Point LLMUI at it with:"
echo "  export OPENAI_BASE_URL=http://<host>:<port>/v1"
