/**
 * SSRF Protection Module
 * Blocks requests to private/internal IP ranges unless explicitly allowed.
 */

import dns from "dns/promises";
import { URL } from "url";

// Private IP ranges to block
const PRIVATE_IPV4_PATTERNS = [
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^127\./,                         // 127.0.0.0/8 (loopback)
  /^169\.254\./,                    // 169.254.0.0/16 (link-local)
  /^0\./,                           // 0.0.0.0/8
];

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/i,                         // loopback
  /^fe80:/i,                        // link-local
  /^fc[0-9a-f]{2}:/i,              // unique local (fc00::/7)
  /^fd[0-9a-f]{2}:/i,              // unique local (fc00::/7)
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(ip) {
  if (!ip) return false;

  // Check IPv4 patterns
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(ip)) return true;
  }

  // Check IPv6 patterns
  for (const pattern of PRIVATE_IPV6_PATTERNS) {
    if (pattern.test(ip)) return true;
  }

  return false;
}

/**
 * Check if private fetching is allowed via environment variable
 */
export function isAllowPrivate() {
  return process.env.LLMUI_ALLOW_PRIVATE_FETCH === "true";
}

/**
 * Validate a URL for SSRF protection
 * Returns { safe: true } or { safe: false, reason: "..." }
 */
export async function validateUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }

  // Only allow http/https
  if (!["http:", "https:"].includes(url.protocol)) {
    return { safe: false, reason: "Only HTTP/HTTPS URLs are allowed" };
  }

  const hostname = url.hostname.toLowerCase();

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    if (isAllowPrivate()) {
      return { safe: true, warning: "Allowing localhost due to LLMUI_ALLOW_PRIVATE_FETCH" };
    }
    return { safe: false, reason: "Localhost URLs are blocked" };
  }

  // Check if hostname is a direct IP
  if (isPrivateIP(hostname)) {
    if (isAllowPrivate()) {
      return { safe: true, warning: "Allowing private IP due to LLMUI_ALLOW_PRIVATE_FETCH" };
    }
    return { safe: false, reason: "Private IP addresses are blocked" };
  }

  // Resolve hostname and check resulting IPs
  try {
    const addresses = await dns.resolve4(hostname).catch(() => []);
    const addresses6 = await dns.resolve6(hostname).catch(() => []);
    const allAddresses = [...addresses, ...addresses6];

    for (const ip of allAddresses) {
      if (isPrivateIP(ip)) {
        if (isAllowPrivate()) {
          return { safe: true, warning: `Hostname resolves to private IP ${ip}, allowing due to LLMUI_ALLOW_PRIVATE_FETCH` };
        }
        return { safe: false, reason: `Hostname resolves to private IP: ${ip}` };
      }
    }
  } catch (error) {
    // DNS resolution failed - could be a direct IP or invalid hostname
    // If it looks like an IP and we already checked it, proceed
    // Otherwise let the fetch fail naturally
  }

  return { safe: true };
}

export default { validateUrl, isAllowPrivate, isPrivateIP };
