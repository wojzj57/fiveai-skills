/**
 * Unified artifact build/pack tests (unified-artifact RFC §3, §7, §9 build/
 * archive and standalone-unpack rows). Every scenario runs inside one
 * throwaway fixture workspace (tests/helpers/unified-fixture.mjs), so these
 * tests never write to this repository's own dist/ or package outputs — the
 * enclosing workspace's installed files stay untouched. All scenarios share
 * the fixture and must run sequentially. The unpack end-to-end test spawns a
 * real broker through the shipped entry and cleans it up via runtime.json —
 * together with the preservation test's nested run it makes this a
 * broker-spawning test file, so the root test command runs files with
 * --test-concurrency=1 and the per-user named pipes stay uncontended.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { unzipSync } from "fflate";
import { createUnifiedFixture } from "./helpers/unified-fixture.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// Every writable path below belongs to the fixture workspace this file
// creates; only the command-wiring assertions at the end read the enclosing
// repository's manifest, and only read-only.
const fixture = createUnifiedFixture(repoRoot);
after(() => fixture.dispose());
const workspaceRoot = fixture.root;
const installDir = fixture.installDir;
const zipPath = fixture.zipPath;
const buildScript = join(workspaceRoot, "fivem-mcp", "scripts", "build-unified.mjs");
const defaultConfigPath = join(workspaceRoot, "fivem-mcp", "config", "config.example.json");

const DELIVERY_NAMES = [
  "fivem-mcp/fxmanifest.lua",
  "fivem-mcp/README.md",
  "fivem-mcp/shared/executor.lua",
  "fivem-mcp/dist/server.js",
  "fivem-mcp/dist/client.js",
  "fivem-mcp/mcp/entry.mjs",
  "fivem-mcp/mcp/broker.mjs",
  "fivem-mcp/mcp/windows-files.ps1",
  "fivem-mcp/mcp/config.json",
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

/** Every file below root as sorted [relativeName, base64] pairs. */
function snapshotTree(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push([relative(root, path).split("\\").join("/"), readFileSync(path).toString("base64")]);
    }
  };
  walk(root);
  return files.sort();
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

test("pnpm run build produces only the package artifacts and never publishes", () => {
  const build = spawnSync("pnpm run build", { shell: true, encoding: "utf8", cwd: workspaceRoot });
  assert.equal(build.status, 0, `build output: ${build.stdout}\n${build.stderr}`);
  assert.doesNotMatch(build.stdout, /Unified artifact published|packed/);
  assert.equal(existsSync(installDir), false, "build must not publish the candidate directory");
  assert.equal(existsSync(zipPath), false, "build must not produce the ZIP");
  assert.doesNotMatch(build.stdout, /build-unified/, "build never runs the unified orchestration");
});

test("pnpm run pack produces the unified install directory and a single-root whitelist ZIP", () => {
  const pack = spawnSync("pnpm run pack", { shell: true, encoding: "utf8", cwd: workspaceRoot });
  assert.equal(pack.status, 0, `pack output: ${pack.stdout}\n${pack.stderr}`);
  assert.match(pack.stdout, /Unified artifact packed/);
  assert.equal(existsSync(join(workspaceRoot, "dist", ".staging-fivem-mcp")), false, "pack removes staging");

  for (const name of DELIVERY_NAMES) {
    assert.equal(existsSync(join(installDir, name.slice("fivem-mcp/".length))), true, `${name} published`);
  }

  const entries = readZipEntries(zipPath);
  assert.deepEqual(Object.keys(entries).sort(), [...DELIVERY_NAMES].sort());
  for (const name of Object.keys(entries)) {
    assert.match(name, /^fivem-mcp\//, "every entry lives under the single fivem-mcp root");
  }
  // The ZIP carries the workspace default config, never local runtime data.
  const defaultConfig = readFileSync(defaultConfigPath);
  assert.deepEqual(
    Buffer.from(entries["fivem-mcp/mcp/config.json"]).equals(defaultConfig),
    true,
    "the ZIP carries the default config byte-for-byte",
  );

  // The manifest loads only the executor and the bundles; mcp/** is absent.
  const manifest = Buffer.from(entries["fivem-mcp/fxmanifest.lua"]).toString("utf8");
  assert.equal(/mcp/i.test(manifest), false, "fxmanifest never references the mcp/ payload");
  assert.match(manifest, /server_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/server\.js'\s*\}/);
  assert.match(manifest, /client_scripts\s*\{\s*'shared\/executor\.lua',\s*'dist\/client\.js'\s*\}/);
});

test("publish and pack refuse a candidate output that holds user data", () => {
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
    // A used or deployed output is refused instead of updated in place.
    const publish = runNode([buildScript, "publish"], { cwd: workspaceRoot });
    assert.notEqual(publish.status, 0, "a used candidate output must be refused");
    assert.doesNotMatch(publish.stdout, /Unified artifact published|packed/);
    assert.match(publish.stderr, /choose a new candidate output path/);
    assert.equal(existsSync(join(workspaceRoot, "dist", ".staging-fivem-mcp")), false, "a refusal leaves no staging");

    // Refusing must not touch a single byte of the user's own files.
    assert.equal(readFileSync(join(installDir, "mcp", "config.json"), "utf8"), sentinelConfig);
    assert.equal(readFileSync(join(installDir, "mcp", "credentials.json"), "utf8"), sentinelCredentials);
    assert.equal(readFileSync(join(installDir, "mcp", "state", "runtime.json"), "utf8"), sentinelState);
    assert.equal(readFileSync(join(installDir, "notes.txt"), "utf8"), userFile);

    // pack owns the candidate directory too, so it refuses for the same reason.
    const pack = runNode([buildScript, "pack"], { cwd: workspaceRoot });
    assert.notEqual(pack.status, 0, "pack must refuse a used candidate output");
    assert.doesNotMatch(pack.stdout, /Unified artifact packed/);
  } finally {
    rmSync(join(installDir, "mcp", "credentials.json"), { force: true });
    rmSync(join(installDir, "mcp", "state"), { recursive: true, force: true });
    rmSync(join(installDir, "notes.txt"), { force: true });
    rmSync(join(installDir, "mcp", "config.json"), { force: true });
  }
});

test("a failed orchestration exits non-zero, prints no success, and leaves the candidate output untouched", () => {
  const serverBundle = join(workspaceRoot, "fivem-mcp", "dist", "server.js");
  const hidden = `${serverBundle}.hidden`;
  const before = snapshotTree(installDir);
  renameSync(serverBundle, hidden);
  try {
    const failed = runNode([buildScript, "publish"], { cwd: workspaceRoot });
    assert.notEqual(failed.status, 0, "a missing source must fail the build");
    assert.doesNotMatch(failed.stdout, /Unified artifact published|packed/);
    assert.match(failed.stderr, /build-unified/);
    assert.equal(existsSync(join(workspaceRoot, "dist", ".staging-fivem-mcp")), false, "failed staging is removed");
    assert.deepEqual(snapshotTree(installDir), before, "a failed publish leaves the candidate output untouched");
  } finally {
    renameSync(hidden, serverBundle);
    const restore = runNode([buildScript, "publish"], { cwd: workspaceRoot });
    assert.equal(restore.status, 0, `restore publish failed: ${restore.stderr}`);
  }
});

test("the unpacked ZIP runs standalone from a path with spaces (initialize, tools/list, tools/call status)", async () => {
  const entries = readZipEntries(zipPath);
  const installRoot = join(mkdtempSync(join(tmpdir(), "fiveai unpack ")), "fivem-mcp");
  mkdirSync(installRoot, { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) {
    const target = join(installRoot, name.slice("fivem-mcp/".length));
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
      ["status", "queue", "execute_lua", "execute_ts", "resource", "logs", "esx", "qbcore", "ox", "reference"],
      "the shipped entry exposes the complete ten-tool catalog",
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

test("root command wiring delegates to the single package and keeps no test/build recursion", async () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(repoRoot, "fivem-mcp", "package.json"), "utf8"));
  // build only writes the package's own dist/ artifacts; it never publishes.
  assert.equal(manifest.scripts.build, "pnpm --filter fivem-mcp run build");
  assert.doesNotMatch(manifest.scripts.build, /build-unified/);
  assert.equal(pkg.scripts["build:unified"], undefined, "no standalone publish command is wired into build");
  // pack owns the candidate directory and the ZIP.
  assert.equal(manifest.scripts.pack, "pnpm --filter fivem-mcp run pack");
  assert.match(pkg.scripts.pack, /scripts\/build-unified\.mjs pack/);
  assert.equal(manifest.scripts["build:resource"], "pnpm --filter fivem-mcp run pack", "build:resource yields the deployable resource");
  assert.equal(manifest.scripts["test:mcp"], "pnpm --filter fivem-mcp run test:fixture");
  assert.equal(existsSync(join(repoRoot, "fivem-mcp", "tests", "run-mcp-suite-fixture.mjs")), true, "the MCP suite runner is present");
  // The unified build never runs tests; MCP tests build only inside their fixture.
  assert.doesNotMatch(manifest.scripts.build, /test/);
  assert.doesNotMatch(pkg.scripts.pack, /test/);
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
