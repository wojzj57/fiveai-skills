/**
 * Entry argument-contract and diagnostic tests (unified-artifact RFC §4,
 * §5.1). Every scenario here terminates in the argument, config, or
 * credential phase — before any broker named-pipe interaction — so this
 * file is parallel-safe with the broker process tests. The full no-argument
 * happy path (generate credentials, spawn a broker, serve MCP over stdio)
 * is covered by the root unpack test against the real ZIP artifact.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const MCP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENTRY_ARTIFACT = join(MCP_ROOT, "dist", "entry.mjs");
const HELPER_ARTIFACT = join(MCP_ROOT, "dist", "windows-files.ps1");

interface EntryRun {
  code: number | null;
  stderr: string;
}

function runEntry(entry: string, args: string[], cwd: string): Promise<EntryRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "pipe"], cwd });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`entry did not exit in time; stderr so far: ${stderr}`));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on("error", reject);
  });
}

/** A minimal installation dir: the built entry + helper, plus files the test adds. */
function makeInstall(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fiveai-entrycli-${name}-`));
  copyFileSync(ENTRY_ARTIFACT, join(dir, "entry.mjs"));
  copyFileSync(HELPER_ARTIFACT, join(dir, "windows-files.ps1"));
  return dir;
}

function writeConfig(dir: string): string {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    broker: { host: "127.0.0.1", port: 43189 },
    serverLabel: "entry-cli",
  }));
  return configPath;
}

const USAGE = /usage: node entry\.mjs/;

test("argument contract: only no-arg and a single absolute --config are accepted", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-entrycli-cwd-"));
  try {
    for (const argv of [
      ["--config"],
      ["--config", "relative\\config.json"],
      ["--config", "C:\\not\\absolute", "extra"],
      ["--config", "C:\\a", "--config", "C:\\b"],
      ["--config", "--config"],
      ["nonsense"],
      ["--config", "D:/ok-style-but-missing/config.json", "x"],
    ] as string[][]) {
      const run = await runEntry(ENTRY_ARTIFACT, argv, elsewhere);
      assert.equal(run.code, 2, `argv ${JSON.stringify(argv)} exits with the usage code`);
      assert.match(run.stderr, USAGE, `argv ${JSON.stringify(argv)} prints usage`);
    }
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the no-argument entry requires a config next to itself", async () => {
  const dir = makeInstall("noconfig");
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-entrycli-cwd2-"));
  try {
    const run = await runEntry(join(dir, "entry.mjs"), [], elsewhere);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /no config\.json next to the entry/);
    assert.match(run.stderr, /incomplete|config/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("the no-argument entry discovers the config next to itself, not the cwd", async () => {
  const dir = makeInstall("discover");
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-entrycli-cwd3-"));
  try {
    // A corrupt config beside the entry proves discovery found THAT file
    // (and only after that does the credential phase see the same
    // corruption), independent of the process working directory.
    writeFileSync(join(dir, "config.json"), "{ not json");
    const run = await runEntry(join(dir, "entry.mjs"), [], elsewhere);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /config file is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("credential failures exit with the dedicated code and never rewrite the file", async () => {
  const dir = makeInstall("credentials");
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-entrycli-cwd4-"));
  try {
    writeConfig(dir);
    const corrupt = "{ corrupt credentials";
    writeFileSync(join(dir, "credentials.json"), corrupt);
    const corruptRun = await runEntry(join(dir, "entry.mjs"), [], elsewhere);
    assert.equal(corruptRun.code, 4, `stderr: ${corruptRun.stderr}`);
    assert.match(corruptRun.stderr, /credentials: .*not valid JSON/);
    assert.equal(readFileSync(join(dir, "credentials.json"), "utf8"), corrupt);

    // Valid tokens with a loose (inherited) ACL fail the boundary check.
    const credentials = {
      entryToken: randomBytes(32).toString("base64"),
      bridgeToken: randomBytes(32).toString("base64"),
    };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials));
    const looseRun = await runEntry(join(dir, "entry.mjs"), [], elsewhere);
    assert.equal(looseRun.code, 4, `stderr: ${looseRun.stderr}`);
    assert.match(looseRun.stderr, /boundary|ACL/);
    assert.equal(readFileSync(join(dir, "credentials.json"), "utf8"), JSON.stringify(credentials));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("--config still works and requires an absolute Windows path", async () => {
  const dir = makeInstall("explicit");
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-entrycli-cwd5-"));
  try {
    const configPath = writeConfig(dir);
    const corrupt = "{ still corrupt";
    writeFileSync(join(dir, "credentials.json"), corrupt);
    const run = await runEntry(ENTRY_ARTIFACT, ["--config", configPath], elsewhere);
    assert.equal(run.code, 4, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /credentials: .*not valid JSON/);

    const relative = await runEntry(ENTRY_ARTIFACT, ["--config", "config.json"], elsewhere);
    assert.equal(relative.code, 2);
    assert.match(relative.stderr, /absolute Windows path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
