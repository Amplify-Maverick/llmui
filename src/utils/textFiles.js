/**
 * Helpers for attaching source/text files to a message.
 *
 * Unlike images, text files are inlined into the prompt as fenced code blocks
 * so every model can read them — not just multimodal ones. Detection is by
 * extension because browsers report code files inconsistently (a .py file is
 * "text/x-python", "application/octet-stream" or "" depending on the OS).
 */

// Extension → markdown fence language. Keys double as the accepted extension
// list, so adding a language here is all that's needed to support it.
const LANGUAGE_BY_EXTENSION = {
  // Scripting
  py: "python",
  pyw: "python",
  rb: "ruby",
  pl: "perl",
  lua: "lua",
  r: "r",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  // Web
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  svelte: "svelte",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  // Systems / compiled
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  m: "objectivec",
  scala: "scala",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  zig: "zig",
  dart: "dart",
  php: "php",
  // Data / config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "bash",
  xml: "xml",
  csv: "csv",
  tsv: "tsv",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  // Docs / misc
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  rst: "rst",
  txt: "",
  log: "",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  gitignore: "gitignore",
};

// Extension-less files that are still plain text, matched on the whole name.
const LANGUAGE_BY_FILENAME = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  procfile: "",
  ".gitignore": "gitignore",
  ".dockerignore": "gitignore",
  ".env": "bash",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  license: "",
  readme: "markdown",
};

export const ACCEPTED_TEXT_EXTENSIONS = Object.keys(LANGUAGE_BY_EXTENSION).map(
  (ext) => `.${ext}`
);

// Inlined into the prompt, so the useful ceiling is context length rather than
// bandwidth. 1MB is already far past what most local models can hold.
export const MAX_TEXT_FILE_SIZE = 1024 * 1024;

function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Markdown fence language for a filename, or "" when there's no good match. */
export function languageForFile(name) {
  const lower = name.toLowerCase();
  if (lower in LANGUAGE_BY_FILENAME) return LANGUAGE_BY_FILENAME[lower];
  return LANGUAGE_BY_EXTENSION[extensionOf(lower)] ?? "";
}

/** True when the file looks like source code or plain text we can inline. */
export function isTextFile(file) {
  const lower = file.name.toLowerCase();
  if (lower in LANGUAGE_BY_FILENAME) return true;
  if (extensionOf(lower) in LANGUAGE_BY_EXTENSION) return true;
  // Fall back to the MIME type for text files with unknown extensions.
  return file.type.startsWith("text/");
}

/**
 * Render attached files as fenced code blocks to prepend to the user's message.
 * The filename is kept above each block so the model can refer to it.
 */
export function formatTextAttachments(files) {
  return files
    .map((f) => `${f.name}\n\`\`\`${f.language}\n${f.text}\n\`\`\``)
    .join("\n\n");
}

/** Combine attachments and typed text into the message actually sent. */
export function composePrompt(text, files) {
  if (files.length === 0) return text;
  const attachments = formatTextAttachments(files);
  return text ? `${attachments}\n\n${text}` : attachments;
}
