/**
 * Ollama API client — all requests go through the authenticated Express server
 * on port 3001 (/ollama/*). No direct browser-to-Ollama connections.
 */

import { authHeaders } from "./auth.js";

const AUTH_SERVER = ""; // relative — proxied through Vite to localhost:3001

class OllamaAPI {
  async listModels() {
    const response = await fetch(`${AUTH_SERVER}/ollama/tags`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch models");
    return response.json();
  }

  async listRunningModels() {
    const response = await fetch(`${AUTH_SERVER}/ollama/ps`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch running models");
    return response.json();
  }

  async showModel(name) {
    const response = await fetch(`${AUTH_SERVER}/ollama/show`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Failed to fetch model info");
    return response.json();
  }

  async *chatStream(model, messages, options = {}) {
    const response = await fetch(`${AUTH_SERVER}/ollama/chat`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: options.enableThinking || false,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || "Failed to start chat");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            yield JSON.parse(line);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *chatStreamWithTools(model, messages, options = {}) {
    const response = await fetch(`${AUTH_SERVER}/ollama/chat-with-tools`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        model,
        messages,
        enabledTools: options.enabledTools || null,
        options: {
          modelOptions: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
          },
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || "Failed to start chat with tools");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            yield JSON.parse(line);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *pullModel(name) {
    const response = await fetch(`${AUTH_SERVER}/ollama/pull`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ name, stream: true }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || "Failed to pull model");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            yield JSON.parse(line);
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async deleteModel(name) {
    const response = await fetch(`${AUTH_SERVER}/ollama/delete`, {
      method: "DELETE",
      headers: await authHeaders(),
      body: JSON.stringify({ name }),
    });
    return response.ok;
  }

  async unloadModel(name) {
    const response = await fetch(`${AUTH_SERVER}/ollama/unload`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      throw new Error("Failed to unload model");
    }
    return response.json();
  }

  async checkConnection() {
    try {
      const response = await fetch(`${AUTH_SERVER}/ollama/tags`, {
        headers: await authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // Ollama URL is now managed server-side. These methods interact with
  // the Express server's /ollama/config endpoint.
  async getOllamaUrl() {
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch Ollama config");
    const data = await response.json();
    return data.ollamaUrl;
  }

  async getConfig() {
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch Ollama config");
    return response.json(); // { ollamaUrl, remoteOllamaUrl, activeTarget }
  }

  async setOllamaUrl(url) {
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ ollamaUrl: url }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to update Ollama URL");
    }
    return response.json();
  }

  async setRemoteOllamaUrl(url) {
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ remoteOllamaUrl: url }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to update remote Ollama URL");
    }
    return response.json();
  }

  async switchServer(target) {
    const response = await fetch(`${AUTH_SERVER}/ollama/switch`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ target }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to switch server");
    }
    return response.json(); // { ollamaUrl, activeTarget }
  }

  async getLocalCapability() {
    const response = await fetch(`${AUTH_SERVER}/ollama/local-capability`, {
      headers: await authHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to check local capability");
    }
    return response.json(); // { models: [{ ...model, cpuFeasibility }] }
  }
}

export const ollamaApi = new OllamaAPI();
export default OllamaAPI;
