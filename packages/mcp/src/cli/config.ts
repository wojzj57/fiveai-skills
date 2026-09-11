/**
 * Runtime configuration and credential loading (unified-artifact RFC §4,
 * §5). Both the stdio entry and the broker process read the same --config
 * file; the entry also reads the credential file to authenticate its
 * WebSocket connection. Parsing, relative-path resolution, digesting, and
 * credential validation come from the shared contract module
 * (shared/config.ts) so the FiveM resource bundle interprets the same
 * files identically.
 *
 * The digest is computed over the canonical (defaults-applied,
 * real-path-resolved, key-sorted) config so two entries started from the
 * same file always agree, and any material difference (port, stateDir,
 * serverLabel, verifyEnabled, ...) produces a different digest the running
 * broker rejects.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  canonicalPath,
  computeConfigDigest,
  McpConfigSchema,
  readCredentialFile,
  resolveConfigPaths,
  type McpConfig,
} from "../shared/config.ts";
import { assertStatePaths } from "../shared/paths.ts";

export interface LoadedRuntimeConfig {
  /** Absolute path the config was loaded from (used to spawn the broker). */
  configPath: string;
  config: McpConfig;
  configDigest: string;
  /** Raw token strings as stored in the credential file. */
  entryToken: string;
  bridgeToken: string;
}

export function usageError(message: string): Error {
  return new Error(message);
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
  const canonicalConfigPath = canonicalPath(configPath);
  const config = resolveConfigPaths(parsedConfig.data, dirname(canonicalConfigPath));
  // The credential file is read through its as-configured path so a linked
  // file fails the ownership check instead of being silently followed.
  const credentialFilePath = config.credentialFile;
  config.stateDir = canonicalPath(config.stateDir);
  config.clientLogDir = config.clientLogDir === null ? null : canonicalPath(config.clientLogDir);
  config.credentialFile = canonicalPath(config.credentialFile);
  assertStatePaths(config.stateDir);
  const credentials = readCredentialFile(credentialFilePath);

  return {
    configPath: canonicalConfigPath,
    config,
    configDigest: computeConfigDigest(config),
    entryToken: credentials.entryToken,
    bridgeToken: credentials.bridgeToken,
  };
}
