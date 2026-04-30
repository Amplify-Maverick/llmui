/**
 * File Read Tool
 * Reads files from the tool sandbox directory only.
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

// Sandbox directory - configurable via environment variable
const SANDBOX_DIR = process.env.LLMUI_TOOL_SANDBOX || path.join(os.homedir(), ".llmui", "tool_sandbox");

// Maximum file size to read (10KB)
const MAX_FILE_SIZE = 10 * 1024;

/**
 * Ensure the sandbox directory exists
 */
async function ensureSandboxDir() {
  try {
    await fs.mkdir(SANDBOX_DIR, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Check if a path is within the sandbox directory
 */
function isWithinSandbox(resolvedPath) {
  return resolvedPath.startsWith(SANDBOX_DIR + path.sep) || resolvedPath === SANDBOX_DIR;
}

/**
 * Resolve and validate a path within the sandbox.
 * Uses fs.realpath() to resolve symlinks and prevent symlink escape attacks.
 */
async function resolveSandboxPath(filePath) {
  // Normalize and resolve the path
  const normalized = path.normalize(filePath);
  const resolved = path.resolve(SANDBOX_DIR, normalized);

  // First check: ensure the logical path is within the sandbox
  if (!isWithinSandbox(resolved)) {
    throw new Error("Access denied: Path is outside the sandbox directory");
  }

  // Second check: resolve symlinks and verify the real path is also within sandbox.
  // This prevents symlink escape attacks where a symlink inside the sandbox
  // points to a file outside it.
  try {
    const realPath = await fs.realpath(resolved);
    if (!isWithinSandbox(realPath)) {
      throw new Error("Access denied: Path resolves to location outside the sandbox directory");
    }
    return realPath;
  } catch (error) {
    // If the path doesn't exist, realpath throws ENOENT.
    // In that case, return the resolved path - the actual file operation
    // will fail with ENOENT which is handled appropriately.
    if (error.code === "ENOENT") {
      return resolved;
    }
    throw error;
  }
}

export default {
  name: "file_read",
  description: `Read a file from the tool sandbox directory (~/.llmui/tool_sandbox/). Only files within this directory can be read. Maximum file size: 10KB.`,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file within the sandbox directory (e.g., 'data.txt', 'subdir/file.json')",
      },
    },
    required: ["path"],
  },
  handler: async (args) => {
    const { path: filePath } = args;

    if (!filePath || typeof filePath !== "string") {
      throw new Error("Path is required and must be a string");
    }

    // Ensure sandbox exists
    await ensureSandboxDir();

    // Resolve path within sandbox (uses realpath to prevent symlink escape)
    const resolvedPath = await resolveSandboxPath(filePath);

    try {
      // Check file stats first
      const stats = await fs.stat(resolvedPath);

      if (stats.isDirectory()) {
        // List directory contents instead
        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
        return {
          type: "directory",
          path: filePath,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          })),
        };
      }

      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${stats.size} bytes (max: ${MAX_FILE_SIZE} bytes)`);
      }

      // Read the file
      const content = await fs.readFile(resolvedPath, "utf-8");

      // Detect file type
      const ext = path.extname(resolvedPath).toLowerCase();
      let parsedContent = null;

      if (ext === ".json") {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          // Not valid JSON, return as text
        }
      }

      return {
        type: "file",
        path: filePath,
        size: stats.size,
        content: parsedContent !== null ? parsedContent : content,
        contentType: parsedContent !== null ? "json" : "text",
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${filePath}`);
      }
      if (error.code === "EACCES") {
        throw new Error(`Permission denied: ${filePath}`);
      }
      throw error;
    }
  },
};
