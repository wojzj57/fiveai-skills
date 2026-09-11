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
 * Credential read failure kinds (unified-artifact RFC §5.2). Only "missing"
 * may lead to first-run generation; "unreadable" (occupied, permission,
 * transient I/O) and "invalid" (corrupt, empty, wrong form, links) must
 * fail explicitly — an arbitrary read error is never a reason to
 * regenerate credentials.
 */
export type CredentialErrorKind = "missing" | "unreadable" | "invalid";

export class CredentialFileError extends Error {
  readonly kind: CredentialErrorKind;

  constructor(kind: CredentialErrorKind, message: string) {
    super(message);
    this.name = "CredentialFileError";
    this.kind = kind;
  }
}

/** Shape of node:fs Stats as consumed by credential form validation. */
export interface CredentialFileFacts {
  isRegularFile: boolean;
  isSymbolicLink: boolean;
  linkCount: number;
}

/**
 * Validate already-read credential bytes plus the file facts (unified-artifact
 * RFC §5). The file must be an exclusive regular file: symlinks and hard
 * links fail explicitly instead of being read through, so a tampered
 * credential source is never masked. Async consumers (the FiveM resource)
 * read the file themselves and run this same validation, so one file can
 * never be interpreted two ways. Only ever throws CredentialFileError.
 */
export function validateCredentialFile(path: string, facts: CredentialFileFacts, text: string): Credentials {
  if (!facts.isRegularFile || facts.isSymbolicLink || facts.linkCount !== 1) {
    throw new CredentialFileError(
      "invalid",
      `credential file must be an owned regular file without links: ${path}`,
    );
  }
  let credentialJson: unknown;
  try {
    credentialJson = JSON.parse(text);
  } catch (error) {
    throw new CredentialFileError("invalid", `credential file is not valid JSON: ${(error as Error).message}`);
  }
  const parsedCredentials = CredentialFileSchema.safeParse(credentialJson);
  if (!parsedCredentials.success) {
    throw new CredentialFileError(
      "invalid",
      `credential file failed schema validation: ${z.prettifyError(parsedCredentials.error)}`,
    );
  }
  for (const [name, token] of [
    ["entryToken", parsedCredentials.data.entryToken],
    ["bridgeToken", parsedCredentials.data.bridgeToken],
  ] as const) {
    if (decodeTokenBytes(token) < MIN_TOKEN_BYTES) {
      throw new CredentialFileError(
        "invalid",
        `${name} must be base64 encoding at least ${MIN_TOKEN_BYTES} random bytes`,
      );
    }
  }
  return { entryToken: parsedCredentials.data.entryToken, bridgeToken: parsedCredentials.data.bridgeToken };
}

/**
 * Read and validate the credential file synchronously (unified-artifact
 * RFC §5). Throws CredentialFileError so callers can distinguish a missing
 * file from an unreadable or invalid one.
 */
export function readCredentialFile(path: string): Credentials {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw credentialReadError(path, error, "cannot read credential file");
  }
  const facts: CredentialFileFacts = {
    isRegularFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    linkCount: stat.nlink,
  };
  // The form is checked before any byte is read, so a directory or a
  // linked file fails as an ownership violation, never as a read error.
  if (!facts.isRegularFile || facts.isSymbolicLink || facts.linkCount !== 1) {
    throw new CredentialFileError(
      "invalid",
      `credential file must be an owned regular file without links: ${path}`,
    );
  }
  let credentialText: string;
  try {
    credentialText = readFileSync(path, "utf8");
  } catch (error) {
    throw credentialReadError(path, error, "cannot read credential file");
  }
  return validateCredentialFile(path, facts, credentialText);
}

function credentialReadError(path: string, error: unknown, prefix: string): CredentialFileError {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new CredentialFileError("missing", `credential file does not exist: ${path}`);
  }
  return new CredentialFileError("unreadable", `${prefix}: ${path} (${(error as Error).message})`);
}
