import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadRuntimeConfig } from "../src/cli/config.ts";

test("configuration resolves junction ancestors before hashing and rejects linked internal state files", () => {
  const dir = mkdtempSync(join(tmpdir(), "fiveai-path-"));
  try {
    const target = join(dir, "actual");
    mkdirSync(target);
    const alias = join(dir, "alias");
    symlinkSync(target, alias, "junction");
    const credentialFile = join(dir, "creds.json");
    writeFileSync(credentialFile, JSON.stringify({ entryToken: randomBytes(32).toString("base64"), bridgeToken: randomBytes(32).toString("base64") }));
    const configPath = join(dir, "config.json");
    const config = { version: 1, broker: { host: "127.0.0.1", port: 43189 }, stateDir: join(alias, "new"), clientLogDir: alias, credentialFile, serverLabel: "test" };
    writeFileSync(configPath, JSON.stringify(config));
    const a = loadRuntimeConfig(configPath);
    assert.equal(a.config.stateDir, join(realpathSync(target), "new"));
    writeFileSync(configPath, JSON.stringify({ ...config, stateDir: join(target, "new"), clientLogDir: target }));
    assert.equal(loadRuntimeConfig(configPath).configDigest, a.configDigest);
    mkdirSync(a.config.stateDir);
    symlinkSync(target, join(a.config.stateDir, "runtime.json"), "junction");
    assert.throws(() => loadRuntimeConfig(configPath), /state file|regular file|link/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
