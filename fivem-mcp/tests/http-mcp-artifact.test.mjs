import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const buildScript = join(packageRoot, "scripts", "build-http-mcp.mjs");
const defaultArtifact = join(packageRoot, "artificials", "fivem-mcp");

/**
 * RFC §12: "测试只能使用临时 fixture 输出，不能运行默认 build 覆盖已挂载目录".
 * The default output `fivem-mcp/artificials/fivem-mcp` is what an operator links
 * into FxDK and may hold their own config, so the artifact contract is verified
 * on a throwaway copy and the default path itself is only checked statically.
 */
let buildRoot = null;
let artifactDirectory = null;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "fiveai-http-mcp-artifact-"));
  artifactDirectory = join(buildRoot, "fivem-mcp");
  const build = spawnSync(process.execPath, [buildScript, "--out", artifactDirectory], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `build failed:\n${build.stdout}\n${build.stderr}`);
});

after(async () => {
  if (buildRoot !== null) await rm(buildRoot, { recursive: true, force: true });
});

test("the build produces the formal HTTP MCP resource artifact", () => {
  const manifestPath = join(artifactDirectory, "fxmanifest.lua");
  assert.equal(existsSync(manifestPath), true, "the formal resource manifest is staged");
  assert.equal(existsSync(join(artifactDirectory, "dist", "server.js")), true, "the formal server bundle is staged");
  assert.equal(
    existsSync(join(artifactDirectory, "dist", "compiler-runtime.cjs")),
    false,
    "native JS needs no runtime compiler module",
  );

  const manifest = readFileSync(manifestPath, "utf8");
  assert.doesNotMatch(manifest, /\bP0\b|throwaway|experiment/i, "the staged resource has no experimental identity");
  assert.match(manifest, /lua\/server\.lua/);
});

test("the resource executes native JS without a compiler or compilation worker", () => {
  const server = readFileSync(join(artifactDirectory, "dist", "server.js"), "utf8");
  const client = readFileSync(join(artifactDirectory, "dist", "client.js"), "utf8");
  assert.doesNotMatch(server, /node:worker_threads|new Worker\(|transpileModule|createSourceFile/);
  assert.doesNotMatch(client, /transpileModule|createSourceFile/);
  assert.equal(existsSync(join(artifactDirectory,"dist/compiler-runtime.cjs")),false);
  assert.match(server, /execute_js/);
  assert.doesNotMatch(server, /execute_ts/);
});

test("tests build into a temporary fixture, never over the mounted default output", () => {
  const script = readFileSync(buildScript, "utf8");
  assert.match(
    script,
    /join\(root, "artificials", "fivem-mcp"\)/,
    "the build script still declares the operator-facing default output",
  );
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts["build:http"], /scripts\/build-http-mcp\.mjs/, "build:http runs the artifact build");
  assert.notEqual(artifactDirectory, defaultArtifact, "this suite must not publish over the directory FxDK mounts");
  assert.equal(artifactDirectory.startsWith(buildRoot), true, "the artifact under test lives inside the fixture");
});

test("the formal artifact loads when FXServer does not inject CommonJS __filename", () => {
  const bundlePath = join(artifactDirectory, "dist", "server.js");
  const source = readFileSync(bundlePath, "utf8");
  // Without Node's CommonJS wrapper both globals are undefined, and bundled
  // dependencies read them, so the banner must define them before any bundled
  // module runs.

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
    vm.runInNewContext(source, context, { filename: bundlePath });
  });
});
