/**
 * Ollama API client — all requests go through the authenticated Express server
 * on port 3001 (/ollama/*). No direct browser-to-Ollama connections.
 *
 * Auth token is fetched from the Vite plugin endpoint (/api/llmui-token),
 * consistent with how storage.js fetches its token.
 */

const AUTH_SERVER = "http://localhost:3001";
const TOKEN_API = "/api/llmui-token";

let authToken = null;
let tokenPromise = null;

async function getAuthToken() {
  if (authToken) return authToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetch(TOKEN_API)
    .then((res) => {
      if (!res.ok) {
        throw new Error(
          `Failed to fetch auth token (${res.status}). ` +
            "Ensure the storage server is running (node server/index.js) " +
            "and the Vite dev server is active."
        );
      }
      return res.json();
    })
    .then((data) => {
      authToken = data.token;
      return authToken;
    })
    .catch((error) => {
      console.error("[LLMUI] Auth token fetch failed:", error.message);
      tokenPromise = null;
      throw error;
    });

  return tokenPromise;
}

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

class OllamaAPI {
  async listModels() {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/tags`, {
      headers: authHeaders(token),
    });
    if (!response.ok) throw new Error("Failed to fetch models");
    return response.json();
  }

  async listRunningModels() {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/ps`, {
      headers: authHeaders(token),
    });
    if (!response.ok) throw new Error("Failed to fetch running models");
    return response.json();
  }

  async showModel(name) {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/show`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Failed to fetch model info");
    return response.json();
  }

  async *chatStream(model, messages, options = {}) {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/chat`, {
      method: "POST",
      headers: authHeaders(token),
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

  async *pullModel(name) {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/pull`, {
      method: "POST",
      headers: authHeaders(token),
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
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/delete`, {
      method: "DELETE",
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    });
    return response.ok;
  }

  async unloadModel(name) {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/unload`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      throw new Error("Failed to unload model");
    }
    return response.json();
  }

  async checkConnection() {
    try {
      const token = await getAuthToken();
      const response = await fetch(`${AUTH_SERVER}/ollama/tags`, {
        headers: authHeaders(token),
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
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      headers: authHeaders(token),
    });
    if (!response.ok) throw new Error("Failed to fetch Ollama config");
    const data = await response.json();
    return data.ollamaUrl;
  }

  async setOllamaUrl(url) {
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/config`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ ollamaUrl: url }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to update Ollama URL");
    }
    return response.json();
  }
}

export const ollamaApi = new OllamaAPI();
export default OllamaAPI;
