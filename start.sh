#!/bin/bash

cd "$(dirname "$0")"

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Dependencies not installed. Run ./install.sh first."
    exit 1
fi

# Start Ollama if not running
if ! pgrep -x "ollama" > /dev/null; then
    echo "Starting Ollama..."
    ollama serve &> /dev/null &
    sleep 2
fi

echo "Starting LLMUI at http://localhost:3000"
./node_modules/.bin/vite --host
