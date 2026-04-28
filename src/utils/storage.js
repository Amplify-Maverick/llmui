const STORAGE_API = "http://localhost:3001/storage";

export async function loadFromStorage(key) {
  try {
    const response = await fetch(`${STORAGE_API}/${key}`);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: value }),
    });
  } catch (error) {
    console.error(`Error saving ${key} to storage:`, error);
  }
}

export async function removeFromStorage(key) {
  try {
    await fetch(`${STORAGE_API}/${key}`, { method: "DELETE" });
  } catch (error) {
    console.error(`Error removing ${key} from storage:`, error);
  }
}
