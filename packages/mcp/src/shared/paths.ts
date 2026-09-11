import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Shared path helpers (unified-artifact RFC §2): reachable through the
// internal config subpath export, so this module must stay free of SDK,
// broker, and CLI imports — Node built-ins only.

/** Resolve explicit configuration roots, including a not-yet-created suffix. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute); // A dangling link must fail, not become a missing suffix.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), basename(absolute));
  }
  return realpathSync(absolute);
}

/** Explicit roots may be aliases; broker-owned children may never be links. */
export function assertStatePaths(stateDir: string): void {
  if (canonicalPath(stateDir).toLowerCase() !== resolve(stateDir).toLowerCase()) {
    throw new Error("state directory changed its resolved ownership");
  }
  for (const name of ["runtime.json", "owner.lock", "recovery.json"]) {
    const path = join(stateDir, name);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`state file ${name} must be an owned regular file without links`);
    }
    if (canonicalPath(path).toLowerCase() !== resolve(path).toLowerCase()) {
      throw new Error(`state file ${name} escapes its directory`);
    }
  }
}
