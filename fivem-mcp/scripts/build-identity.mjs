#!/usr/bin/env node
/**
 * Deterministic build identity (F3 remediation, RFC §4.3 handshake
 * compatibility). One identity is derived from an explicit, fixed list of
 * build inputs so the same source tree always produces the same identity,
 * regardless of the checkout directory, Git presence, or runtime files:
 *
 *   - root package.json, pnpm-lock.yaml, pnpm-workspace.yaml
 *   - fivem-mcp/package.json, fivem-mcp/tsconfig.json, fivem-mcp/fxmanifest.lua
 *   - fivem-mcp/scripts/** (the package build scripts)
 *   - fivem-mcp/src/** (except src/generated/)
 *   - fivem-mcp/http-mcp/** (the in-resource HTTP MCP resource sources)
 *
 * Text is normalized CRLF -> LF, paths use "/", entries are sorted by
 * repository-relative path, and each entry contributes
 * path + NUL + text + NUL to the SHA-256. The identity is
 * `fivem-mcp/<package version>/<sha256 hex>` where the version comes from
 * fivem-mcp/package.json; `digest` carries the same SHA-256 on its own, which
 * is the shape the runtime-debug contract's `status.buildId` requires.
 *
 * writeBuildIdentity(root) embeds the identity into
 * fivem-mcp/src/generated/build-identity.ts — a build artifact: git
 * ignored, never a hash input (no self-reference), and never shipped in
 * the ZIP (esbuild inlines the constants; identity is a compile input
 * only). Identical content is not rewritten. Importing this module never
 * writes files; only the CLI does, and it exits non-zero on failure.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_RELATIVE_PATH = "fivem-mcp/src/generated/build-identity.ts";

/** Directory names a recursive walk never enters. */
const NEVER_SCAN = new Set(["node_modules", "dist", "artifact"]);

/** Required single files, hashed by their repository-relative path. */
const SINGLE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "fivem-mcp/fxmanifest.lua",
  "fivem-mcp/package.json",
  "fivem-mcp/tsconfig.json",
];

/** Required source directories; recursive ones are walked fully. */
const SOURCE_DIRECTORIES = [
  { directory: "fivem-mcp/scripts", recursive: true, extension: null, skip: [] },
  { directory: "fivem-mcp/src", recursive: true, extension: null, skip: ["generated"] },
  // The in-resource HTTP MCP resource is built from here, so its sources are
  // build inputs too; otherwise an edit to server.ts would leave the
  // published buildId unchanged and the artifact could not be matched to code.
  { directory: "fivem-mcp/http-mcp", recursive: true, extension: null, skip: [] },
];

function failMissing(relativePath) {
  throw new Error(`missing required build input: ${relativePath}`);
}

function readInput(root, relativePath) {
  try {
    return readFileSync(join(root, ...relativePath.split("/")), "utf8");
  } catch {
    return failMissing(relativePath);
  }
}

function listDirectoryFiles(root, spec) {
  const directoryPath = join(root, ...spec.directory.split("/"));
  let entries;
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return failMissing(spec.directory);
  }
  const files = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (entry.isDirectory()) {
      if (!spec.recursive || spec.skip.includes(entry.name) || NEVER_SCAN.has(entry.name)) continue;
      files.push(...listDirectoryFiles(root, { ...spec, directory: `${spec.directory}/${entry.name}` }));
    } else if (entry.isFile()) {
      if (spec.extension !== null && !entry.name.endsWith(spec.extension)) continue;
      files.push(`${spec.directory}/${entry.name}`);
    } else {
      throw new Error(`unexpected build input entry (not a regular file): ${join(spec.directory, entry.name)}`);
    }
  }
  return files;
}

/**
 * Derive the build identity for the repository at root. Synchronous and
 * read-only; Node built-ins only.
 */
export function getBuildIdentity(root) {
  const relativePaths = new Set(SINGLE_FILES);
  for (const spec of SOURCE_DIRECTORIES) {
    const files = listDirectoryFiles(root, spec);
    if (files.length === 0) failMissing(spec.directory);
    for (const file of files) relativePaths.add(file);
  }
  const hash = createHash("sha256");
  for (const relativePath of [...relativePaths].sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readInput(root, relativePath).replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  let manifest;
  try {
    manifest = JSON.parse(readInput(root, "fivem-mcp/package.json"));
  } catch {
    throw new Error("fivem-mcp/package.json is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("fivem-mcp/package.json has no usable version string");
  }
  const digest = hash.digest("hex");
  return {
    packageVersion: manifest.version,
    /**
     * Bare SHA-256. The runtime-debug contract requires `status.buildId` to
     * match `^[a-f0-9]{64}$`, and the version is already a hash input, so this
     * is the form the in-resource HTTP MCP reports.
     */
    digest,
    /**
     * Prefixed form for the retiring desktop consumers, which compare the
     * string opaquely. It is not reported to MCP clients.
     */
    buildId: `fivem-mcp/${manifest.version}/${digest}`,
  };
}

/**
 * Derive the identity and embed it into the generated TS module. The file
 * is rewritten only when its content would change.
 */
export function writeBuildIdentity(root) {
  const identity = getBuildIdentity(root);
  const source =
    `export const PACKAGE_VERSION = ${JSON.stringify(identity.packageVersion)};\n` +
    `export const BUILD_ID = ${JSON.stringify(identity.buildId)};\n`;
  const target = join(root, ...GENERATED_RELATIVE_PATH.split("/"));
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // Missing file: fall through and write it.
  }
  if (current !== source) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return identity;
}

function main() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  try {
    const identity = writeBuildIdentity(root);
    console.log(`build-identity: ${identity.buildId}`);
  } catch (error) {
    console.error(`build-identity: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Only a direct `node fivem-mcp/scripts/build-identity.mjs` invocation
// writes files; importing the module (including from contexts without a
// script argument, e.g. `node -e`) must never run the CLI or write anything.
const invokedScript = process.argv[1];
const isCli = typeof invokedScript === "string" && (() => {
  const invoked = pathToFileURL(resolve(invokedScript)).href;
  return process.platform === "win32"
    ? invoked.toLowerCase() === import.meta.url.toLowerCase()
    : invoked === import.meta.url;
})();
if (isCli) main();
