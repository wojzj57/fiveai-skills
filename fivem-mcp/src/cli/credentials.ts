/**
 * First-run credential initialization (unified-artifact RFC §5.1–§5.2).
 * Desktop entry only: this module performs the Windows named-pipe
 * initialization mutex, the PowerShell ACL/no-overwrite publish helper,
 * and the exclusive temp-file dance. It is deliberately absent from the
 * FiveM bundles and from the shared contract module.
 *
 * Lifecycle (RFC §5.1): the entry resolves the config first, reuses
 * existing credentials when they validate, and only when the file is
 * missing does it enter the mutex-guarded initialization. Corrupt,
 * unreadable, linked, or boundary-violating files fail explicitly —
 * regeneration never masks a problem.
 */

import { execFile } from "node:child_process";
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePipeMutex, getUserSid } from "../broker/pipes.ts";
import {
  canonicalPath,
  CredentialFileError,
  readCredentialFile,
  type Credentials,
} from "../shared/config.ts";

/** Competitors retry the initialization mutex at a short interval (RFC §5.2). */
const MUTEX_RETRY_MS = 200;
/** Total wait cap for one initialization attempt (RFC §5.2). */
const MUTEX_WAIT_MS = 10_000;
/** Per-invocation helper timeout; errors or timeouts stop initialization. */
const HELPER_TIMEOUT_MS = 15_000;

/** Absolute path of the shipped Windows helper script, next to the entry. */
export function credentialHelperPath(): string {
  return fileURLToPath(new URL("./windows-files.ps1", import.meta.url));
}

function windowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * Run the helper script. Absolute system PowerShell path, execFile argument
 * array (never a shell string), hidden window; tokens never appear in
 * process arguments — only literal file paths (RFC §5.2).
 */
function runCredentialHelper(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", credentialHelperPath(), ...args],
      { windowsHide: true, timeout: HELPER_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr ?? "").trim() || error.message;
          reject(new Error(`windows-files.ps1 ${args[1] ?? ""} failed: ${detail}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function expectHelperOk(args: string[]): Promise<void> {
  const verdict = await runCredentialHelper(args);
  if (verdict !== "OK") {
    throw new Error(`windows-files.ps1 ${args[1] ?? ""} returned an unexpected result: ${verdict}`);
  }
}

/**
 * Dedicated per-credential initialization mutex (RFC §5.2). The digest is
 * computed over the current user SID and the normalized credential path —
 * it never reuses the broker startup/lifetime pipes and does not change
 * the one-broker-per-user scope.
 */
export async function credentialInitPipeName(credentialFilePath: string): Promise<string> {
  const sid = await getUserSid();
  const normalized = canonicalPath(credentialFilePath).toLowerCase();
  const digest = createHash("sha256").update(`${sid}\0${normalized}`).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\fiveai-mcp-credinit-${digest}`;
}

/**
 * Acquire the initialization mutex, retrying at a short interval. A held
 * pipe is waited out up to the total cap; on timeout the caller reports
 * initialization-busy — the lock is never deleted and no other process
 * is terminated (RFC §5.2). The OS releases the pipe when the holder
 * exits, which is the crash-recovery path.
 */
async function acquireCredentialInitMutex(pipeName: string): Promise<net.Server> {
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    const server = await acquirePipeMutex(pipeName);
    if (server !== null) return server;
    if (Date.now() + MUTEX_RETRY_MS > deadline) {
      throw new Error(
        "credential initialization is busy: another process holds the initialization mutex for this credential file; stop it or retry",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MUTEX_RETRY_MS));
  }
}

/**
 * Read existing credentials and verify their access boundary (RFC §5).
 * Returns null only when the file is missing; unreadable or invalid files
 * and boundary violations throw. The ACL is verified, never silently
 * modified.
 */
async function readExistingCredentials(path: string): Promise<Credentials | null> {
  let credentials: Credentials;
  try {
    credentials = readCredentialFile(path);
  } catch (error) {
    if (error instanceof CredentialFileError && error.kind === "missing") return null;
    throw error;
  }
  await expectHelperOk(["-Mode", "Verify", "-Path", path]);
  return credentials;
}

/**
 * Create and publish the credential file under the held mutex (RFC §5.2):
 * exclusive temp file in the real credential directory, ACL lockdown
 * before any token byte is written, full JSON written and verified, then
 * the no-overwrite .NET File.Move publish. On failure only this run's
 * temporary file is removed; crash leftovers are never treated as
 * credentials and never force-cleaned.
 */
async function createCredentialFile(credentialFilePath: string): Promise<Credentials> {
  const directory = dirname(credentialFilePath);
  // Confirm real directory ownership: a junction must not redirect the
  // publish target (RFC §5.2.1).
  if (realpathSync(directory).toLowerCase() !== directory.toLowerCase()) {
    throw new Error(`credential directory is not the real path: ${directory}`);
  }

  const tempPath = join(directory, `.credentials-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  closeSync(openSync(tempPath, "wx"));
  try {
    const stat = lstatSync(tempPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`temporary credential file is not an exclusive regular file: ${tempPath}`);
    }
    // Remove inheritance and restrict access before writing any token
    // byte; the helper verifies the applied boundary (RFC §5.2.2).
    await expectHelperOk(["-Mode", "Acl", "-Path", tempPath]);

    const credentials: Credentials = {
      entryToken: randomBytes(32).toString("base64"),
      bridgeToken: randomBytes(32).toString("base64"),
    };
    const payload = `${JSON.stringify(credentials, null, 2)}\n`;
    const handle = openSync(tempPath, "r+");
    try {
      writeSync(handle, payload, 0, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    // Verify content and permissions before publishing (RFC §5.2.3).
    const reread = readCredentialFile(tempPath);
    if (reread.entryToken !== credentials.entryToken || reread.bridgeToken !== credentials.bridgeToken) {
      throw new Error(`temporary credential file changed while being written: ${tempPath}`);
    }
    await expectHelperOk(["-Mode", "Verify", "-Path", tempPath]);

    // No-overwrite publish (RFC §5.2.4). If the target appeared, validate
    // and reuse it — never overwrite.
    const verdict = await runCredentialHelper(["-Mode", "Move", "-Path", tempPath, "-Destination", credentialFilePath]);
    if (verdict === "EXISTS") {
      unlinkSync(tempPath);
      const target = await readExistingCredentials(credentialFilePath);
      if (target === null) {
        throw new Error(`credential publish raced but the target is missing: ${credentialFilePath}`);
      }
      return target;
    }
    if (verdict !== "OK") {
      throw new Error(`windows-files.ps1 Move returned an unexpected result: ${verdict}`);
    }
    return credentials;
  } catch (error) {
    // Normal failure removes only this run's temporary file (RFC §5.2.5).
    try {
      unlinkSync(tempPath);
    } catch {
      // Already moved or gone.
    }
    throw error;
  }
}

/**
 * Ensure valid credentials exist at the given as-configured path (links
 * fail the read instead of being followed). Only the desktop entry calls
 * this; the broker and FiveM only read (RFC §5.1).
 */
export async function ensureCredentials(credentialFilePath: string): Promise<Credentials> {
  const existing = await readExistingCredentials(credentialFilePath);
  if (existing !== null) return existing;

  const pipeName = await credentialInitPipeName(credentialFilePath);
  const mutex = await acquireCredentialInitMutex(pipeName);
  try {
    // The holder re-checks the final file: another initializer may have
    // published while this process waited (RFC §5.2).
    const rechecked = await readExistingCredentials(credentialFilePath);
    if (rechecked !== null) return rechecked;
    return await createCredentialFile(credentialFilePath);
  } finally {
    await new Promise<void>((resolve) => mutex.close(() => resolve()));
  }
}
