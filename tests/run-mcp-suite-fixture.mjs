/**
 * Run the MCP suite in a disposable workspace. The suite needs freshly built
 * resource and MCP artifacts, but must never publish them into the enclosing
 * repository's dist/fiveai-mcp installation.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createUnifiedFixture } from "./helpers/unified-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

const fixture = createUnifiedFixture(sourceRoot);
try {
  const result = spawnSync("pnpm run build:resource && pnpm --filter fiveai-mcp run test", {
    shell: true,
    windowsHide: true,
    cwd: fixture.root,
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fixture.dispose();
}
