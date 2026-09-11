import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = fileURLToPath(new URL("../../fivem-plugin/", import.meta.url));

test("the internal config subpath is an explicit package export", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports?.["./internal/config"], "./src/shared/config.ts");
  assert.equal(existsSync(join(packageRoot, "src", "shared", "config.ts")), true);
});

test("the fivem-plugin workspace link resolves the internal subpath", () => {
  const require = createRequire(join(pluginRoot, "package.json"));
  const resolved = require.resolve("fiveai-mcp/internal/config");
  const expected = realpathSync(join(packageRoot, "src", "shared", "config.ts"));
  assert.equal(realpathSync(resolved).toLowerCase(), expected.toLowerCase());
});

test("the internal subpath bundles without the SDK, broker, or CLI", async () => {
  const result = await build({
    stdin: {
      contents:
        'import { McpConfigSchema, resolveConfigPaths } from "fiveai-mcp/internal/config";' +
        ' export const resolved = resolveConfigPaths(McpConfigSchema.parse({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "bundle" }), "D:\\\\install\\\\mcp");',
      resolveDir: pluginRoot,
      loader: "js",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.ok(result.metafile !== undefined);
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/g, "/"));
  // The shared contract may only pull in its own sources and zod
  // (unified-artifact RFC §2: no SDK, broker, or CLI imports).
  for (const marker of ["@modelcontextprotocol", "fastify", "/ws@", "cli/", "broker/", "tools/"]) {
    assert.equal(inputs.some((input) => input.includes(marker)), false, `forbidden bundled input: ${marker}`);
  }
  assert.equal(inputs.some((input) => input.includes(".pnpm/zod@") || /(?:^|\/)zod\//.test(input)), true);

  assert.ok(result.outputFiles !== undefined);
  const [output] = result.outputFiles;
  assert.ok(output !== undefined);
  const dir = mkdtempSync(join(tmpdir(), "fiveai-subpath-"));
  try {
    const outFile = join(dir, "bundle.mjs");
    writeFileSync(outFile, output.text);
    const exported = (await import(pathToFileURL(outFile).href)) as {
      resolved: { stateDir: string; credentialFile: string; clientLogDir: string | null; verifyEnabled: boolean };
    };
    assert.equal(exported.resolved.stateDir, "D:\\install\\mcp\\state");
    assert.equal(exported.resolved.credentialFile, "D:\\install\\mcp\\credentials.json");
    assert.equal(exported.resolved.clientLogDir, null);
    assert.equal(exported.resolved.verifyEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
