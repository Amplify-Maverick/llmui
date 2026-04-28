import { DEFAULT_OLLAMA_URL } from "../constants/config.js";

const AUTH_SERVER = "http://localhost:3001";
let authToken = null;
let tokenPromise = null;

async function getAuthToken() {
  if (authToken) return authToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetch(`${AUTH_SERVER}/auth/token`)
    .then((res) => {
      if (!res.ok) throw new Error("Failed to fetch auth token");
      return res.json();
    })
    .then((data) => {
      authToken = data.token;
      return authToken;
    })
    .catch((error) => {
      console.error("Error fetching auth token:", error);
      tokenPromise = null;
      throw error;
    });

  return tokenPromise;
}

class OllamaAPI {
  constructor(baseUrl = DEFAULT_OLLAMA_URL) {
    this.baseUrl = baseUrl;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) throw new Error("Failed to fetch models");
    return response.json();
  }

  async listRunningModels() {
    const response = await fetch(`${this.baseUrl}/api/ps`);
    if (!response.ok) throw new Error("Failed to fetch running models");
    return response.json();
  }

  async showModel(name) {
    const response = await fetch(`${this.baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Failed to fetch model info");
    return response.json();
  }

  async *chatStream(model, messages, options = {}) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    // Use authenticated endpoint on storage server
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
    // Use authenticated endpoint on storage server
    const token = await getAuthToken();
    const response = await fetch(`${AUTH_SERVER}/ollama/delete`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });
    return response.ok;
  }

  async checkConnection() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const ollamaApi = new OllamaAPI();
export default OllamaAPI;
