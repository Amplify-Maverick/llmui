/**
 * SSRF Protection Module
 * Blocks requests to private/internal IP ranges unless explicitly allowed.
 * Implements DNS pinning to prevent TOCTOU attacks.
 */

import dns from "dns/promises";
import http from "http";
import https from "https";
import { URL } from "url";
import net from "net";

// Maximum redirect hops to follow
export const MAX_REDIRECTS = 5;

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
 * Extract IPv4 from IPv4-mapped IPv6 address
 * e.g., ::ffff:127.0.0.1 -> 127.0.0.1
 */
function extractMappedIPv4(ip) {
  const match = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return match ? match[1] : null;
}

/**
 * Check if an IP address is private/internal
 */
export function isPrivateIP(ip) {
  if (!ip) return false;

  // Check for IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  const mappedIPv4 = extractMappedIPv4(ip);
  if (mappedIPv4) {
    return isPrivateIP(mappedIPv4);
  }

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
 * Validate URL scheme - only http and https are allowed
 */
export function isValidScheme(protocol) {
  return protocol === "http:" || protocol === "https:";
}

/**
 * Resolve hostname to IP and validate against blocklist.
 * Returns the resolved IP if safe, or throws if blocked.
 * This provides a single DNS resolution that can be pinned for the connection.
 */
export async function resolveAndValidate(hostname) {
  const lowerHostname = hostname.toLowerCase();

  // Check blocked hostnames first
  if (BLOCKED_HOSTNAMES.has(lowerHostname)) {
    if (isAllowPrivate()) {
      // Still need to resolve to get an IP to connect to
      try {
        const addresses = await dns.resolve4(hostname);
        if (addresses.length > 0) {
          return { ip: addresses[0], family: 4, warning: "Allowing localhost due to LLMUI_ALLOW_PRIVATE_FETCH" };
        }
      } catch {
        // Fall through to IPv6
      }
      try {
        const addresses = await dns.resolve6(hostname);
        if (addresses.length > 0) {
          return { ip: addresses[0], family: 6, warning: "Allowing localhost due to LLMUI_ALLOW_PRIVATE_FETCH" };
        }
      } catch {
        // No addresses found
      }
      throw new Error("Could not resolve localhost hostname");
    }
    throw new Error("Localhost URLs are blocked");
  }

  // Check if hostname is already an IP address
  if (net.isIPv4(hostname)) {
    if (isPrivateIP(hostname)) {
      if (isAllowPrivate()) {
        return { ip: hostname, family: 4, warning: "Allowing private IP due to LLMUI_ALLOW_PRIVATE_FETCH" };
      }
      throw new Error("Private IP addresses are blocked");
    }
    return { ip: hostname, family: 4 };
  }

  if (net.isIPv6(hostname)) {
    if (isPrivateIP(hostname)) {
      if (isAllowPrivate()) {
        return { ip: hostname, family: 6, warning: "Allowing private IP due to LLMUI_ALLOW_PRIVATE_FETCH" };
      }
      throw new Error("Private IP addresses are blocked");
    }
    return { ip: hostname, family: 6 };
  }

  // Resolve DNS - try IPv4 first, then IPv6
  let resolvedIP = null;
  let family = 4;

  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses.length > 0) {
      resolvedIP = addresses[0];
      family = 4;
    }
  } catch {
    // No IPv4, try IPv6
  }

  if (!resolvedIP) {
    try {
      const addresses = await dns.resolve6(hostname);
      if (addresses.length > 0) {
        resolvedIP = addresses[0];
        family = 6;
      }
    } catch {
      // No IPv6 either
    }
  }

  if (!resolvedIP) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }

  // Validate the resolved IP
  if (isPrivateIP(resolvedIP)) {
    if (isAllowPrivate()) {
      return { ip: resolvedIP, family, warning: `Hostname resolves to private IP ${resolvedIP}, allowing due to LLMUI_ALLOW_PRIVATE_FETCH` };
    }
    throw new Error(`Hostname resolves to private IP: ${resolvedIP}`);
  }

  return { ip: resolvedIP, family };
}

/**
 * Create a custom HTTP/HTTPS agent that pins to a specific resolved IP.
 * This prevents DNS rebinding attacks by not doing a second DNS lookup.
 */
export function createPinnedAgent(protocol, resolvedIP, family) {
  const AgentClass = protocol === "https:" ? https.Agent : http.Agent;

  return new AgentClass({
    // Custom lookup function that returns the pre-resolved IP
    lookup: (hostname, options, callback) => {
      // Return the pinned IP immediately without doing DNS lookup
      callback(null, resolvedIP, family);
    },
    // Don't keep connections alive to avoid reuse issues
    keepAlive: false,
  });
}

/**
 * Validate a URL for SSRF protection (legacy interface for compatibility)
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
  if (!isValidScheme(url.protocol)) {
    return { safe: false, reason: "Only HTTP/HTTPS URLs are allowed" };
  }

  try {
    const result = await resolveAndValidate(url.hostname);
    return { safe: true, warning: result.warning, resolvedIP: result.ip, family: result.family };
  } catch (error) {
    return { safe: false, reason: error.message };
  }
}

/**
 * Full URL validation with DNS resolution for secure fetching.
 * Returns resolved IP info for connection pinning.
 */
export async function validateAndResolve(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Only allow http/https
  if (!isValidScheme(url.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }

  const resolution = await resolveAndValidate(url.hostname);
  return {
    url,
    resolvedIP: resolution.ip,
    family: resolution.family,
    warning: resolution.warning,
  };
}

export default {
  validateUrl,
  validateAndResolve,
  resolveAndValidate,
  createPinnedAgent,
  isAllowPrivate,
  isPrivateIP,
  isValidScheme,
  MAX_REDIRECTS,
};
