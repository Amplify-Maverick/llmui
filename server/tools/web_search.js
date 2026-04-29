/**
 * Web Search Tool
 * Searches the web using DuckDuckGo HTML endpoint.
 */

// Request timeout (10 seconds)
const REQUEST_TIMEOUT = 10000;

/**
 * Parse DuckDuckGo HTML search results
 */
function parseSearchResults(html) {
  const results = [];

  // DuckDuckGo HTML results are in <a class="result__a"> tags
  // Each result is in a <div class="result"> or similar container

  // Match result links - DuckDuckGo uses result__a class
  const linkRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([^<]+(?:<[^>]+>[^<]*)*)<\/a>/gi;

  // Alternative: Match result blocks
  const resultBlockRegex = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

  let match;

  // Try to extract from result blocks first
  while ((match = resultBlockRegex.exec(html)) !== null && results.length < 5) {
    const block = match[1];

    // Extract URL
    const urlMatch = block.match(/href="([^"]+)"/);
    if (!urlMatch) continue;

    let url = urlMatch[1];
    // DuckDuckGo uses redirect URLs, try to extract the actual URL
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Skip DuckDuckGo internal links
    if (url.startsWith("/") || url.includes("duckduckgo.com")) continue;

    // Extract title
    const titleMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([^<]+)<\/a>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Extract snippet
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let snippet = "";
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    results.push({ url, title, snippet });
  }

  // Fallback: simpler extraction if block parsing didn't work
  if (results.length === 0) {
    const simpleRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    while ((match = simpleRegex.exec(html)) !== null && results.length < 5) {
      let url = match[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
      if (url.startsWith("/") || url.includes("duckduckgo.com")) continue;

      results.push({
        url,
        title: match[2].trim(),
        snippet: "",
      });
    }
  }

  return results;
}

export default {
  name: "web_search",
  description: "Search the web using DuckDuckGo and return the top results.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const { query } = args;

    if (!query || typeof query !== "string") {
      throw new Error("Query is required and must be a string");
    }

    const searchQuery = query.trim();
    if (searchQuery.length === 0) {
      throw new Error("Query cannot be empty");
    }

    if (searchQuery.length > 500) {
      throw new Error("Query too long (max 500 characters)");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      // Use DuckDuckGo HTML endpoint
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LLMUI-Tool/1.0)",
          Accept: "text/html",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Search failed: HTTP ${response.status}`);
      }

      const html = await response.text();
      const results = parseSearchResults(html);

      if (results.length === 0) {
        return {
          query: searchQuery,
          results: [],
          message: "No results found",
        };
      }

      return {
        query: searchQuery,
        results: results.slice(0, 5),
        count: results.length,
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Search request timeout");
      }
      throw new Error(`Search failed: ${error.message}`);
    }
  },
};
