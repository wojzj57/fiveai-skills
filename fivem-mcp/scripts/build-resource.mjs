import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeBuildIdentity } from "./build-identity.mjs";

// This package owns its dependencies: esbuild and ws resolve from
// fivem-mcp/node_modules. The repository root is resolved from this
// script's own location so a fixture workspace builds with its own
// identity, not the source repository's.
const root = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// One shared identity for both ends (F3): the generated module must exist
// before esbuild resolves the generated build-identity import.
writeBuildIdentity(repoRoot);
await build({ entryPoints: [join(root, "src/server/main.js")], outfile: join(root, "dist/server.js"), bundle: true, platform: "node", format: "cjs", target: "node22", external: ["bufferutil", "utf-8-validate"], define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' } });
const client = await build({ entryPoints: [join(root, "src/client/main.js")], outfile: join(root, "dist/client.js"), bundle: true, platform: "browser", format: "iife", target: "es2020", metafile: true });
for (const output of Object.values(client.metafile.outputs)) {
  if (output.imports.length) throw new Error("client bundle must have no runtime imports");
}
// Assemble the deployable resource directory fresh: only a fully successful
// build may leave an artifact behind, so a failed run never looks ready.
// Source paths differ from the deployed resource layout (the Lua executor
// lives at src/lua/executor.lua in the package and at shared/executor.lua in
// the resource), so the mapping is explicit rather than a directory copy.
const RESOURCE_FILES = [
  ["fxmanifest.lua", "fxmanifest.lua"],
  ["README.md", "README.md"],
  ["src/lua/executor.lua", "shared/executor.lua"],
  ["dist/server.js", "dist/server.js"],
  ["dist/client.js", "dist/client.js"],
];
const staged = join(root, "artifact", "fivem-mcp");
await rm(staged, { recursive: true, force: true });
for (const [source, target] of RESOURCE_FILES) {
  await mkdir(join(staged, target, ".."), { recursive: true });
  await copyFile(join(root, source), join(staged, target));
}
console.log(`FiveM resource ready: ${staged}`);
