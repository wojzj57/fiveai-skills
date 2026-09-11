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

test("a full explicit v1 configuration parses (unified-artifact RFC §4)", () => {
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

test("data paths accept Windows-absolute and relative values", () => {
  // Relative values are resolved against the config directory at load time
  // (unified-artifact RFC §4); the schema only accepts their form here.
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "logs" }).success, true);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "relative\\path" }).success, true);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "./state" }).success, true);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, clientLogDir: "\\\\server\\share\\logs" }).success, true);
});

test("drive-relative, root-relative, and malformed paths are rejected", () => {
  // These would resolve against a drive root or the working directory
  // instead of the config directory (unified-artifact RFC §4).
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "C:data" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "/data" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "\\data" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "bad*path" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "bad?path" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "C:\\data\x00corrupt" }).success, false);
  // Verbatim (\\?\) and NT device paths remain out of scope.
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "\\\\?\\C:\\data" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "\\\\.\\pipe\\fiveai" }).success, false);
  // A trailing newline must not slip through a prefix-matched path regex.
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "C:\\data\n" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: "data\n" }).success, false);
});

test("data path defaults, a null log dir, and verifyEnabled apply", () => {
  const parsed = McpConfigSchema.parse({
    version: 1,
    broker: { host: "127.0.0.1" },
    serverLabel: "unified",
  });
  assert.equal(parsed.stateDir, "./state");
  assert.equal(parsed.credentialFile, "./credentials.json");
  assert.equal(parsed.clientLogDir, null);
  assert.equal(parsed.verifyEnabled, false);
  assert.equal(parsed.broker.port, 43189);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, clientLogDir: null }).success, true);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, verifyEnabled: true }).success, true);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, verifyEnabled: "false" }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, stateDir: null }).success, false);
  assert.equal(McpConfigSchema.safeParse({ ...BASE, clientLogDir: "" }).success, false);
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
