/**
 * Fetch URL Tool
 * Fetches content from a URL with SSRF protection.
 */

import { validateUrl } from "./ssrf.js";

// Maximum response size (10KB)
const MAX_RESPONSE_SIZE = 10 * 1024;

// Request timeout (10 seconds)
const REQUEST_TIMEOUT = 10000;

export default {
  name: "fetch_url",
  description: "Fetch content from a URL. Returns text content up to 10KB. Private/internal URLs are blocked for security.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch (must be http or https)",
      },
    },
    required: ["url"],
  },
  handler: async (args) => {
    const { url } = args;

    if (!url || typeof url !== "string") {
      throw new Error("URL is required and must be a string");
    }

    // Validate URL for SSRF
    const validation = await validateUrl(url);
    if (!validation.safe) {
      throw new Error(validation.reason);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "LLMUI-Tool/1.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Get content type
      const contentType = response.headers.get("content-type") || "";

      // Read response with size limit
      const reader = response.body.getReader();
      const chunks = [];
      let totalSize = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          chunks.push(value.slice(0, MAX_RESPONSE_SIZE - (totalSize - value.length)));
          break;
        }

        chunks.push(value);
      }

      // Combine chunks
      const buffer = new Uint8Array(Math.min(totalSize, MAX_RESPONSE_SIZE));
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk.slice(0, buffer.length - offset), offset);
        offset += chunk.length;
        if (offset >= buffer.length) break;
      }

      // Decode as text
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const text = decoder.decode(buffer);

      // Try to extract useful content
      let content = text;
      let extractedTitle = null;

      // Simple HTML title extraction
      if (contentType.includes("html")) {
        const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          extractedTitle = titleMatch[1].trim();
        }

        // Strip script and style tags for cleaner text
        content = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      return {
        url,
        status: response.status,
        contentType: contentType.split(";")[0].trim(),
        size: totalSize,
        truncated: totalSize > MAX_RESPONSE_SIZE,
        title: extractedTitle,
        content: content.slice(0, MAX_RESPONSE_SIZE),
        warning: validation.warning || null,
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Request timeout");
      }
      throw new Error(`Fetch failed: ${error.message}`);
    }
  },
};
