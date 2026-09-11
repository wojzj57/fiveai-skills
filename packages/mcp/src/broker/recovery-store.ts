/**
 * recovery.json storage (RFC §7.2). Writes are atomic: temp file in the
 * same directory, flush, then same-directory rename. A failed replace
 * leaves the previous record intact and surfaces an error — the broker
 * treats any write failure as a blocked state and never deletes the old
 * record to "recover". A corrupt or unknown-format record yields
 * STATE_STORE_ERROR and is likewise never cleared by the store itself.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertStatePaths } from "../cli/paths.ts";
import {
  RecoveryFileSchema,
  type RecoveryFile,
} from "../protocol/recovery.ts";

export type RecoveryLoad =
  | { ok: true; file: RecoveryFile; created: boolean }
  | { ok: false; code: "STATE_STORE_ERROR"; message: string };

/** Thrown when an atomic replace fails; the in-memory state stays valid. */
export class RecoveryWriteError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RecoveryWriteError";
    this.cause = cause;
  }
}

export class RecoveryStore {
  readonly filePath: string;
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.filePath = join(stateDir, "recovery.json");
  }

  /**
   * Load the persisted record. A missing file yields a fresh empty record
   * (created=true — the caller may persist it). A corrupt or
   * schema-invalid file yields STATE_STORE_ERROR and is preserved on disk.
   */
  load(): RecoveryLoad {
    let text: string;
    try {
      assertStatePaths(this.stateDir);
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ok: true,
          created: true,
          file: {
            version: 1,
            brokerInstanceId: randomUUID(),
            pending: null,
            history: [],
          },
        };
      }
      return {
        ok: false,
        code: "STATE_STORE_ERROR",
        message: `cannot read recovery.json: ${(error as Error).message}`,
      };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        code: "STATE_STORE_ERROR",
        message: `recovery.json is not valid JSON: ${(error as Error).message}`,
      };
    }
    const parsed = RecoveryFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        ok: false,
        code: "STATE_STORE_ERROR",
        message: `recovery.json failed schema validation: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      };
    }
    return { ok: true, created: false, file: parsed.data };
  }

  /**
   * Atomically persist the record: temp file, flush, same-directory rename.
   * Throws RecoveryWriteError on failure; the file on disk then either
   * still holds the previous record or nothing was replaced.
   */
  save(file: RecoveryFile): void {
    const tmpPath = join(this.stateDir, `recovery.json.tmp-${randomUUID()}`);
    let handle: number | undefined;
    try {
      assertStatePaths(this.stateDir);
      mkdirSync(this.stateDir, { recursive: true });
      assertStatePaths(this.stateDir);
      handle = openSync(tmpPath, "wx");
      const bytes = Buffer.from(JSON.stringify(file), "utf8");
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(handle, bytes, offset);
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          // Best effort; the temp file cleanup below is what matters.
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        // Leave a stray temp file rather than fail the cleanup path.
      }
      throw new RecoveryWriteError(
        `cannot atomically persist recovery.json: ${(error as Error).message}`,
        error,
      );
    }
  }
}
