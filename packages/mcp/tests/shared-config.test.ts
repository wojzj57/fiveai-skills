import assert from "node:assert/strict";
import test from "node:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  computeConfigDigest,
  CredentialFileError,
  McpConfigSchema,
  readCredentialFile,
  resolveConfigPaths,
  validateCredentialFile,
} from "../src/shared/config.ts";
import { loadRuntimeConfig } from "../src/cli/config.ts";

function writeCredentials(path: string): { entryToken: string; bridgeToken: string } {
  const credentials = {
    entryToken: randomBytes(32).toString("base64"),
    bridgeToken: randomBytes(32).toString("base64"),
  };
  writeFileSync(path, JSON.stringify(credentials));
  return credentials;
}

test("a default unified configuration resolves data paths against the config directory", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-unified-")));
  try {
    const configPath = join(dir, "config.json");
    const credentials = writeCredentials(join(dir, "credentials.json"));
    writeFileSync(configPath, JSON.stringify({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "unified" }));
    const loaded = loadRuntimeConfig(configPath);
    assert.equal(loaded.configPath, configPath);
    assert.equal(loaded.config.stateDir, join(dir, "state"));
    assert.equal(loaded.config.credentialFile, join(dir, "credentials.json"));
    assert.equal(loaded.config.clientLogDir, null);
    assert.equal(loaded.config.verifyEnabled, false);
    assert.equal(loaded.entryToken, credentials.entryToken);
    assert.equal(loaded.bridgeToken, credentials.bridgeToken);

    // Spelling the defaults out explicitly must digest identically.
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      broker: { host: "127.0.0.1", port: 43189 },
      stateDir: "./state",
      credentialFile: "./credentials.json",
      clientLogDir: null,
      serverLabel: "unified",
      verifyEnabled: false,
    }));
    assert.equal(loadRuntimeConfig(configPath).configDigest, loaded.configDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit relative data paths resolve under the config directory", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-relative-")));
  try {
    mkdirSync(join(dir, "secrets"));
    const configPath = join(dir, "config.json");
    writeCredentials(join(dir, "secrets", "token.json"));
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      broker: { host: "127.0.0.1" },
      stateDir: "data/state",
      credentialFile: "./secrets/token.json",
      clientLogDir: "logs",
      serverLabel: "relative",
    }));
    const loaded = loadRuntimeConfig(configPath);
    assert.equal(loaded.config.stateDir, join(dir, "data", "state"));
    assert.equal(loaded.config.credentialFile, join(dir, "secrets", "token.json"));
    assert.equal(loaded.config.clientLogDir, join(dir, "logs"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the process working directory never influences relative resolution", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-cwd-")));
  const elsewhere = mkdtempSync(join(tmpdir(), "fiveai-cwdelse-"));
  try {
    const configPath = join(dir, "config.json");
    writeCredentials(join(dir, "credentials.json"));
    writeFileSync(configPath, JSON.stringify({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "cwd" }));
    const before = process.cwd();
    process.chdir(elsewhere);
    try {
      const loaded = loadRuntimeConfig(configPath);
      assert.equal(loaded.config.credentialFile, join(dir, "credentials.json"));
      assert.equal(loaded.config.stateDir, join(dir, "state"));
    } finally {
      process.chdir(before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("moving the installation directory preserves relative semantics", () => {
  const dirA = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-move-")));
  const dirB = join(dirname(dirA), basename(dirA) + "-moved");
  try {
    const configPath = join(dirA, "config.json");
    const credentials = writeCredentials(join(dirA, "credentials.json"));
    writeFileSync(configPath, JSON.stringify({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "moved" }));
    const inPlace = loadRuntimeConfig(configPath);
    renameSync(dirA, dirB);
    const moved = loadRuntimeConfig(join(dirB, "config.json"));
    assert.equal(moved.config.stateDir, join(realpathSync(dirB), "state"));
    assert.equal(moved.config.credentialFile, join(realpathSync(dirB), "credentials.json"));
    assert.equal(moved.entryToken, inPlace.entryToken);
    // The digest is computed over real-path-resolved values, so it follows
    // the installation location (unified-artifact RFC §4).
    assert.notEqual(moved.configDigest, inPlace.configDigest);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("verifyEnabled and clientLogDir participate in the config digest", () => {
  const base = {
    version: 1 as const,
    broker: { host: "127.0.0.1" },
    stateDir: "C:\\a\\state",
    credentialFile: "C:\\a\\credentials.json",
    serverLabel: "digest",
  };
  const off = computeConfigDigest(McpConfigSchema.parse(base));
  const on = computeConfigDigest(McpConfigSchema.parse({ ...base, verifyEnabled: true }));
  const logs = computeConfigDigest(McpConfigSchema.parse({ ...base, clientLogDir: "C:\\a\\logs" }));
  assert.notEqual(off, on);
  assert.notEqual(off, logs);
  assert.notEqual(on, logs);
});

test("credential files are validated strictly and linked files fail explicitly", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-credentials-")));
  try {
    const good = join(dir, "credentials.json");
    const credentials = writeCredentials(good);
    assert.deepEqual(readCredentialFile(good), credentials);

    writeFileSync(join(dir, "empty.json"), "");
    assert.throws(() => readCredentialFile(join(dir, "empty.json")), /not valid JSON/);

    writeFileSync(join(dir, "missing-field.json"), JSON.stringify({ entryToken: credentials.entryToken }));
    assert.throws(() => readCredentialFile(join(dir, "missing-field.json")), /schema validation/);

    writeFileSync(join(dir, "extra-field.json"), JSON.stringify({ ...credentials, extra: true }));
    assert.throws(() => readCredentialFile(join(dir, "extra-field.json")), /schema validation/);

    const short = randomBytes(16).toString("base64");
    writeFileSync(join(dir, "short.json"), JSON.stringify({ entryToken: short, bridgeToken: short }));
    assert.throws(() => readCredentialFile(join(dir, "short.json")), /at least 32 random bytes/);

    writeFileSync(join(dir, "garbage.json"), JSON.stringify({ entryToken: "!!!not-base64!!!", bridgeToken: "also not base64" }));
    assert.throws(() => readCredentialFile(join(dir, "garbage.json")), /at least 32 random bytes/);

    // Linked credential files fail the ownership check instead of being
    // read through (unified-artifact RFC §5.1).
    symlinkSync(good, join(dir, "linked.json"), "file");
    assert.throws(() => readCredentialFile(join(dir, "linked.json")), /owned regular file|without links/i);
    linkSync(good, join(dir, "hardlinked.json"));
    assert.throws(() => readCredentialFile(join(dir, "hardlinked.json")), /owned regular file|without links/i);

    // A directory is not a credential file.
    mkdirSync(join(dir, "adirectory"));
    assert.throws(() => readCredentialFile(join(dir, "adirectory")), /owned regular file|without links/i);

    // The loader rejects linked credential files the same way.
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      version: 1,
      broker: { host: "127.0.0.1" },
      credentialFile: "./linked.json",
      serverLabel: "links",
    }));
    assert.throws(() => loadRuntimeConfig(join(dir, "config.json")), /owned regular file|without links/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential read failures carry a discriminating kind (unified-artifact RFC §5.2)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fiveai-credkind-")));
  try {
    // Missing is the only kind that may lead to first-run generation.
    assert.throws(
      () => readCredentialFile(join(dir, "absent.json")),
      (error: unknown) => error instanceof CredentialFileError && error.kind === "missing",
    );

    // Corrupt content is invalid, never regenerated.
    const corruptPath = join(dir, "corrupt.json");
    writeFileSync(corruptPath, "{ not json");
    assert.throws(
      () => readCredentialFile(corruptPath),
      (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid" && /not valid JSON/.test(error.message),
    );

    // Form violations (non-regular, linked) are invalid at the pure
    // validation layer async consumers share.
    assert.throws(
      () => validateCredentialFile(join(dir, "subdir"), { isRegularFile: false, isSymbolicLink: false, linkCount: 1 }, "{}"),
      (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid",
    );
    assert.throws(
      () => validateCredentialFile(join(dir, "x.json"), { isRegularFile: true, isSymbolicLink: true, linkCount: 1 }, "{}"),
      (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid",
    );
    assert.throws(
      () => validateCredentialFile(join(dir, "x.json"), { isRegularFile: true, isSymbolicLink: false, linkCount: 2 }, "{}"),
      (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid",
    );

    // Async consumers run the same validation over already-read bytes.
    const good = join(dir, "good.json");
    const credentials = writeCredentials(good);
    assert.deepEqual(
      validateCredentialFile(good, { isRegularFile: true, isSymbolicLink: false, linkCount: 1 }, readFileSync(good, "utf8")),
      credentials,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential tokens require canonical standard Base64", () => {
  const good = Buffer.alloc(32, 255).toString("base64");
  const facts = { isRegularFile: true, isSymbolicLink: false, linkCount: 1 };
  const invalid = [
    "A".repeat(43) + "!", good + "!", " " + good,
    good.replaceAll("/", "_"), good.slice(0, -1),
    Buffer.alloc(31).toString("base64"),
  ];
  for (const token of invalid) {
    assert.throws(() => validateCredentialFile("fixture.json", facts,
      JSON.stringify({ entryToken: token, bridgeToken: good })),
    (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid");
  }
  assert.equal(validateCredentialFile("fixture.json", facts,
    JSON.stringify({ entryToken: good, bridgeToken: good })).entryToken, good);
});

test("bridgeToken rejects noncanonical encodings and longer standard tokens pass", () => {
  const good = Buffer.alloc(32, 255).toString("base64");
  const facts = { isRegularFile: true, isSymbolicLink: false, linkCount: 1 };
  const invalid = [
    "A".repeat(43) + "!", good + "!", " " + good,
    good.replaceAll("/", "_"), good.slice(0, -1),
    Buffer.alloc(31).toString("base64"),
  ];
  for (const token of invalid) {
    assert.throws(() => validateCredentialFile("fixture.json", facts,
      JSON.stringify({ entryToken: good, bridgeToken: token })),
    (error: unknown) => error instanceof CredentialFileError && error.kind === "invalid");
  }
  // 33-byte (44 chars, unpadded tail group) and 64-byte (88 chars, "=="
  // padding) tokens are canonical standard Base64 well above the minimum.
  for (const bytes of [33, 64]) {
    const token = Buffer.alloc(bytes, 255).toString("base64");
    assert.equal(validateCredentialFile("fixture.json", facts,
      JSON.stringify({ entryToken: token, bridgeToken: token })).bridgeToken, token);
  }
});

test("resolveConfigPaths joins relatives, passes absolutes through, and requires an absolute base", () => {
  const config = McpConfigSchema.parse({ version: 1, broker: { host: "127.0.0.1" }, serverLabel: "resolve" });
  const resolved = resolveConfigPaths(config, "D:\\install\\fiveai-mcp\\mcp");
  assert.equal(resolved.stateDir, "D:\\install\\fiveai-mcp\\mcp\\state");
  assert.equal(resolved.credentialFile, "D:\\install\\fiveai-mcp\\mcp\\credentials.json");
  assert.equal(resolved.clientLogDir, null);
  const absolute = resolveConfigPaths(
    { ...config, stateDir: "E:\\elsewhere", clientLogDir: "E:\\logs" },
    "D:\\install\\fiveai-mcp\\mcp",
  );
  assert.equal(absolute.stateDir, "E:\\elsewhere");
  assert.equal(absolute.clientLogDir, "E:\\logs");
  assert.throws(() => resolveConfigPaths(config, "relative\\dir"), /absolute Windows path/);
});
