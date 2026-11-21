/**
 * Copy text with the async Clipboard API. Resolves true when it was copied,
 * false when the API is missing (plain-HTTP pages aren't a secure context,
 * so `navigator.clipboard` is undefined there) or the write was refused.
 * Callers show the text in a selectable field when this returns false.
 */
export async function copyText(text, clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
