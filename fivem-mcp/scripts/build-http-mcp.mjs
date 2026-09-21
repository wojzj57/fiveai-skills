#!/usr/bin/env node
import { build } from "esbuild";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "http-mcp");
const artifactParent = join(root, "artificials");
const staging = join(artifactParent, ".fivem-mcp-staging");
const artifact = join(artifactParent, "fivem-mcp");

await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "dist"), { recursive: true });

try {
  await build({
    entryPoints: [join(source, "src", "server.ts")],
    outfile: join(staging, "dist", "server.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // FXServer loads resource scripts without Node's CommonJS wrapper. The
    // bundled TypeScript compiler reads __filename during initialization, so
    // provide a stable virtual resource path before any bundled module runs.
    banner: { js: "var __filename = '/fivem-mcp/dist/server.js';" },
    define: { __HTTP_MCP_BUILD__: JSON.stringify(new Date().toISOString()) },
    logLevel: "warning",
  });
  await copyFile(join(source, "fxmanifest.lua"), join(staging, "fxmanifest.lua"));
  await copyFile(join(source, "README.md"), join(staging, "README.md"));
  await rm(artifact, { recursive: true, force: true });
  await rename(staging, artifact);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

console.log(`FiveAI HTTP MCP resource ready: ${artifact}`);
