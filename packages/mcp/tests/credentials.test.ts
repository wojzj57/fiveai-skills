/**
 * Credential initialization tests (unified-artifact RFC §5.1–§5.2, §9
 * credential process row). These run the real Windows helper script, the
 * real per-credential initialization named pipe, and the real filesystem,
 * so they exercise genuine process-boundary semantics (mutex contention,
 * OS pipe release on holder death, no-overwrite publish) without touching
 * the shared broker startup/lifetime pipes — the credinit pipe name is
 * derived per credential path, so this file stays parallel-safe.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { credentialHelperPath, credentialInitPipeName, ensureCredentials } from "../src/cli/credentials.ts";
import { readCredentialFile } from "../src/shared/config.ts";

const HELPER = credentialHelperPath();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHelper(args: string[]): Promise<HelperResult> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return new Promise((resolve) => {
    execFile(
      `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER, ...args],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

/** Temp directory whose name contains a space: unpack paths may contain spaces. */
function spaceDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix} with space-`));
}

function validCredentialJson(): { entryToken: string; bridgeToken: string } {
  return {
    entryToken: randomBytes(32).toString("base64"),
    bridgeToken: randomBytes(32).toString("base64"),
  };
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(".credentials-") && name.endsWith(".tmp"));
}

test("the helper applies and verifies the ACL boundary and rejects files without it", async () => {
  const dir = spaceDir("fiveai-helper");
  try {
    const file = join(dir, "credentials.json");
    writeFileSync(file, "{}");
    assert.deepEqual(await runHelper(["-Mode", "Acl", "-Path", file]), { code: 0, stdout: "OK", stderr: "" });
    assert.deepEqual(await runHelper(["-Mode", "Verify", "-Path", file]), { code: 0, stdout: "OK", stderr: "" });

    const plain = join(dir, "plain.json");
    writeFileSync(plain, "{}");
    const loose = await runHelper(["-Mode", "Verify", "-Path", plain]);
    assert.equal(loose.code, 1);
    assert.match(loose.stderr, /boundary/);
    // Verification never modified the loose file.
    assert.equal(readFileSync(plain, "utf8"), "{}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the helper publishes with File.Move semantics and never overwrites the destination", async () => {
  const dir = spaceDir("fiveai-move");
  try {
    const source = join(dir, "source.tmp");
    const destination = join(dir, "credentials.json");
    writeFileSync(source, "source-content");
    writeFileSync(destination, "destination-content");

    assert.equal((await runHelper(["-Mode", "Move", "-Path", source, "-Destination", destination])).stdout, "EXISTS");
    assert.equal(readFileSync(destination, "utf8"), "destination-content");
    assert.equal(readFileSync(source, "utf8"), "source-content");

    const fresh = join(dir, "fresh.json");
    assert.equal((await runHelper(["-Mode", "Move", "-Path", source, "-Destination", fresh])).stdout, "OK");
    assert.equal(readFileSync(fresh, "utf8"), "source-content");
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first run generates a boundary-locked credential file and reuses it byte-for-byte", async () => {
  const dir = spaceDir("fiveai-first");
  try {
    const path = join(dir, "credentials.json");
    const first = await ensureCredentials(path);
    assert.deepEqual(readCredentialFile(path), first);
    assert.deepEqual(await runHelper(["-Mode", "Verify", "-Path", path]), { code: 0, stdout: "OK", stderr: "" });
    assert.deepEqual(tempFiles(dir), []);

    const bytes = readFileSync(path);
    const second = await ensureCredentials(path);
    assert.deepEqual(second, first);
    assert.equal(readFileSync(path).equals(bytes), true, "reuse never rewrites the file");
    assert.deepEqual(tempFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent initializations converge on exactly one credential file", async () => {
  const dir = spaceDir("fiveai-concurrent");
  try {
    const path = join(dir, "credentials.json");
    const results = await Promise.all([
      ensureCredentials(path),
      ensureCredentials(path),
      ensureCredentials(path),
      ensureCredentials(path),
    ]);
    for (const result of results.slice(1)) {
      assert.deepEqual(result, results[0]);
    }
    assert.deepEqual(readCredentialFile(path), results[0]);
    assert.deepEqual(tempFiles(dir), [], "no temporary files survive a clean initialization");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name !== "credentials.json"),
      [],
      "only the credential file is created",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mutex holder re-check reuses a target that appears before acquisition", async () => {
  const dir = spaceDir("fiveai-recheck");
  const pipeName = await credentialInitPipeName(join(dir, "credentials.json"));
  const holder = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => holder.listen(pipeName, () => resolve()));
  try {
    const path = join(dir, "credentials.json");
    const pending = ensureCredentials(path);
    pending.catch(() => undefined); // Keep a late rejection observable below, never unhandled.
    await sleep(400); // The contender is now waiting on the mutex.
    const appeared = validCredentialJson();
    writeFileSync(path, JSON.stringify(appeared, null, 2));
    assert.equal((await runHelper(["-Mode", "Acl", "-Path", path])).stdout, "OK");
    const bytes = readFileSync(path);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    const result = await pending;
    assert.deepEqual(result, appeared, "the holder re-check reuses the appeared target");
    assert.equal(readFileSync(path).equals(bytes), true, "the appeared target is never overwritten");
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held initialization mutex times out as busy after ten seconds without side effects", async () => {
  const dir = spaceDir("fiveai-busy");
  const path = join(dir, "credentials.json");
  const pipeName = await credentialInitPipeName(path);
  const holder = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => holder.listen(pipeName, () => resolve()));
  try {
    const startedAt = Date.now();
    await assert.rejects(ensureCredentials(path), /busy/);
    assert.ok(Date.now() - startedAt >= 9_500, "the busy verdict only comes after the ten-second cap");
    assert.equal(existsSync(path), false, "no credential file was created");
    assert.deepEqual(tempFiles(dir), []);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crashed mutex holder is recovered through the OS pipe release", async () => {
  const dir = spaceDir("fiveai-crash");
  const path = join(dir, "credentials.json");
  const pipeName = await credentialInitPipeName(path);
  const holder = spawn(process.execPath, [
    "-e",
    "require('net').createServer(s=>s.end()).listen(process.argv[1]);setInterval(()=>{},10000);",
    pipeName,
  ]);
  try {
    const held = Date.now() + 5_000;
    for (;;) {
      const connected = await new Promise<boolean>((resolve) => {
        const socket = net.connect(pipeName, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
      });
      if (connected) break;
      assert.ok(Date.now() < held, "holder never listened on the credinit pipe");
      await sleep(100);
    }
    const pending = ensureCredentials(path);
    pending.catch(() => undefined); // Keep a late rejection observable below, never unhandled.
    await sleep(400); // The contender is now waiting on the dead process's mutex.
    holder.kill();
    const result = await pending;
    assert.deepEqual(readCredentialFile(path), result);
    assert.deepEqual(await runHelper(["-Mode", "Verify", "-Path", path]), { code: 0, stdout: "OK", stderr: "" });
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt and linked credential files fail explicitly without regeneration", async () => {
  const dir = spaceDir("fiveai-corrupt");
  try {
    const path = join(dir, "credentials.json");
    writeFileSync(path, "{ not json");
    await assert.rejects(ensureCredentials(path), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json", "corrupt files are never rewritten");

    const target = join(dir, "real-credentials.json");
    writeFileSync(target, JSON.stringify(validCredentialJson()));
    rmSync(path);
    symlinkSync(target, path);
    await assert.rejects(ensureCredentials(path), /owned regular file|without links/i);
    assert.equal(existsSync(path), true, "the link itself is not replaced");
    assert.deepEqual(tempFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing credentials with a loose ACL fail boundary verification until locked down", async () => {
  const dir = spaceDir("fiveai-boundary");
  try {
    const path = join(dir, "credentials.json");
    const credentials = validCredentialJson();
    writeFileSync(path, JSON.stringify(credentials));
    await assert.rejects(ensureCredentials(path), /boundary|ACL/);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(credentials), "the loose file is never silently modified");

    assert.equal((await runHelper(["-Mode", "Acl", "-Path", path])).stdout, "OK");
    assert.deepEqual(await ensureCredentials(path), credentials);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(credentials));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
