const STORAGE_API = "http://localhost:3001/storage";

// Token is fetched from Vite plugin endpoint (works for both localhost and LAN clients)
// See config/vite-token-plugin.js for details on token delivery approach
const TOKEN_API = "/api/llmui-token";

let authToken = null;
let tokenPromise = null;

async function getToken() {
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
      console.error(
        "[LLMUI] Auth token fetch failed:",
        error.message,
        "\nThis typically means the storage server hasn't started yet.",
        "\nRun: node server/index.js"
      );
      tokenPromise = null;
      throw error;
    });

  return tokenPromise;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
}

export async function loadFromStorage(key) {
  try {
    await getToken();
    const response = await fetch(`${STORAGE_API}/${key}`, {
      headers: authHeaders(),
    });
    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error(`Error loading ${key} from storage:`, error);
    return null;
  }
}

export async function saveToStorage(key, value) {
  try {
    await getToken();
    await fetch(`${STORAGE_API}/${key}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ data: value }),
    });
  } catch (error) {
    console.error(`Error saving ${key} to storage:`, error);
  }
}

export async function removeFromStorage(key) {
  try {
    await getToken();
    await fetch(`${STORAGE_API}/${key}`, {
      method: "DELETE",
      headers: authHeaders(),
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
