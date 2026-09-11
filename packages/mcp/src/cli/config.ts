/**
 * Runtime configuration and credential loading (RFC §4.1). Both the stdio
 * entry and the broker process read the same --config file; the entry also
 * reads the credential file to authenticate its WebSocket connection.
 *
 * The digest is computed over the canonical (defaults-applied,
 * key-sorted) config so two entries started from the same file always
 * agree, and any material difference (port, stateDir, serverLabel, ...)
 * produces a different digest the running broker rejects.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { McpConfigSchema, type McpConfig } from "../protocol/config.ts";
import { canonicalPath, assertStatePaths } from "./paths.ts";

export interface LoadedRuntimeConfig {
  /** Absolute path the config was loaded from (used to spawn the broker). */
  configPath: string;
  config: McpConfig;
  configDigest: string;
  /** Raw token strings as stored in the credential file. */
  entryToken: string;
  bridgeToken: string;
}

const CredentialFileSchema = z.strictObject({
  entryToken: z.string().min(1),
  bridgeToken: z.string().min(1),
});

/** Minimum decoded entropy per token (RFC §4.1: at least 32 random bytes). */
const MIN_TOKEN_BYTES = 32;

export function usageError(message: string): Error {
  return new Error(message);
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
 * defaults applied by the schema are included.
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

/**
 * Timing-safe bearer-token comparison. Both sides are hashed first so the
 * comparison length is constant and never leaks the token length.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function decodeTokenBytes(token: string): number {
  try {
    return Buffer.from(token, "base64").length;
  } catch {
    return -1;
  }
}

/**
 * Read and validate the config plus its credential file.
 * Throws Error with a user-facing message; callers map it to their exit
 * path (the entry prints it to stderr and exits without starting anything).
 */
export function loadRuntimeConfig(configPath: string): LoadedRuntimeConfig {
  if (!/^([A-Za-z]:[\\/]|\\\\)/.test(configPath)) {
    throw usageError("--config requires an absolute Windows path");
  }
  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    throw usageError(`cannot read config file: ${configPath} (${(error as Error).message})`);
  }
  let configJson: unknown;
  try {
    configJson = JSON.parse(configText);
  } catch (error) {
    throw usageError(`config file is not valid JSON: ${(error as Error).message}`);
  }
  const parsedConfig = McpConfigSchema.safeParse(configJson);
  if (!parsedConfig.success) {
    throw usageError(`config file failed schema validation: ${z.prettifyError(parsedConfig.error)}`);
  }
  const config = parsedConfig.data;
  configPath = canonicalPath(configPath);
  config.stateDir = canonicalPath(config.stateDir);
  config.clientLogDir = canonicalPath(config.clientLogDir);
  config.credentialFile = canonicalPath(config.credentialFile);
  assertStatePaths(config.stateDir);

  let credentialText: string;
  try {
    credentialText = readFileSync(config.credentialFile, "utf8");
  } catch (error) {
    throw usageError(
      `cannot read credential file: ${config.credentialFile} (${(error as Error).message})`,
    );
  }
  let credentialJson: unknown;
  try {
    credentialJson = JSON.parse(credentialText);
  } catch (error) {
    throw usageError(`credential file is not valid JSON: ${(error as Error).message}`);
  }
  const parsedCredentials = CredentialFileSchema.safeParse(credentialJson);
  if (!parsedCredentials.success) {
    throw usageError(
      `credential file failed schema validation: ${z.prettifyError(parsedCredentials.error)}`,
    );
  }
  for (const [name, token] of [
    ["entryToken", parsedCredentials.data.entryToken],
    ["bridgeToken", parsedCredentials.data.bridgeToken],
  ] as const) {
    if (decodeTokenBytes(token) < MIN_TOKEN_BYTES) {
      throw usageError(
        `${name} must be base64 encoding at least ${MIN_TOKEN_BYTES} random bytes`,
      );
    }
  }

  return {
    configPath,
    config,
    configDigest: computeConfigDigest(config),
    entryToken: parsedCredentials.data.entryToken,
    bridgeToken: parsedCredentials.data.bridgeToken,
  };
}
