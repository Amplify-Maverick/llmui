import { authHeaders } from "../services/auth.js";

const STORAGE_API = "http://localhost:3001/storage";

export async function loadFromStorage(key) {
  try {
    const response = await fetch(`${STORAGE_API}/${key}`, {
      headers: await authHeaders(),
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
    await fetch(`${STORAGE_API}/${key}`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ data: value }),
    });
  } catch (error) {
    console.error(`Error saving ${key} to storage:`, error);
  }
}

export async function removeFromStorage(key) {
  try {
    await fetch(`${STORAGE_API}/${key}`, {
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
