import assert from "node:assert/strict";
import test from "node:test";
import { McpConfigSchema } from "../src/protocol/config.ts";

const BASE = {
  version: 1,
  broker: { host: "127.0.0.1", port: 43189 },
  stateDir: "C:\\Users\\name\\AppData\\Local\\FiveAI\\mcp",
  credentialFile: "C:\\Users\\name\\AppData\\Local\\FiveAI\\mcp-token.json",
  clientLogDir: "D:\\FiveM\\FiveM.app\\logs",
  serverLabel: "local-development",
};

test("the RFC §4.1 example configuration parses", () => {
  const parsed = McpConfigSchema.parse(BASE);
  assert.equal(parsed.broker.port, 43189);
});

test("port defaults to 43189 when omitted", () => {
  const parsed = McpConfigSchema.parse({
    ...BASE,
    broker: { host: "127.0.0.1" },
  });
  assert.equal(parsed.broker.port, 43189);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, broker: { host: "127.0.0.1", port: 0 } }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, broker: { host: "127.0.0.1", port: 70000 } }).success, false);
});

test("host is locked to loopback in the first version", () => {
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, broker: { host: "0.0.0.0", port: 1234 } }).success,
    false,
  );
});

test("paths must be Windows absolute (drive letter or UNC)", () => {
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "logs" }).success,
    false,
  );
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "relative\\path" }).success,
    false,
  );
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, clientLogDir: "\\\\server\\share\\logs" }).success,
    true,
  );
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "C:\\data\x00corrupt" }).success,
    false,
  );
  // Verbatim (\\?\) paths are intentionally out of scope for the first version.
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "\\\\?\\C:\\data" }).success,
    false,
  );
  // NT device paths (\\.\pipe\...) are also out of scope.
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "\\\\.\\pipe\\fiveai" }).success,
    false,
  );
  // A trailing newline must not slip through a prefix-matched path regex.
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, stateDir: "C:\\data\n" }).success,
    false,
  );
});

test("unknown fields and wrong versions are rejected", () => {
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, extra: true }).success,
    false,
  );
  assert.equal(
    McpConfigSchema.safeParse({ ...BASE, version: 2 }).success,
    false,
  );
});
