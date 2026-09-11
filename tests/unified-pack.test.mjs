/**
 * Unified artifact build/pack tests (unified-artifact RFC §3, §7, §9 build/
 * archive and standalone-unpack rows). All scenarios live in this single
 * file on purpose: they share the repository dist/ output and must run
 * sequentially. The unpack end-to-end test spawns a real broker through the
 * shipped entry and cleans it up via runtime.json — it must be the only
 * broker-spawning root test so the per-user named pipes stay uncontended.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { unzipSync } from "fflate";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDir = join(repoRoot, "dist");
const installDir = join(outputDir, "fiveai-mcp");
const zipPath = join(outputDir, "fiveai-mcp.zip");
const buildScript = join(repoRoot, "scripts", "build-unified.mjs");

const DELIVERY_NAMES = [
  "fiveai-mcp/fxmanifest.lua",
  "fiveai-mcp/README.md",
  "fiveai-mcp/shared/executor.lua",
  "fiveai-mcp/dist/server.js",
  "fiveai-mcp/dist/client.js",
  "fiveai-mcp/mcp/entry.mjs",
  "fiveai-mcp/mcp/broker.mjs",
  "fiveai-mcp/mcp/windows-files.ps1",
  "fiveai-mcp/mcp/config.json",
];

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", ...options });
}

function readZipEntries(path) {
  return unzipSync(new Uint8Array(readFileSync(path)));
}

function recursiveHas(root, name) {
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === name) return true;
    if (entry.isDirectory() && recursiveHas(join(root, entry.name), name)) return true;
  }
  return false;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

test("pnpm run pack produces the unified install directory and a single-root whitelist ZIP", () => {
  const pack = spawnSync("pnpm run pack", { shell: true, encoding: "utf8", cwd: repoRoot });
  assert.equal(pack.status, 0, `pack output: ${pack.stdout}\n${pack.stderr}`);
  assert.match(pack.stdout, /Unified artifact packed/);

  for (const name of DELIVERY_NAMES) {
    assert.equal(existsSync(join(installDir, name.slice("fiveai-mcp/".length))), true, `${name} published`);
  }

  const entries = readZipEntries(zipPath);
  assert.deepEqual(Object.keys(entries).sort(), [...DELIVERY_NAMES].sort());
  for (const name of Object.keys(entries)) {
    assert.match(name, /^fiveai-mcp\//, "every entry lives under the single fiveai-mcp root");
  }
  // The ZIP carries the repository default config, never local runtime data.
  const defaultConfig = readFileSync(join(repoRoot, "packages", "fivem-plugin", "mcp", "config.json"));
  assert.deepEqual(
    Buffer.from(entries["fiveai-mcp/mcp/config.json"]).equals(defaultConfig),
    true,
    "the ZIP carries the default config byte-for-byte",
  );

  // The manifest loads only the executor and the bundles; mcp/** is absent.
  const manifest = Buffer.from(entries["fiveai-mcp/fxmanifest.lua"]).toString("utf8");
  assert.equal(/mcp/i.test(manifest), false, "fxmanifest never references the mcp/ payload");
  assert.match(manifest, /server_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/server\.js'\s*\}/);
  assert.match(manifest, /client_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/client\.js'\s*\}/);
});

test("publish preserves local config, credentials, state, and user files byte-for-byte", () => {
  const sentinelConfig = JSON.stringify({ version: 1, broker: { host: "127.0.0.1", port: 43190 }, serverLabel: "local-sentinel" });
  const sentinelCredentials = '{"entryToken":"local-entry-token","bridgeToken":"local-bridge-token"}';
  const sentinelState = '{"pid":12345}';
  const userFile = "keep my notes";
  mkdirSync(join(installDir, "mcp", "state"), { recursive: true });
  writeFileSync(join(installDir, "mcp", "config.json"), sentinelConfig);
  writeFileSync(join(installDir, "mcp", "credentials.json"), sentinelCredentials);
  writeFileSync(join(installDir, "mcp", "state", "runtime.json"), sentinelState);
  writeFileSync(join(installDir, "notes.txt"), userFile);
  try {
    // A local publish never creates a ZIP.
    rmSync(zipPath, { force: true });
    const publish = runNode([buildScript, "publish"], { cwd: repoRoot });
    assert.equal(publish.status, 0, `publish stderr: ${publish.stderr}`);
    assert.match(publish.stdout, /Unified artifact published/);
    assert.equal(existsSync(zipPath), false, "publish does not generate a ZIP");
    assert.equal(readFileSync(join(installDir, "mcp", "config.json"), "utf8"), sentinelConfig);
    assert.equal(readFileSync(join(installDir, "mcp", "credentials.json"), "utf8"), sentinelCredentials);
    assert.equal(readFileSync(join(installDir, "mcp", "state", "runtime.json"), "utf8"), sentinelState);
    assert.equal(readFileSync(join(installDir, "notes.txt"), "utf8"), userFile);
    assert.equal(existsSync(join(installDir, "fxmanifest.lua")), true, "program files still updated");

    // pack zips the clean staging tree: the sentinel config never leaks in.
    const pack = runNode([buildScript, "pack"], { cwd: repoRoot });
    assert.equal(pack.status, 0, `pack stderr: ${pack.stderr}`);
    const entries = readZipEntries(zipPath);
    assert.equal("fiveai-mcp/mcp/credentials.json" in entries, false, "credentials never enter the ZIP");
    assert.equal("fiveai-mcp/mcp/state/runtime.json" in entries, false, "state never enters the ZIP");
    assert.equal("fiveai-mcp/notes.txt" in entries, false, "user files never enter the ZIP");
    assert.deepEqual(
      Buffer.from(entries["fiveai-mcp/mcp/config.json"]).equals(readFileSync(join(repoRoot, "packages", "fivem-plugin", "mcp", "config.json"))),
      true,
      "the ZIP keeps the default config even when the local one differs",
    );
  } finally {
    rmSync(join(installDir, "mcp", "credentials.json"), { force: true });
    rmSync(join(installDir, "mcp", "state"), { recursive: true, force: true });
    rmSync(join(installDir, "notes.txt"), { force: true });
    rmSync(join(installDir, "mcp", "config.json"), { force: true });
  }
});

test("a failed orchestration exits non-zero, prints no success, and leaves protected files untouched", () => {
  const serverBundle = join(repoRoot, "packages", "fivem-plugin", "dist", "server.js");
  const hidden = `${serverBundle}.hidden`;
  const sentinelConfig = JSON.stringify({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "keep-me" });
  const sentinelCredentials = '{"entryToken":"local-entry-token","bridgeToken":"local-bridge-token"}';
  writeFileSync(join(installDir, "mcp", "config.json"), sentinelConfig);
  writeFileSync(join(installDir, "mcp", "credentials.json"), sentinelCredentials);
  renameSync(serverBundle, hidden);
  try {
    const failed = runNode([buildScript, "publish"], { cwd: repoRoot });
    assert.notEqual(failed.status, 0, "a missing source must fail the build");
    assert.doesNotMatch(failed.stdout, /Unified artifact published|packed/);
    assert.match(failed.stderr, /build-unified/);
    assert.equal(readFileSync(join(installDir, "mcp", "config.json"), "utf8"), sentinelConfig, "config preserved");
    assert.equal(readFileSync(join(installDir, "mcp", "credentials.json"), "utf8"), sentinelCredentials, "credentials preserved");
  } finally {
    renameSync(hidden, serverBundle);
    const restore = runNode([buildScript, "publish"], { cwd: repoRoot });
    assert.equal(restore.status, 0, `restore publish failed: ${restore.stderr}`);
    rmSync(join(installDir, "mcp", "credentials.json"), { force: true });
    rmSync(join(installDir, "mcp", "config.json"), { force: true });
  }
});

test("the unpacked ZIP runs standalone from a path with spaces (initialize, tools/list, tools/call status)", async () => {
  const entries = readZipEntries(zipPath);
  const installRoot = join(mkdtempSync(join(tmpdir(), "fiveai unpack ")), "fiveai-mcp");
  mkdirSync(installRoot, { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) {
    const target = join(installRoot, name.slice("fiveai-mcp/".length));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
  assert.equal(recursiveHas(installRoot, "node_modules"), false, "no node_modules ship in the ZIP");
  assert.equal(existsSync(join(installRoot, "mcp", "credentials.json")), false, "no credentials ship in the ZIP");

  // A user-side adjustment: point the unpacked config at a free port so the
  // spawned broker cannot collide with anything already listening.
  const configPath = join(installRoot, "mcp", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.broker.port = await freePort();
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const cwd = mkdtempSync(join(tmpdir(), "fiveai random cwd-"));
  const entry = spawn(process.execPath, [join(installRoot, "mcp", "entry.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
  });
  const mcp = new McpClient(entry);
  try {
    await mcp.initialize();
    const tools = await mcp.request("tools/list", {});
    assert.deepEqual(
      tools.result?.tools?.map((tool) => tool.name),
      ["status"],
      "only the status tool is registered",
    );
    const status = await mcp.callStatus();
    assert.equal(status.isError, false, `status failed: ${JSON.stringify(status.structuredContent)}`);
    assert.equal(typeof status.structuredContent.brokerInstanceId, "string");

    // First run generated the credentials locally, boundary-locked.
    assert.equal(existsSync(join(installRoot, "mcp", "credentials.json")), true, "first run generated credentials");
    const state = join(installRoot, "mcp", "state", "runtime.json");
    assert.equal(existsSync(state), true, "the broker wrote its runtime record");
  } finally {
    entry.kill();
    await new Promise((resolve) => entry.once("exit", resolve));
    // The broker was spawned by this run's entry: stop it via its own record.
    const runtimePath = join(installRoot, "mcp", "state", "runtime.json");
    if (existsSync(runtimePath)) {
      const { pid } = JSON.parse(readFileSync(runtimePath, "utf8"));
      try {
        process.kill(pid);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch {
            break;
          }
        }
      } catch {
        // Already gone.
      }
    }
    const tempLeftovers = readdirSync(join(installRoot, "mcp")).filter((name) => name.startsWith(".credentials-"));
    assert.deepEqual(tempLeftovers, [], "no credential temp files leak after a clean run");
    rmSync(dirname(installRoot), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("root command wiring keeps the unified orchestration and no test/build recursion", async () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts.build, /scripts\/build-unified\.mjs publish/);
  assert.match(manifest.scripts.pack, /pnpm run build/);
  assert.match(manifest.scripts.pack, /scripts\/build-unified\.mjs pack/);
  assert.equal(manifest.scripts["build:resource"], "pnpm run build", "build:resource is the unified build compatibility entry");
  assert.match(manifest.scripts["test:mcp"], /^pnpm run build:resource/);
  // The unified build never runs tests, and tests only ever invoke builds.
  assert.doesNotMatch(manifest.scripts.build, /test/);
});

/** Minimal newline-delimited JSON-RPC client for the spawned entry. */
class McpClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim() === "") continue;
        try {
          const message = JSON.parse(line);
          if (typeof message.id === "number" && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
          }
        } catch {
          // stdout belongs to MCP; ignore non-JSON noise.
        }
      }
    });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fiveai-pack-test", version: "0" },
    });
    if (response.error !== undefined) {
      throw new Error(`initialize failed: ${JSON.stringify(response.error)}`);
    }
    this.notify("notifications/initialized");
  }

  async callStatus() {
    const response = await this.request("tools/call", { name: "status", arguments: {} });
    return {
      isError: response.result?.isError === true,
      structuredContent: response.result?.structuredContent ?? {},
    };
  }
}
