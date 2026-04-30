/**
 * Fetch URL Tool
 * Fetches content from a URL with SSRF protection.
 * Implements manual redirect handling and DNS pinning to prevent:
 * - Redirect-following SSRF attacks
 * - DNS rebinding TOCTOU attacks
 */

import http from "http";
import https from "https";
import {
  validateAndResolve,
  isValidScheme,
  MAX_REDIRECTS,
} from "./ssrf.js";
import { URL } from "url";

// Maximum response size (10KB)
const MAX_RESPONSE_SIZE = 10 * 1024;

// Request timeout (10 seconds)
const REQUEST_TIMEOUT = 10000;

/**
 * Perform a single HTTP/HTTPS request with DNS pinning.
 * The resolvedIP is used directly, preventing DNS rebinding.
 */
function makeRequest(url, resolvedIP, family, signal) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const httpModule = isHttps ? https : http;

    // Determine the port
    const defaultPort = isHttps ? 443 : 80;
    const port = url.port ? parseInt(url.port, 10) : defaultPort;

    const options = {
      // Connect to the resolved IP directly (DNS pinning)
      hostname: resolvedIP,
      port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        // Use original hostname for Host header (required for virtual hosting)
        Host: url.host,
        "User-Agent": "LLMUI-Tool/1.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      // For IPv6, set the family hint
      family: family,
      // For HTTPS, set servername for SNI (must be original hostname, not IP)
      ...(isHttps && { servername: url.hostname }),
      // Disable automatic redirect following
      maxRedirects: 0,
    };

    const req = httpModule.request(options, (res) => {
      resolve(res);
    });

    req.on("error", (err) => {
      reject(err);
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy();
        reject(new Error("Request aborted"));
      });
    }

    req.end();
  });
}

/**
 * Read response body with size limit
 */
function readResponseBody(res, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let truncated = false;

    res.on("data", (chunk) => {
      if (truncated) return;

      totalSize += chunk.length;
      if (totalSize > maxSize) {
        truncated = true;
        // Keep only up to maxSize
        const excess = totalSize - maxSize;
        chunks.push(chunk.slice(0, chunk.length - excess));
        res.destroy(); // Stop reading
      } else {
        chunks.push(chunk);
      }
    });

    res.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve({ buffer, totalSize, truncated });
    });

    res.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Check if a response is a redirect
 */
function isRedirect(status) {
  return status >= 300 && status < 400 && status !== 304;
}

/**
 * Parse and validate a redirect Location header
 */
function resolveRedirectUrl(locationHeader, currentUrl) {
  if (!locationHeader) {
    throw new Error("Redirect response missing Location header");
  }

  // Resolve relative URLs against current URL
  let newUrl;
  try {
    newUrl = new URL(locationHeader, currentUrl.href);
  } catch {
    throw new Error(`Invalid redirect Location: ${locationHeader}`);
  }

  // Validate scheme - reject non-HTTP(S) at every hop
  if (!isValidScheme(newUrl.protocol)) {
    throw new Error(`Redirect to blocked scheme: ${newUrl.protocol}`);
  }

  return newUrl;
}

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

    // Track warnings from any hop
    const warnings = [];
    let currentUrlString = url;
    let redirectCount = 0;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      let response;
      let finalUrl;

      // Manual redirect loop with SSRF validation at each hop
      while (true) {
        // Validate and resolve current URL (closes DNS TOCTOU window)
        let validation;
        try {
          validation = await validateAndResolve(currentUrlString);
        } catch (error) {
          throw new Error(`URL validation failed: ${error.message}`);
        }

        if (validation.warning) {
          warnings.push(validation.warning);
        }

        const currentUrl = validation.url;
        const { resolvedIP, family } = validation;

        // Perform request with DNS pinning (connect directly to resolved IP)
        response = await makeRequest(
          currentUrl,
          resolvedIP,
          family,
          controller.signal
        );

        // Check for redirect
        if (isRedirect(response.statusCode)) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
          }

          const locationHeader = response.headers["location"];
          const newUrl = resolveRedirectUrl(locationHeader, currentUrl);

          // Consume any response body to free up resources
          response.resume();

          // Update URL for next iteration - will be validated at start of loop
          currentUrlString = newUrl.href;
          continue;
        }

        // Not a redirect, we're done
        finalUrl = currentUrl;
        break;
      }

      clearTimeout(timeoutId);

      // Check for HTTP errors
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
      }

      // Get content type
      const contentType = response.headers["content-type"] || "";

      // Read response body with size limit
      const { buffer, totalSize, truncated } = await readResponseBody(
        response,
        MAX_RESPONSE_SIZE
      );

      // Decode as text
      const text = buffer.toString("utf-8");

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
        url: finalUrl.href,
        originalUrl: url,
        redirectCount,
        status: response.statusCode,
        contentType: contentType.split(";")[0].trim(),
        size: totalSize,
        truncated,
        title: extractedTitle,
        content: content.slice(0, MAX_RESPONSE_SIZE),
        warning: warnings.length > 0 ? warnings.join("; ") : null,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.message === "Request aborted" || error.name === "AbortError") {
        throw new Error("Request timeout");
      }
      throw new Error(`Fetch failed: ${error.message}`);
    }
  },
};
