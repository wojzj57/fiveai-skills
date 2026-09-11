/**
 * Windows named pipes for broker startup and lifetime (RFC §4.2).
 *
 * - startup pipe: a short-term mutex held by the entry that spawns the
 *   broker, so concurrent entries cannot spawn competing brokers;
 * - lifetime pipe: held by the broker for its whole life; its read-only
 *   discovery response carries port, protocol, and config digest.
 *
 * Both names derive from the Windows user SID digest — never from the
 * mutable username or the config — so one OS user gets exactly one global
 * scheduler regardless of config, port, or stateDir (RFC §4.1/§4.2).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { z } from "zod";
import { DiscoveryInfoSchema, type DiscoveryInfo } from "../protocol/runtime.ts";

export type { DiscoveryInfo };

export interface BrokerPipeNames {
  startup: string;
  lifetime: string;
}

let cachedSid: string | null = null;

/**
 * Absolute path to the Windows whoami binary. Resolving explicitly avoids
 * PATH shadowing (e.g. an MSYS whoami from a Git Bash environment, which
 * does not understand /user /fo csv /nh).
 */
function windowsWhoamiPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return `${systemRoot}\\System32\\whoami.exe`;
}

/** The current Windows user SID via whoami (stable machine identity). */
export function getUserSid(): Promise<string> {
  if (cachedSid !== null) return Promise.resolve(cachedSid);
  return new Promise((resolve, reject) => {
    execFile(
      windowsWhoamiPath(),
      ["/user", "/fo", "csv", "/nh"],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`cannot determine the Windows user SID: ${error.message}`));
          return;
        }
        const sid = stdout
          .split("\n")
          .map((line) => line.split(",").map((field) => field.replace(/^"|"$/g, "")))
          .flat()
          .find((field) => field.startsWith("S-1-5-"));
        if (sid === undefined) {
          reject(new Error(`whoami did not report a user SID: ${JSON.stringify(stdout)}`));
          return;
        }
        cachedSid = sid;
        resolve(sid);
      },
    );
  });
}

export async function brokerPipeNames(): Promise<BrokerPipeNames> {
  const sid = await getUserSid();
  const digest = createHash("sha256").update(sid).digest("hex").slice(0, 16);
  return {
    startup: `\\\\.\\pipe\\fiveai-mcp-startup-${digest}`,
    lifetime: `\\\\.\\pipe\\fiveai-mcp-lifetime-${digest}`,
  };
}

/**
 * Try to become the startup-mutex holder. Resolves with the server to keep
 * (and later close), or null when another entry already holds the pipe.
 */
export function acquireStartupPipe(pipePath: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      // The startup pipe carries no protocol (RFC §4.2); connections exist
      // only so the OS keeps the pipe instance alive.
      socket.end();
    });
    server.once("error", () => resolve(null));
    server.listen(pipePath, () => resolve(server));
  });
}

/** Serve the read-only lifetime discovery response (broker side). */
export function serveLifetimeDiscovery(
  pipePath: string,
  info: DiscoveryInfo,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end(`${JSON.stringify(info)}\n`);
    });
    server.once("error", (error) => reject(error));
    server.listen(pipePath, () => resolve(server));
  });
}

export type LifetimeProbe =
  | { status: "absent" }
  | { status: "info"; info: DiscoveryInfo }
  | { status: "occupied" };

/**
 * Probe the lifetime pipe (entry side). "occupied" means something holds
 * the pipe but cannot prove it is a valid same-identity service — the
 * caller exits with INSTANCE_CONFLICT rather than fighting for it.
 */
export function probeLifetimePipe(
  pipePath: string,
  timeoutMs = 2_000,
): Promise<LifetimeProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: LifetimeProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "occupied" }), timeoutMs);
    const socket = net.connect(pipePath, () => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          const parsed = DiscoveryInfoSchema.safeParse(JSON.parse(buffer.slice(0, newline)));
          if (parsed.success) {
            finish({ status: "info", info: parsed.data });
          } else {
            finish({ status: "occupied" });
          }
        } catch {
          finish({ status: "occupied" });
        }
      });
      socket.on("error", () => finish({ status: "occupied" }));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EPIPE" || error.code === "ETIMEDOUT") {
        finish({ status: "absent" });
        return;
      }
      finish({ status: "occupied" });
    });
  });
}

/** Wait until the lifetime pipe answers with valid discovery info. */
export async function waitForLifetimeDiscovery(
  pipePath: string,
  timeoutMs: number,
  attemptIntervalMs = 200,
): Promise<DiscoveryInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeLifetimePipe(pipePath);
    if (probe.status === "info") return probe.info;
    if (Date.now() + attemptIntervalMs >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, attemptIntervalMs));
  }
}
