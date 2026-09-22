/**
 * Throwaway build workspaces for the unified artifact tests (F1 remediation).
 *
 * createUnifiedFixture(sourceRoot, { install = true }) copies the
 * build-relevant source tree — the root manifests, scripts/, and fivem-mcp/
 * (never node_modules, dist, or artifact outputs) — into a fresh mkdtemp
 * directory, then prepares isolated dependencies with
 * `pnpm install --offline --frozen-lockfile`. Build/pack scenarios run
 * inside the fixture; the source repository working tree is never written.
 * Pass { install: false } for hash-only fixtures (build-identity tests): the
 * tree is copied but nothing is installed, skipping the multi-minute offline
 * install.
 *
 * The package's own tests travel with the copied fivem-mcp/ tree, so a
 * fixture can host nested runs. The outer preservation test is deliberately
 * excluded by name: child workspaces cannot recurse into further test runs.
 * Only Node builtins are used; there are no new dependencies.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Generated directories that must never be copied into a fixture. `artificials`
 * is the published resource output: a fixture that inherited the developer's
 * copy could build or assert against a stale artifact instead of its own.
 */
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", "dist", "artifact", "artificials"]);

/** Root files the fixture needs for pnpm to install and the build to run. */
const ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

/** Source directories copied recursively (subject to the exclusions above). */
const SOURCE_DIRECTORIES = ["scripts", "fivem-mcp"];

function copyFileTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyFileTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`unexpected directory entry while copying the fixture: ${from}`);
  }
}

/**
 * Create an isolated build workspace from sourceRoot. Returns the fixture
 * root, its unified install/zip paths, and a dispose() that removes only
 * this fixture's directory after re-verifying ownership.
 */
export function createUnifiedFixture(sourceRoot, { install = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fiveai test workspace "));
  const installDir = join(root, "dist", "fivem-mcp");
  const zipPath = join(root, "dist", "fivem-mcp.zip");
  const ownedRoot = realpathSync(root);
  function dispose() {
    if (!existsSync(root)) return;
    const actual = realpathSync(root);
    const rel = relative(realpathSync(tmpdir()), actual);
    if (actual !== ownedRoot || rel === "" || rel === ".." ||
        rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("refusing to remove an unowned fixture directory");
    }
    rmSync(root, { recursive: true, force: true });
  }

  try {
    for (const file of ROOT_FILES) {
      const from = join(sourceRoot, file);
      if (!existsSync(from)) {
        throw new Error(`the fixture source is missing ${file}: ${sourceRoot}`);
      }
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(from, join(root, file));
    }
    for (const directory of SOURCE_DIRECTORIES) {
      const from = join(sourceRoot, directory);
      if (!existsSync(from)) {
        throw new Error(`the fixture source is missing ${directory}/: ${sourceRoot}`);
      }
      copyFileTree(from, join(root, directory));
    }

    if (install) {
      const installResult = spawnSync("pnpm install --offline --frozen-lockfile", {
        shell: true,
        windowsHide: true,
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      });
      if (installResult.status !== 0) {
        throw new Error(
          `pnpm install --offline --frozen-lockfile failed in the fixture ${root}. ` +
            "The local pnpm store must be warmed for this lockfile before these " +
            "tests run; there is no fallback to the source repository's " +
            `node_modules.\nstdout:\n${installResult.stdout}\nstderr:\n${installResult.stderr}` +
            `\nerror: ${installResult.error ?? "none"}`,
        );
      }
    }
  } catch (error) {
    try {
      dispose();
    } catch {
      // Never mask the original failure with a cleanup failure.
    }
    throw error;
  }

  return { root, installDir, zipPath, dispose };
}
