#!/usr/bin/env node
/**
 * Build the P0 host-feasibility experiment resource.
 *
 * TypeScript is the source language and JavaScript is the delivered form
 * (RFC §2), so this compiles `experiments/p0-http/src/server.ts` into the
 * Node 22 CommonJS bundle the resource manifest loads. The experiment is
 * deliberately absent from `scripts/build-unified.mjs`, so `pnpm build` and
 * `pnpm pack` can never ship it — this script is opt-in.
 *
 * Dependencies resolve from this package's own node_modules (`@modelcontextprotocol/sdk`,
 * `typescript` and `@types/node` are declared here), never from a sibling
 * package, so a fixture workspace builds with its own identity.
 */

import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const experiment = join(root, "experiments", "p0-http");
const outfile = join(experiment, "dist", "server.js");

await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [join(experiment, "src", "server.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // A build stamp so a host log line can be tied back to the exact bundle that
  // produced it; the delivered artifact uses the repository build identity.
  define: { __P0_BUILD__: JSON.stringify(new Date().toISOString()) },
  logLevel: "warning",
});

if (result.warnings.length > 0) {
  console.error(`build-p0-experiment: ${result.warnings.length} esbuild warning(s)`);
}
console.log(`P0 experiment resource ready: ${join(experiment, "dist")}`);
