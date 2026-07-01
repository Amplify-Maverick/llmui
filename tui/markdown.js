/**
 * Minimal markdown → styled-line renderer for the TUI chat pane.
 *
 * Returns an array of "lines", where each line is an array of segments:
 *   { text, ...inkTextProps }   (color, bold, italic, dimColor, underline, …)
 *
 * The chat pane renders each segment as a nested <Text>. This is intentionally
 * a pragmatic subset of markdown (headings, bold/italic/strike, inline + fenced
 * code, lists, blockquotes, links, rules) — not a spec-compliant parser.
 */

function hardWrap(text, width) {
  const w = Math.max(1, width);
  const out = [];
  let line = String(text ?? "");
  if (line.length === 0) return [""];
  while (line.length > w) {
    out.push(line.slice(0, w));
    line = line.slice(w);
  }
  out.push(line);
  return out;
}

function styleOf(seg) {
  const st = {};
  if (seg.bold) st.bold = true;
  if (seg.italic) st.italic = true;
  if (seg.strike) st.strikethrough = true;
  if (seg.code) st.color = "greenBright";
  if (seg.link) {
    st.color = "blueBright";
    st.underline = true;
  }
  if (seg.dim) st.dimColor = true;
  return st;
}

const INLINE_RE =
  /(`[^`]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[^*\s][\s\S]*?\*)|(_[^_\s][\s\S]*?_)|(\[[^\]]+\]\([^)\s]+\))/;

/**
 * Parse inline markdown into an array of words: { text, style }.
 * Whitespace is collapsed to single spaces (re-inserted by wrapSegments).
 */
function parseInline(text) {
  const segs = [];
  let rest = String(text ?? "");
  let m;
  while ((m = INLINE_RE.exec(rest))) {
    if (m.index > 0) segs.push({ text: rest.slice(0, m.index) });
    const tok = m[0];
    if (m[1]) segs.push({ text: tok.slice(1, -1), code: true });
    else if (m[2]) segs.push({ text: tok.slice(2, -2), bold: true });
    else if (m[3]) segs.push({ text: tok.slice(2, -2), bold: true });
    else if (m[4]) segs.push({ text: tok.slice(2, -2), strike: true });
    else if (m[5]) segs.push({ text: tok.slice(1, -1), italic: true });
    else if (m[6]) segs.push({ text: tok.slice(1, -1), italic: true });
    else if (m[7]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      segs.push({ text: lm[1], link: true });
      segs.push({ text: ` (${lm[2]})`, dim: true });
    }
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) segs.push({ text: rest });

  // Split into words, flagging "glue" when a word should join the previous one
  // with no space (e.g. punctuation right after `code`, **bold**, or a [link]).
  const words = [];
  let prevTrailingSpace = true; // start of line: nothing to glue to
  for (const s of segs) {
    const style = styleOf(s);
    const lead = /^\s/.test(s.text);
    const trail = /\s$/.test(s.text);
    const parts = s.text.split(/\s+/).filter((p) => p.length);
    parts.forEach((p, idx) => {
      const glue = idx === 0 && words.length > 0 && !prevTrailingSpace && !lead;
      words.push({ text: p, style, glue });
    });
    prevTrailingSpace = parts.length ? trail : true;
  }
  return words;
}

/**
 * Greedy word-wrap a list of styled words into lines (arrays of segments),
 * re-inserting single spaces between words and hard-breaking overlong words.
 */
function wrapSegments(words, width, extraStyle = {}) {
  const w = Math.max(1, width);
  const lines = [];
  let cur = [];
  let len = 0;
  const flush = () => {
    lines.push(cur);
    cur = [];
    len = 0;
  };
  for (const word of words) {
    let wt = word.text;
    const style = { ...word.style, ...extraStyle };
    while (wt.length > w) {
      if (len > 0) flush();
      lines.push([{ text: wt.slice(0, w), ...style }]);
      wt = wt.slice(w);
    }
    if (wt.length === 0) continue;
    const glue = word.glue && len > 0;
    const add = len === 0 || glue ? wt.length : wt.length + 1;
    if (len + add > w && len > 0) flush();
    if (len > 0 && !word.glue) {
      cur.push({ text: " " });
      len += 1;
    }
    cur.push({ text: wt, ...style });
    len += wt.length;
  }
  if (cur.length) flush();
  if (lines.length === 0) lines.push([]);
  return lines;
}

export function renderMarkdown(md, width) {
  const w = Math.max(4, width);
  const out = [];
  const raws = String(md ?? "").split("\n");
  let inCode = false;

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];

    const fence = raw.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        inCode = true;
        out.push([{ text: fence[1] ? `╭─ ${fence[1]}` : "╭─", color: "gray", dimColor: true }]);
      } else {
        inCode = false;
        out.push([{ text: "╰─", color: "gray", dimColor: true }]);
      }
      continue;
    }
    if (inCode) {
      for (const seg of hardWrap(raw, w - 2)) {
        out.push([
          { text: "│ ", color: "gray", dimColor: true },
          { text: seg, color: "greenBright" },
        ]);
      }
      continue;
    }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const color = level === 1 ? "cyanBright" : level === 2 ? "cyan" : "blueBright";
      for (const ln of wrapSegments(parseInline(h[2]), w, { bold: true, color })) out.push(ln);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push([{ text: "─".repeat(Math.min(w, 48)), color: "gray", dimColor: true }]);
      continue;
    }

    const bq = raw.match(/^>\s?(.*)$/);
    if (bq) {
      for (const ln of wrapSegments(parseInline(bq[1]), w - 2, { dimColor: true, italic: true })) {
        out.push([{ text: "▎ ", color: "gray" }, ...ln]);
      }
      continue;
    }

    const ul = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      const indent = (ul ? ul[1] : ol[1]).length;
      const bullet = ul ? "• " : `${ol[2]}. `;
      const content = ul ? ul[2] : ol[3];
      const pad = " ".repeat(indent);
      const wrapped = wrapSegments(parseInline(content), Math.max(4, w - indent - bullet.length));
      wrapped.forEach((ln, idx) => {
        const prefix = idx === 0 ? pad + bullet : pad + " ".repeat(bullet.length);
        out.push([{ text: prefix, color: "yellow" }, ...ln]);
      });
      continue;
    }

    if (raw.trim() === "") {
      out.push([]);
      continue;
    }

    for (const ln of wrapSegments(parseInline(raw), w)) out.push(ln);
  }

  return out;
}
