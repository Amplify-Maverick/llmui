/**
 * True when a Models search box holds a link rather than search words. The
 * server parses it (server/hflink.js, same test); this only picks the
 * button label.
 */
export const looksLikeLink = (s) => /^\s*(?:[a-z][\w+.-]*:\/\/|(?:www\.)?(?:huggingface\.co|hf\.co)\/)/i.test(String(s || ""));
