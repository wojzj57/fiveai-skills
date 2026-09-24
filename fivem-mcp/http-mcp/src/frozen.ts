/** Shared transport bounds for the formal HTTP MCP resource. */

export const FROZEN = {
  /** §4: loopback only; never 0.0.0.0, an IPv6 wildcard, or the FiveM game port. */
  httpHost: "127.0.0.1",
  /** §3: the fixed default port. A busy port is an error, never an automatic fallback. */
  httpPort: 30130,
  /** §3: the port domain; configuration rejects values outside this domain. */
  minHttpPort: 1024,
  maxHttpPort: 65535,
  /** §3: the path is fixed, and SetHttpHandler is never used to share the resource routes. */
  httpPath: "/mcp",
  /** §3: HTTP body ceiling. The log and tool budgets are separate and smaller. */
  maxBodyBytes: 256 * 1024,
  /** §3: request body read budget; exceeding it is a 408. */
  maxBodyReadMs: 5_000,
  /** §3: concurrent session ceiling. Over-limit initialize is refused, never evicts a live session. */
  maxSessions: 8,
  /** §3: submitted code ceiling, reused here to bound the JavaScript function body. */
  maxCodeBytes: 64 * 1024,
  /** §4: the only protocol version this first release speaks. */
  protocolVersion: "2025-11-25",
} as const;

/**
 * §4 host allow-list: the normalized loopback spellings, each with the exact
 * configured port. A missing, multi-valued, or malformed Host is rejected;
 * forwarded headers are never trusted.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const expected = `:${port}`;
  if (!host.endsWith(expected)) return false;
  const name = host.slice(0, -expected.length).toLowerCase();
  if (name !== "127.0.0.1" && name !== "localhost") return false;
  // A second colon would mean an IPv6 literal or a smuggled value.
  return !name.includes(":");
}

/**
 * §4 origin allow-list: an absent Origin is allowed (non-browser clients), a
 * present one must be the loopback http origin. `null` and every other origin
 * are rejected with 403; no CORS grant is ever returned.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const expected = `:${port}`;
  if (!origin.startsWith("http://")) return false;
  const authority = origin.slice("http://".length);
  if (!authority.endsWith(expected)) return false;
  const name = authority.slice(0, -expected.length).toLowerCase();
  if (name !== "127.0.0.1" && name !== "localhost") return false;
  return !name.includes(":");
}

/** §5: the JSON-RPC error codes this entry point produces itself. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

/** A JSON-RPC error object for a protocol-level failure (§5). */
export function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
