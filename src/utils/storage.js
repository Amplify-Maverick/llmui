const STORAGE_API = "http://localhost:3001/storage";
const AUTH_API = "http://localhost:3001/auth/token";

let authToken = null;
let tokenPromise = null;

async function getToken() {
  if (authToken) return authToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetch(AUTH_API)
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
