import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { BridgeEnvironment } from "../protocol/messages.ts";

const run = promisify(execFile);
export type ProcessIdentityCheck = { verified: boolean; reason: string; observedStartedAt?: string };

/** Consult the local OS; bridge assertions never establish process identity. */
export async function verifyProcessIdentity(environment: BridgeEnvironment): Promise<ProcessIdentityCheck> {
  if (process.platform !== "win32") return { verified: false, reason: "unsupported platform" };
  if (!Number.isSafeInteger(environment.serverPid) || environment.serverPid <= 0 || environment.serverPid > 2147483647) {
    return { verified: false, reason: "invalid process id" };
  }
  try {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${environment.serverPid}).StartTime.ToUniversalTime().ToString('o')`,
    ], { windowsHide: true, timeout: 3000, maxBuffer: 4096 });
    const observed = Date.parse(stdout.trim());
    if (!Number.isFinite(observed)) return { verified: false, reason: "OS returned no creation time" };
    const verified = observed === Date.parse(environment.serverStartedAt);
    return { verified, reason: verified ? "local process creation time matched" : "process creation time mismatch", observedStartedAt: new Date(observed).toISOString() };
  } catch {
    return { verified: false, reason: "process missing or creation time inaccessible" };
  }
}
