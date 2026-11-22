/**
 * Hugging Face links pasted into the Models search boxes. A link resolves to
 * one repo (and maybe a file or quant in it) instead of running a search.
 *
 * Accepted:
 *   https://huggingface.co/owner/repo[/tree/<rev>[/dir]]
 *   https://huggingface.co/owner/repo/blob|resolve/<rev>/<path>[?download=true]
 *   hf.co/owner/repo:QUANT           (llama.cpp -hf / Ollama style; scheme optional)
 */

export const HF_API = "https://huggingface.co/api";
const HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);
const SEG_RE = /^(?!\.\.?$)[\w.-]+$/;

/** A bare repo id typed as a search query: "owner/name" (no "." or ".." segments). */
export const REPO_ID_RE = /^(?!\.\.?\/)[\w.-]+\/(?!\.\.?$)[\w.-]+$/;

/** Cheap check for the UI: does this input look like a link rather than search words? */
export const looksLikeLink = (s) => /^\s*(?:[a-z][\w+.-]*:\/\/|(?:www\.)?(?:huggingface\.co|hf\.co)\/)/i.test(String(s || ""));

/**
 * null when `input` isn't a link (search for it instead); { error } for a link
 * that can't be installed from; else { repo, revision, file, quant } with
 * revision/file/quant null when the link doesn't name them.
 */
export function parseHfLink(input) {
  let s = String(input || "").trim();
  if (!looksLikeLink(s)) return null;
  if (!/^[a-z][\w+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return { error: "That link isn't a valid URL" };
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    return { error: `Only Hugging Face links can be installed from here (this one is on ${url.hostname})` };
  }
  let segments;
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { error: "That link isn't a valid URL" };
  }
  if (segments[0] === "datasets" || segments[0] === "spaces") {
    return { error: `That's a Hugging Face ${segments[0] === "spaces" ? "Space" : "dataset"}, not a model` };
  }
  if (segments.length < 2) return { error: "Link to a model, e.g. https://huggingface.co/owner/name" };

  const [owner, nameTag] = segments;
  const [name, quant, ...extra] = nameTag.split(":");
  if (!SEG_RE.test(owner) || !SEG_RE.test(name) || extra.length || (quant !== undefined && !/^[\w.-]+$/.test(quant))) {
    return { error: "That link doesn't name a Hugging Face model (expected huggingface.co/owner/name)" };
  }

  let revision = null;
  let file = null;
  const [kind, rev, ...rest] = segments.slice(2);
  if ((kind === "blob" || kind === "resolve" || kind === "tree") && rev) {
    revision = rev;
    if (kind !== "tree" && rest.length) {
      if (rest.some((p) => p === "." || p === "..")) return { error: "That link's file path isn't valid" };
      file = rest.join("/");
    }
  }
  return { repo: `${owner}/${name}`, revision, file, quant: quant ? quant.toUpperCase() : null };
}

/**
 * The repo's model info (`expand`: fields to ask for), with HF's canonical id.
 * Throws with status 404 when the repo doesn't exist or isn't public.
 */
export async function fetchRepoInfo(repo, expand, { timeout = 15000 } = {}) {
  const [owner, name] = repo.split("/");
  const params = new URLSearchParams();
  for (const e of expand) params.append("expand[]", e);
  let response;
  try {
    response = await fetch(`${HF_API}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?${params}`, {
      headers: { "User-Agent": "llmui" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw Object.assign(new Error(`Hugging Face unreachable: ${err.cause?.code || err.message}`), { status: 502 });
  }
  // HF answers 401 for repos that don't exist as well as for private ones.
  if (response.status === 401 || response.status === 404) {
    throw Object.assign(new Error(`No public model "${repo}" on Hugging Face (check the link, or the repo is private)`), { status: 404 });
  }
  if (!response.ok) throw Object.assign(new Error(`Hugging Face error (${response.status})`), { status: 502 });
  return response.json();
}
