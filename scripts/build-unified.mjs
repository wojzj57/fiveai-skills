#!/usr/bin/env node
/**
 * Unified artifact orchestration (unified-artifact RFC §3, §7).
 *
 *   node scripts/build-unified.mjs publish   stage the delivery whitelist and
 *                                             update dist/fiveai-mcp/ in
 *                                             place (no ZIP)
 *   node scripts/build-unified.mjs pack      stage fresh and produce a
 *                                             validated dist/fiveai-mcp.zip
 *
 * Both subcommands stage into dist/.staging-fiveai-mcp/ from the package
 * build outputs and the repository default config, after resolving and
 * verifying every staging/cleanup path inside the repository output root.
 * Publishing replaces only whitelisted program files (same-directory temp +
 * rename), preserves a local mcp/config.json byte-for-byte, and never reads,
 * modifies, or deletes credentials, state, or user files. Packing zips the
 * clean staging tree — never the local install directory — validates the
 * ZIP entry set and bytes against the staging tree, and only then replaces
 * the final ZIP. Any failure exits non-zero without a success message.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(repoRoot, "dist");
const installDir = join(outputDir, "fiveai-mcp");
const stagingDir = join(outputDir, ".staging-fiveai-mcp");
const zipPath = join(outputDir, "fiveai-mcp.zip");
const tempZipPath = join(outputDir, ".fiveai-mcp.zip.tmp");

/**
 * The delivery whitelist (RFC §3, §7). Program files are replaced on every
 * build; the default config is distinct — a local mcp/config.json is
 * preserved byte-for-byte. Credentials, state, and any other local files
 * are never part of the delivery.
 */
const PROGRAM_FILES = [
  { src: "packages/fivem-plugin/fxmanifest.lua", dest: "fxmanifest.lua" },
  { src: "packages/fivem-plugin/README.md", dest: "README.md" },
  { src: "packages/fivem-plugin/shared/executor.lua", dest: "shared/executor.lua" },
  { src: "packages/fivem-plugin/dist/server.js", dest: "dist/server.js" },
  { src: "packages/fivem-plugin/dist/client.js", dest: "dist/client.js" },
  { src: "packages/mcp/dist/entry.mjs", dest: "mcp/entry.mjs" },
  { src: "packages/mcp/dist/broker.mjs", dest: "mcp/broker.mjs" },
  { src: "packages/mcp/dist/windows-files.ps1", dest: "mcp/windows-files.ps1" },
];
const DEFAULT_CONFIG = { src: "packages/fivem-plugin/mcp/config.json", dest: "mcp/config.json" };
const DELIVERY_FILES = [...PROGRAM_FILES, DEFAULT_CONFIG];

function assertRealFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} is not a regular file: ${path}`);
  }
}

/** Resolve a path and require it to stay inside the repository output root. */
function assertWithinOutput(path, label) {
  // The anchor is the repository's own dist/ tree — a symlinked dist/ that
  // re-anchors the whole output somewhere else must fail, not pass.
  const outputPrefix = `${realpathSync(repoRoot).toLowerCase()}${sep}dist`;
  const outputReal = realpathSync(outputDir).toLowerCase();
  if (outputReal !== outputPrefix && !outputReal.startsWith(`${outputPrefix}${sep}`)) {
    fail(`the output directory resolves outside the repository dist/ tree: ${outputDir}`);
  }
  const resolved = resolve(path).toLowerCase();
  let real;
  try {
    real = realpathSync(resolved).toLowerCase();
  } catch {
    real = resolved;
  }
  if (real !== outputReal && !real.startsWith(`${outputReal}${sep}`)) {
    fail(`${label} resolves outside the repository output directory: ${path}`);
  }
}

function ensureRealDirectory(path, label) {
  assertWithinOutput(path, label);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`${label} is not a real directory: ${path}`);
    }
    return;
  }
  mkdirSync(path, { recursive: true });
}

/** Every file below root, as forward-slash relative names (no directories). */
function listFilesRecursive(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split("\\").join("/"));
      else fail(`unexpected file type in the staging tree: ${path}`);
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Rebuild the clean staging tree from the package outputs and the
 * repository default config, then verify the staged file set against the
 * whitelist exactly — a future manifest mistake must fail the build, not
 * widen the delivery.
 */
function stageDelivery() {
  mkdirSync(outputDir, { recursive: true });
  if (existsSync(stagingDir)) {
    const stat = lstatSync(stagingDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(`the staging path is not a real directory: ${stagingDir}`);
    }
    assertWithinOutput(stagingDir, "staging directory");
  }
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  for (const file of DELIVERY_FILES) {
    const src = join(repoRoot, file.src);
    assertRealFile(src, `delivery source ${file.src}`);
    const dest = join(stagingDir, file.dest);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
  }

  const staged = listFilesRecursive(stagingDir);
  const expected = DELIVERY_FILES.map((file) => file.dest).sort();
  if (staged.length !== expected.length || staged.some((name, index) => name !== expected[index])) {
    fail(`the staged tree does not match the delivery whitelist: ${JSON.stringify(staged)}`);
  }

  // The manifest must load only the executor and the bundles; the mcp/
  // payload must never enter files, shared_scripts, or client_scripts
  // (unified-artifact RFC §6).
  const manifest = readFileSync(join(stagingDir, "fxmanifest.lua"), "utf8");
  if (/mcp/i.test(manifest)) {
    fail("fxmanifest.lua must not reference the mcp/ payload directory");
  }
  if (!/server_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/server\.js'\s*\}/.test(manifest)) {
    fail("fxmanifest.lua server_scripts must load exactly the executor and the server bundle");
  }
  if (!/client_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/client\.js'\s*\}/.test(manifest)) {
    fail("fxmanifest.lua client_scripts must load exactly the executor and the client bundle");
  }
}

/** Replace one destination file via a same-directory temp and rename. */
function publishFile(src, dest) {
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    fail(`refusing to publish over a link: ${dest}`);
  }
  const temp = `${dest}.publish-${process.pid}.tmp`;
  copyFileSync(src, temp);
  try {
    renameSync(temp, dest);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup of our own temp file.
    }
    fail(`publishing failed for ${dest}: ${error.message}`);
  }
}

/**
 * Publish the staged program files into dist/fiveai-mcp/ (RFC §7): program
 * files are replaced one by one; an existing mcp/config.json is preserved
 * byte-for-byte; credentials, state, and unrelated user files are never
 * touched. Cross-file replacement is not transactional — a mid-way failure
 * leaves earlier files updated and requires a fresh build.
 */
function publishUnified() {
  stageDelivery();
  ensureRealDirectory(installDir, "install directory");
  for (const directory of ["shared", "dist", "mcp"]) {
    ensureRealDirectory(join(installDir, directory), `install ${directory} directory`);
  }
  for (const file of PROGRAM_FILES) {
    publishFile(join(stagingDir, file.dest), join(installDir, file.dest));
  }
  const configDest = join(installDir, DEFAULT_CONFIG.dest);
  if (existsSync(configDest)) {
    const stat = lstatSync(configDest);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`the local mcp/config.json is not a regular file: ${configDest}`);
    }
    // Exists: preserved byte-for-byte; never rewritten by a build.
  } else {
    publishFile(join(stagingDir, DEFAULT_CONFIG.dest), configDest);
  }
}

/**
 * Build the ZIP from the clean staging tree (never from the local install
 * directory), validate it in a sibling temp file, and only then replace
 * the final ZIP. On failure the temp file is removed and the previous ZIP
 * (if any) stays — explicitly not this run's product.
 */
function packZip() {
  stageDelivery();
  const entries = {};
  for (const file of DELIVERY_FILES) {
    entries[`fiveai-mcp/${file.dest}`] = new Uint8Array(readFileSync(join(stagingDir, file.dest)));
  }
  const packed = zipSync(entries, { level: 6, mtime: new Date("2026-01-01T00:00:00.000Z") });
  writeFileSync(tempZipPath, packed);
  try {
    const reread = unzipSync(new Uint8Array(readFileSync(tempZipPath)));
    const expectedNames = Object.keys(entries);
    const actualNames = Object.keys(reread);
    const expectedSet = new Set(expectedNames);
    if (actualNames.length !== expectedSet.size || actualNames.some((name) => !expectedSet.has(name))) {
      fail(`ZIP validation failed: the unpacked entry set does not match the delivery whitelist`);
    }
    for (const [name, bytes] of Object.entries(reread)) {
      if (!name.startsWith("fiveai-mcp/")) {
        fail(`ZIP validation failed: entry outside the fiveai-mcp root: ${name}`);
      }
      const staged = new Uint8Array(readFileSync(join(stagingDir, name.slice("fiveai-mcp/".length))));
      if (Buffer.compare(Buffer.from(bytes), Buffer.from(staged)) !== 0) {
        fail(`ZIP validation failed: ${name} differs from the staged file`);
      }
    }
  } catch (error) {
    if (error instanceof BuildError) throw error;
    fail(`ZIP validation failed: ${error.message}`);
  }
  renameSync(tempZipPath, zipPath);
}

function main() {
  const command = process.argv[2] ?? "";
  if (command === "publish") {
    publishUnified();
    console.log(`Unified artifact published: ${installDir}`);
    return;
  }
  if (command === "pack") {
    packZip();
    console.log(`Unified artifact packed: ${zipPath}`);
    return;
  }
  console.error("usage: node scripts/build-unified.mjs publish|pack");
  process.exitCode = 2;
}

try {
  main();
} catch (error) {
  // A failed ZIP attempt removes only this run's temp file; the previous
  // final ZIP (if any) stays but is explicitly not this run's product.
  try {
    if (existsSync(tempZipPath)) rmSync(tempZipPath, { force: true });
  } catch {
    // Best effort.
  }
  console.error(`build-unified: ${error instanceof BuildError ? error.message : (error.stack ?? error)}`);
  process.exit(1);
}
