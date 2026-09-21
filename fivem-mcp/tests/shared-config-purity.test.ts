/**
 * The shared config contract is a pure boundary: bundling it must never pull
 * in the MCP SDK, the broker, the CLI, or anything else outside its own
 * sources and zod (unified-artifact RFC §2). The package-wide self-dependency
 * subpath this used to exercise ("fiveai-mcp/internal/config") is gone after
 * the single-package merge, so the same invariant is checked directly against
 * the in-package module.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

test("the shared config contract bundles without the SDK, broker, or CLI", async () => {
  const result = await build({
    stdin: {
      contents:
        'import { McpConfigSchema, resolveConfigPaths } from "./src/shared/config.ts";' +
        ' export const resolved = resolveConfigPaths(McpConfigSchema.parse({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "bundle" }), "D:\\\\install\\\\mcp");',
      resolveDir: packageRoot,
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
  // The shared contract may only pull in its own sources and zod.
  for (const marker of ["@modelcontextprotocol", "fastify", "/ws@", "cli/", "broker/", "tools/"]) {
    assert.equal(inputs.some((input) => input.includes(marker)), false, `forbidden bundled input: ${marker}`);
  }
  assert.equal(inputs.some((input) => input.includes(".pnpm/zod@") || /(?:^|\/)zod\//.test(input)), true);

  assert.ok(result.outputFiles !== undefined);
  const [output] = result.outputFiles;
  assert.ok(output !== undefined);
  const dir = mkdtempSync(join(tmpdir(), "fivem-mcp-shared-config-"));
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
