/**
 * Runtime configuration and credential loading (unified-artifact RFC §4,
 * §5). Both the stdio entry and the broker process read the same --config
 * file; the entry also ensures the credential file exists before it
 * discovers or spawns the broker. Parsing, relative-path resolution,
 * digesting, and credential validation come from the shared contract
 * module (shared/config.ts) so the FiveM resource bundle interprets the
 * same files identically.
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

/**
 * A loaded config without credentials. `credentialFilePath` is the
 * as-resolved (pre-normalization) credential path: reading through it
 * fails on linked files instead of silently following them, so the
 * entry's initialization phase keeps the same guarantees as before
 * (unified-artifact RFC §5.1).
 */
export interface LoadedConfig {
  /** Absolute path the config was loaded from (used to spawn the broker). */
  configPath: string;
  config: McpConfig;
  configDigest: string;
  /** As-resolved credential path; reads through it fail on links. */
  credentialFilePath: string;
}

export interface LoadedRuntimeConfig extends LoadedConfig {
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

interface ParsedConfigFile {
  configPath: string;
  config: McpConfig;
}

function parseConfigFile(configPath: string): ParsedConfigFile {
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
  return {
    configPath: canonicalConfigPath,
    config: resolveConfigPaths(parsedConfig.data, dirname(canonicalConfigPath)),
  };
}

interface FinalizedConfig {
  config: McpConfig;
  asConfiguredCredentialFile: string;
}

function finalizeConfig(config: McpConfig): FinalizedConfig {
  const asConfiguredCredentialFile = config.credentialFile;
  const canonical: McpConfig = { ...config };
  canonical.stateDir = canonicalPath(config.stateDir);
  canonical.clientLogDir = config.clientLogDir === null ? null : canonicalPath(config.clientLogDir);
  canonical.credentialFile = canonicalPath(config.credentialFile);
  assertStatePaths(canonical.stateDir);
  return { config: canonical, asConfiguredCredentialFile };
}

/**
 * Read and validate the config alone (no credentials). The no-argument
 * desktop entry uses this before first-run credential initialization
 * (unified-artifact RFC §5.1); the broker still uses loadRuntimeConfig.
 */
export function loadConfig(configPath: string): LoadedConfig {
  const parsed = parseConfigFile(configPath);
  const final = finalizeConfig(parsed.config);
  return {
    configPath: parsed.configPath,
    config: final.config,
    configDigest: computeConfigDigest(final.config),
    credentialFilePath: final.asConfiguredCredentialFile,
  };
}

/**
 * Read and validate the config plus its credential file (broker and
 * direct-start paths: credentials must already exist). Throws Error with
 * a user-facing message; callers map it to their exit path.
 */
export function loadRuntimeConfig(configPath: string): LoadedRuntimeConfig {
  const parsed = parseConfigFile(configPath);
  // The credential file is read through its as-configured path so a linked
  // file fails the ownership check instead of being silently followed.
  const credentials = readCredentialFile(parsed.config.credentialFile);
  const final = finalizeConfig(parsed.config);
  return {
    configPath: parsed.configPath,
    config: final.config,
    configDigest: computeConfigDigest(final.config),
    credentialFilePath: final.asConfiguredCredentialFile,
    entryToken: credentials.entryToken,
    bridgeToken: credentials.bridgeToken,
  };
}
