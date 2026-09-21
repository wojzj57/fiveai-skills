/**
 * Fixture preservation regression (F1): the unified pack test must run its
 * build/pack scenarios inside throwaway fixture workspaces and never touch
 * the enclosing workspace's installed files.
 *
 * This test stands in for a user workspace: it seeds sentinel config,
 * credentials, state, and notes inside fixture A's install directory, runs
 * the pack test as a child process with A as its working repository, and
 * requires every sentinel to survive byte-for-byte. The child creates and
 * disposes its own fixture (B); fixture A is disposed in this test's
 * finally. The preservation test is excluded from fixtures by name, so the
 * child cannot recurse. The root test command runs with
 * --test-concurrency=1 because this test's child and the pack test itself
 * both spawn brokers.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUnifiedFixture } from "./helpers/unified-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * node --test executes this file as a child process with NODE_TEST_CONTEXT
 * set; a grandchild that inherits it treats its own `node --test` run as
 * recursive and silently skips running the files (exiting 0). Strip the
 * variable so the child below is a fresh top-level test runner.
 */
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

test("the unified pack test leaves the enclosing workspace's installed files untouched", () => {
  const fixture = createUnifiedFixture(sourceRoot);
  try {
    const sentinels = new Map([
      ["mcp/config.json", Buffer.from('{"userConfig":true}')],
      ["mcp/credentials.json", Buffer.from("private-credential-sentinel")],
      ["mcp/state/recovery.json", Buffer.from("pending-recovery-sentinel")],
      ["notes.txt", Buffer.from("user-note-sentinel")],
    ]);
    for (const [name, bytes] of sentinels) {
      const target = join(fixture.installDir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const child = spawnSync('node --test fivem-mcp/tests/unified-pack.test.mjs', {
      shell: true, windowsHide: true, cwd: fixture.root, encoding: "utf8",
      env: childEnv,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    for (const [name, bytes] of sentinels) {
      assert.deepEqual(readFileSync(join(fixture.installDir, name)), bytes);
    }
  } finally {
    fixture.dispose();
  }
});

test("the MCP test suite leaves the enclosing workspace's installed files untouched", () => {
  const fixture = createUnifiedFixture(sourceRoot);
  try {
    const sentinels = new Map([
      ["dist/server.js", Buffer.from("user-installed-program-sentinel")],
      ["mcp/config.json", Buffer.from('{"userConfig":true}')],
      ["mcp/credentials.json", Buffer.from("private-credential-sentinel")],
      ["mcp/state/recovery.json", Buffer.from("pending-recovery-sentinel")],
      ["notes.txt", Buffer.from("user-note-sentinel")],
    ]);
    for (const [name, bytes] of sentinels) {
      const target = join(fixture.installDir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const child = spawnSync("pnpm run test:mcp", {
      shell: true, windowsHide: true, cwd: fixture.root, encoding: "utf8",
      env: childEnv, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    for (const [name, bytes] of sentinels) {
      assert.deepEqual(readFileSync(join(fixture.installDir, name)), bytes);
    }
  } finally {
    fixture.dispose();
  }
});
