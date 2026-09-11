import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

// This package owns its dependencies: esbuild and ws resolve from
// packages/fivem-plugin/node_modules, never from a sibling package.
const root = fileURLToPath(new URL("../", import.meta.url));
await build({ entryPoints: [join(root, "server/main.js")], outfile: join(root, "dist/server.js"), bundle: true, platform: "node", format: "cjs", target: "node22", external: ["bufferutil", "utf-8-validate"], define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' } });
const client = await build({ entryPoints: [join(root, "client/main.js")], outfile: join(root, "dist/client.js"), bundle: true, platform: "browser", format: "iife", target: "es2020", metafile: true });
for (const output of Object.values(client.metafile.outputs)) {
  if (output.imports.length) throw new Error("client bundle must have no runtime imports");
}
// Assemble the deployable resource directory fresh: only a fully successful
// build may leave an artifact behind, so a failed run never looks ready.
const staged = join(root, "artifact", "fivem-plugin");
await rm(staged, { recursive: true, force: true });
for (const file of ["fxmanifest.lua", "README.md", "shared/executor.lua", "dist/server.js", "dist/client.js"]) {
  await mkdir(join(staged, file, ".."), { recursive: true });
  await copyFile(join(root, file), join(staged, file));
}
console.log(`FiveM resource ready: ${staged}`);
