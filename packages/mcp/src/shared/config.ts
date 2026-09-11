/**
 * Shared read-only config/credential contract (unified-artifact RFC §2,
 * §4, §5). This module is the MCP package's explicit internal subpath
 * export ("fiveai-mcp/internal/config"); the FiveM resource build declares
 * a workspace dependency and bundles it so the desktop entry and the FiveM
 * server interpret the same files identically.
 *
 * It must never import the SDK, the broker, or the CLI, and must stay free
 * of module side effects: zod and Node built-ins only. Credential
 * initialization and Windows ACL operations are desktop-entry-only and
 * deliberately absent here.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { type McpConfig } from "../protocol/config.ts";

export * from "../protocol/config.ts";
export { canonicalPath } from "./paths.ts";

/**
 * Resolve the three data paths (unified-artifact RFC §4): relative values
 * resolve against the config file's directory, absolute values pass
 * through. `configDir` must be absolute — resolution never consults the
 * process working directory, so a moved installation keeps its relative
 * semantics.
 */
export function resolveConfigPaths(config: McpConfig, configDir: string): McpConfig {
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(configDir)) {
    throw new Error("config directory must be an absolute Windows path");
  }
  return {
    ...config,
    stateDir: resolve(configDir, config.stateDir),
    credentialFile: resolve(configDir, config.credentialFile),
    clientLogDir: config.clientLogDir === null ? null : resolve(configDir, config.clientLogDir),
  };
}

/** Recursively key-sorted JSON serialization for stable digests. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Config digest over the normalized config: forward slashes are folded to
 * backslashes so path spellings do not create phantom digest differences;
 * schema defaults (including verifyEnabled and a null clientLogDir) are
 * part of the digest. Every consumer computes it over the same
 * defaults-applied, real-path-resolved shape (unified-artifact RFC §4).
 */
export function computeConfigDigest(config: McpConfig): string {
  const normalized = JSON.parse(
    JSON.stringify(config, (key, value: unknown) => {
      if (typeof value === "string" && key.toLowerCase().endsWith("dir")) {
        return value.replace(/\//g, "\\");
      }
      return value;
    }),
  );
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

export interface Credentials {
  /** Raw token strings as stored in the credential file. */
  entryToken: string;
  bridgeToken: string;
}

const CredentialFileSchema = z.strictObject({
  entryToken: z.string().min(1),
  bridgeToken: z.string().min(1),
});

/** Minimum decoded entropy per token (unified-artifact RFC §5: at least 32 random bytes). */
const MIN_TOKEN_BYTES = 32;

function decodeTokenBytes(token: string): number {
  try {
    return Buffer.from(token, "base64").length;
  } catch {
    return -1;
  }
}

/**
 * Read and validate the credential file (unified-artifact RFC §5). The file
 * must be an exclusive regular file: symlinks and hard links fail
 * explicitly instead of being read through, so a tampered credential source
 * is never masked. Every credential consumer goes through this one function
 * so the same file can never be interpreted two ways.
 */
export function readCredentialFile(path: string): Credentials {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`cannot read credential file: ${path} (${(error as Error).message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`credential file must be an owned regular file without links: ${path}`);
  }
  let credentialText: string;
  try {
    credentialText = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read credential file: ${path} (${(error as Error).message})`);
  }
  let credentialJson: unknown;
  try {
    credentialJson = JSON.parse(credentialText);
  } catch (error) {
    throw new Error(`credential file is not valid JSON: ${(error as Error).message}`);
  }
  const parsedCredentials = CredentialFileSchema.safeParse(credentialJson);
  if (!parsedCredentials.success) {
    throw new Error(`credential file failed schema validation: ${z.prettifyError(parsedCredentials.error)}`);
  }
  for (const [name, token] of [
    ["entryToken", parsedCredentials.data.entryToken],
    ["bridgeToken", parsedCredentials.data.bridgeToken],
  ] as const) {
    if (decodeTokenBytes(token) < MIN_TOKEN_BYTES) {
      throw new Error(`${name} must be base64 encoding at least ${MIN_TOKEN_BYTES} random bytes`);
    }
  }
  return { entryToken: parsedCredentials.data.entryToken, bridgeToken: parsedCredentials.data.bridgeToken };
}
