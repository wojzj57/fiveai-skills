import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RecoveryStore,
  RecoveryWriteError,
} from "../src/broker/recovery-store.ts";
import type { RecoveryFile } from "../src/protocol/recovery.ts";

function tempStateDir(): string {
  const dir = join(tmpdir(), `fiveai-recovery-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleFile(overrides: Partial<RecoveryFile> = {}): RecoveryFile {
  return {
    version: 1,
    brokerInstanceId: randomUUID(),
    pending: null,
    history: [],
    ...overrides,
  };
}

test("a missing record loads as a fresh empty file and round-trips atomically", () => {
  const dir = tempStateDir();
  try {
    const store = new RecoveryStore(dir);
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.created, true);
    assert.equal(loaded.file.pending, null);

    const next = sampleFile();
    store.save(next);
    const reloaded = store.load();
    assert.equal(reloaded.ok, true);
    if (!reloaded.ok) return;
    assert.equal(reloaded.created, false);
    assert.deepEqual(reloaded.file, next);
    assert.equal(readFileSync(join(dir, "recovery.json"), "utf8"), JSON.stringify(next));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an atomic replace swaps the previous record content", () => {
  const dir = tempStateDir();
  try {
    const store = new RecoveryStore(dir);
    const first = sampleFile();
    store.save(first);
    const second = sampleFile();
    store.save(second);
    assert.equal(readFileSync(join(dir, "recovery.json"), "utf8"), JSON.stringify(second));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt JSON record yields STATE_STORE_ERROR and is preserved on disk", () => {
  const dir = tempStateDir();
  try {
    const corrupt = "{ this is not json";
    writeFileSync(join(dir, "recovery.json"), corrupt);
    const store = new RecoveryStore(dir);
    const loaded = store.load();
    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.equal(loaded.code, "STATE_STORE_ERROR");
    assert.match(loaded.message, /not valid JSON/);
    // The store never clears a corrupt record (RFC §7.2).
    assert.equal(readFileSync(join(dir, "recovery.json"), "utf8"), corrupt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown-format record yields STATE_STORE_ERROR and is preserved", () => {
  const dir = tempStateDir();
  try {
    const unknown = JSON.stringify({ version: 99, brokerInstanceId: "123e4567-e89b-42d3-a456-426614174000" });
    writeFileSync(join(dir, "recovery.json"), unknown);
    const store = new RecoveryStore(dir);
    const loaded = store.load();
    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.equal(loaded.code, "STATE_STORE_ERROR");
    assert.equal(readFileSync(join(dir, "recovery.json"), "utf8"), unknown);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write failure surfaces RecoveryWriteError instead of proceeding silently", () => {
  const dir = tempStateDir();
  try {
    // stateDir points at a plain file: temp-file creation fails, so the
    // atomic save surfaces RecoveryWriteError (RFC §7.2: 写入失败保留阻塞).
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const store = new RecoveryStore(join(blocker, "nested"));
    assert.throws(
      () => store.save(sampleFile()),
      (error: unknown) => error instanceof RecoveryWriteError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable record (path is a directory) yields STATE_STORE_ERROR", () => {
  const dir = tempStateDir();
  try {
    mkdirSync(join(dir, "recovery.json"));
    const store = new RecoveryStore(dir);
    const loaded = store.load();
    assert.equal(loaded.ok, false);
    if (loaded.ok) return;
    assert.equal(loaded.code, "STATE_STORE_ERROR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
