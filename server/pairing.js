/**
 * Device pairing payload (Settings → Pair iPhone, GET /api/pairing).
 *
 * QR text: "llmui-pair:v1:" followed by JSON {"url": "...", "token": "..."}.
 * The version lives in the prefix so a later format can change the body
 * entirely; clients reject any prefix they don't know. See docs/api.md.
 */

export const PAIR_VERSION = "llmui-pair:v1";
export const PAIR_PREFIX = `${PAIR_VERSION}:`;

/**
 * The HTTPS URL other devices reach this server at: LLMUI_PUBLIC_URL, else the
 * first https origin in LLMUI_ALLOWED_ORIGINS (the tailscale serve URL in
 * deploy/llmui.service), else null (the browser then uses its own origin).
 */
export function publicUrl(env = process.env) {
  const candidates = [env.LLMUI_PUBLIC_URL, ...(env.LLMUI_ALLOWED_ORIGINS || "").split(",")];
  for (const c of candidates) {
    const v = (c || "").trim().replace(/\/+$/, "");
    if (/^https:\/\/[^/\s]+$/.test(v)) return v;
  }
  return null;
}

/** The QR text for a url and token. */
export const pairingText = (url, token) => PAIR_PREFIX + JSON.stringify({ url, token });

/** Parse QR text back into { url, token }, or null if it isn't a v1 payload. */
export function parsePairingText(text) {
  if (typeof text !== "string" || !text.startsWith(PAIR_PREFIX)) return null;
  try {
    const { url, token } = JSON.parse(text.slice(PAIR_PREFIX.length));
    return typeof url === "string" && typeof token === "string" ? { url, token } : null;
  } catch {
    return null;
  }
}
