/**
 * Wrap a block of text to a given column width, preserving explicit newlines.
 * Returns an array of single-line strings. Long words that exceed the width
 * are hard-broken so nothing overflows the pane.
 */
export function wrapText(text, width) {
  const w = Math.max(1, width);
  const out = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    let line = rawLine;
    while (line.length > w) {
      let breakAt = line.lastIndexOf(" ", w);
      if (breakAt <= 0) breakAt = w; // no space to break on — hard break
      out.push(line.slice(0, breakAt));
      line = line.slice(breakAt).replace(/^\s+/, "");
    }
    out.push(line);
  }
  return out;
}
