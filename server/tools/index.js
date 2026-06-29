/**
 * Tool Registry and Executor
 * Manages built-in tools for Ollama function calling.
 */

import webSearch from "./web_search.js";
import fetchUrl from "./fetch_url.js";
import getCurrentTime from "./get_current_time.js";
import calculator from "./calculator.js";
import fileRead from "./file_read.js";
import blenderExecute from "./blender_execute.js";

// All available tools
export const TOOLS = {
  web_search: webSearch,
  fetch_url: fetchUrl,
  get_current_time: getCurrentTime,
  calculator: calculator,
  file_read: fileRead,
  blender_execute: blenderExecute,
};

// Tool metadata for UI display
export const TOOL_INFO = {
  web_search: {
    displayName: "Web Search",
    description: "Search the web using DuckDuckGo",
    defaultEnabled: true,
  },
  fetch_url: {
    displayName: "Fetch URL",
    description: "Fetch content from a URL",
    defaultEnabled: false,
  },
  get_current_time: {
    displayName: "Current Time",
    description: "Get the current date and time",
    defaultEnabled: true,
  },
  calculator: {
    displayName: "Calculator",
    description: "Evaluate mathematical expressions",
    defaultEnabled: false,
  },
  file_read: {
    displayName: "File Read",
    description: "Read files from the tool sandbox directory",
    defaultEnabled: false,
  },
  blender_execute: {
    displayName: "Blender Execute",
    description: "Run Python scripts inside Blender via the LLMUI bridge addon",
    defaultEnabled: false,
  },
};

/**
 * Convert tools to Ollama's expected schema format
 * @param {string[]|null} enabledTools - List of enabled tool names, or null for all
 * @returns {Array} Ollama-compatible tools array
 */
export function getToolsSchema(enabledTools = null) {
  const toolEntries = Object.entries(TOOLS);
  const filteredTools = enabledTools
    ? toolEntries.filter(([name]) => enabledTools.includes(name))
    : toolEntries;

  return filteredTools.map(([, tool]) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Execute a tool by name with given arguments
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
export async function executeTool(name, args) {
  const tool = TOOLS[name];

  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  try {
    const result = await tool.handler(args);
    return { success: true, result };
  } catch (error) {
    console.error(`Tool ${name} execution error:`, error);
    return { success: false, error: error.message || "Tool execution failed" };
  }
}

/**
 * Get list of all available tool names
 */
export function getToolNames() {
  return Object.keys(TOOLS);
}

/**
 * Check if a tool exists
 */
export function hasTool(name) {
  return name in TOOLS;
}

export default {
  TOOLS,
  TOOL_INFO,
  getToolsSchema,
  executeTool,
  getToolNames,
  hasTool,
};
