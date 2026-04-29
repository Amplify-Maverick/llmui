import { authHeaders } from "../services/auth.js";

const API_BASE = "http://localhost:3001/api";

// Key pattern handlers - map storage keys to appropriate API calls
function getKeyHandler(key) {
  // Conversation index → GET /api/conversations
  if (key === "llmui_conv_index") {
    return {
      load: async () => {
        const res = await fetch(`${API_BASE}/conversations`, {
          headers: await authHeaders(),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.conversations;
      },
      // Saving the index is a no-op - index is derived from conversations table
      // Individual conversation updates happen via PATCH /api/conversations/:id
      save: async () => {},
    };
  }

  // Conversation messages → GET/PUT /api/conversations/:id/messages
  const convMatch = key.match(/^llmui_conv_(.+)$/);
  if (convMatch) {
    const conversationId = convMatch[1];
    return {
      load: async () => {
        const res = await fetch(
          `${API_BASE}/conversations/${conversationId}/messages`,
          { headers: await authHeaders() }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.messages;
      },
      save: async (messages) => {
        // Bulk replace all messages for this conversation
        await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
          method: "PUT",
          headers: await authHeaders(),
          body: JSON.stringify({ messages }),
        });
      },
    };
  }

  // Settings and active conversation → GET/PUT /api/settings/:key
  return {
    load: async () => {
      const res = await fetch(`${API_BASE}/settings/${key}`, {
        headers: await authHeaders(),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.data;
    },
    save: async (value) => {
      await fetch(`${API_BASE}/settings/${key}`, {
        method: "PUT",
        headers: await authHeaders(),
        body: JSON.stringify({ data: value }),
      });
    },
  };
}

export async function loadFromStorage(key) {
  try {
    const handler = getKeyHandler(key);
    return await handler.load();
  } catch (error) {
    console.error(`Error loading ${key} from storage:`, error);
    return null;
  }
}

export async function saveToStorage(key, value) {
  try {
    const handler = getKeyHandler(key);
    await handler.save(value);
  } catch (error) {
    console.error(`Error saving ${key} to storage:`, error);
  }
}

export async function removeFromStorage(key) {
  try {
    // For conversation messages, delete the conversation
    const convMatch = key.match(/^llmui_conv_(.+)$/);
    if (convMatch) {
      const conversationId = convMatch[1];
      await fetch(`${API_BASE}/conversations/${conversationId}`, {
        method: "DELETE",
        headers: await authHeaders(),
      });
      return;
    }

    // For settings, delete the key
    await fetch(`${API_BASE}/settings/${key}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
  } catch (error) {
    console.error(`Error removing ${key} from storage:`, error);
  }
}

// ============================================================
// Debounced saves — coalesces rapid writes per key (~500ms)
// Prevents hammering the storage server during streaming or
// rapid user interactions, especially important over LAN.
// ============================================================
const _debounceTimers = new Map();
const _debouncePending = new Map();

export function debouncedSaveToStorage(key, value, delay = 500) {
  _debouncePending.set(key, value);
  if (_debounceTimers.has(key)) {
    clearTimeout(_debounceTimers.get(key));
  }
  _debounceTimers.set(
    key,
    setTimeout(() => {
      _debounceTimers.delete(key);
      const val = _debouncePending.get(key);
      _debouncePending.delete(key);
      saveToStorage(key, val);
    }, delay)
  );
}

export function cancelDebouncedSave(key) {
  if (_debounceTimers.has(key)) {
    clearTimeout(_debounceTimers.get(key));
    _debounceTimers.delete(key);
  }
  _debouncePending.delete(key);
}

export async function flushDebouncedSave(key) {
  if (_debounceTimers.has(key)) {
    clearTimeout(_debounceTimers.get(key));
    _debounceTimers.delete(key);
  }
  if (_debouncePending.has(key)) {
    const val = _debouncePending.get(key);
    _debouncePending.delete(key);
    await saveToStorage(key, val);
  }
}
