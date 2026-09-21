import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = join(packageRoot, "artificials", "fivem-mcp");

test("the default build produces the formal HTTP MCP resource artifact", () => {
  const build = spawnSync("pnpm run build", {
    cwd: packageRoot,
    encoding: "utf8",
    shell: true,
  });
  assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);

  const manifestPath = join(artifactRoot, "fxmanifest.lua");
  assert.equal(existsSync(manifestPath), true, "the formal resource manifest is staged in artificials/fivem-mcp");
  assert.equal(existsSync(join(artifactRoot, "dist", "server.js")), true, "the formal server bundle is staged");

  const manifest = readFileSync(manifestPath, "utf8");
  assert.doesNotMatch(manifest, /\bP0\b|throwaway|experiment/i, "the staged resource has no experimental identity");
  assert.match(manifest, /server_scripts\s*\{\s*'dist\/server\.js'\s*\}/);
});

test("the formal artifact loads when FXServer does not inject CommonJS __filename", () => {
  const bundlePath = join(artifactRoot, "dist", "server.js");
  const context = {
    require: createRequire(bundlePath),
    setTick: () => {},
    on: () => {},
    RegisterCommand: () => {},
    GetCurrentResourceName: () => "fivem-mcp",
    GetResourceState: () => "started",
    GetNumResources: () => 1,
    GetGameTimer: () => 0,
  };
  for (const key of Reflect.ownKeys(globalThis)) {
    if (typeof key === "string" && key !== "__filename" && key !== "__dirname" && key !== "require" && !(key in context)) {
      context[key] = globalThis[key];
    }
  }
  context.global = context;

  assert.doesNotThrow(() => {
    vm.runInNewContext(readFileSync(bundlePath, "utf8"), context, { filename: bundlePath });
  });
});
