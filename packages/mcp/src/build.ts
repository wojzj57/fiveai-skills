/**
 * Build identity shared by every process of this package (RFC §4.3: the
 * handshake compatibility condition includes a matching build ID). The value
 * is baked into both the entry and broker bundles; a mismatch closes the
 * connection with BUILD_MISMATCH instead of attempting mixed-version
 * operation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readOwnPackageVersion(): string {
  // Bundled artifacts keep this module at the package root scope; the direct
  // source tree resolves the adjacent package.json either way.
  try {
    const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // Fall through to the constant below (bundled esbuild output).
  }
  return "0.1.0";
}

export const PACKAGE_VERSION = readOwnPackageVersion();

/** Stable build identity for hello compatibility checks (RFC §4.3). */
export const BUILD_ID = `fiveai-mcp/${PACKAGE_VERSION}`;
