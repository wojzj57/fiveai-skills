/**
 * RFC-frozen contract values for the HTTP MCP host-feasibility experiment.
 *
 * Every constant here is copied verbatim from
 * `.notes/fivem-mcp-http/rfcs/fivem-resource-http-mcp-rfc.md`, which the
 * project owner explicitly froze as the implementation baseline before this
 * unit was written (RFC §10 asks for that review; RFC §4.2 and §5 hold the
 * proposed values). These are a HTTP MCP probe's inputs, not a published contract:
 * the delivered resource reads the same values from config v2 instead.
 */

export const FROZEN = {
  /** RFC §4.1: loopback-only listener; never 0.0.0.0, an IPv6 wildcard, or the FiveM game port. */
  httpHost: "127.0.0.1",
  /** RFC §4.1 and §5: the fixed default port; a busy port is an error, never an automatic fallback. */
  httpPort: 30130,
  /** RFC §4.1: the path is fixed, and SetHttpHandler is never used to share the resource routes. */
  httpPath: "/mcp",
  /** RFC §4.2: HTTP body ceiling. The log and tool budgets are separate and smaller. */
  maxBodyBytes: 1024 * 1024,
  /** RFC §4.2: proposed session ceiling. Over-limit initialize is refused, never evicts a live session. */
  maxSessions: 32,
  /** RFC §6.2: submitted code ceiling, reused here to bound the compile probe input. */
  maxCodeBytes: 64 * 1024,
} as const;

/**
 * Effective listen port.
 *
 * RFC §5 makes `http.port` a 1–65535 integer, so an explicit override is part
 * of the frozen contract rather than a workaround; only the *default* is
 * fixed and there is never an automatic fallback. The probe reads the
 * override from `FIVEAI_MCP_HTTP_PORT` because it has no config v2 file yet —
 * the delivered resource reads it from `mcp/config.json` on a host tick. The
 * offline suite uses this hook so it never fights a server already listening
 * on 30130.
 */
export function resolveHttpPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return FROZEN.httpPort;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return FROZEN.httpPort;
  return parsed;
}

/**
 * RFC §4.1 host allow-list: the normalized loopback spellings, each with the
 * exact configured port. A missing, multi-valued, or malformed Host is
 * rejected; forwarded headers are never trusted.
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
 * RFC §4.1 origin allow-list: an absent Origin is allowed (non-browser
 * clients), a present one must be the loopback http origin. `null` and every
 * other origin are rejected with 403; no CORS grant is ever returned.
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
