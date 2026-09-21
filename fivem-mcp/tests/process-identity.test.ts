import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyProcessIdentity } from "../src/broker/process-identity.ts";

test("local identity rejects missing and reused PIDs and verifies OS creation time", async () => {
  const environment = { bridgeEpoch: "test-epoch", serverPid: 2147483647, serverStartedAt: "2000-01-01T00:00:00.000Z", serverIdentityVerifiable: true };
  assert.equal((await verifyProcessIdentity(environment)).verified, false);
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`], { windowsHide: true });
  const actual = { ...environment, serverPid: process.pid, serverStartedAt: new Date(stdout.trim()).toISOString() };
  assert.equal((await verifyProcessIdentity(actual)).verified, true);
  assert.equal((await verifyProcessIdentity({ ...actual, serverStartedAt: environment.serverStartedAt })).verified, false);
  assert.equal((await verifyProcessIdentity({ ...actual, serverIdentityVerifiable: false })).verified, true, "OS observation is independent of bridge assertion");
});
