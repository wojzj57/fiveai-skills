/**
 * Fake FiveM bridge for process-level tests (RFC §16.1 step 1: 用假桥接做
 * 进程级测试). Connects to /internal/v1/bridge with the bridge token,
 * performs the hello/welcome handshake with a synthetic environment
 * identity, answers heartbeats, and reports lifecycle events as JSON lines
 * on stdout:
 *   {"event":"ready","brokerInstanceId":...,"sessionId":...,"bridgeEpoch":...}
 *   {"event":"close","code":...,"reason":...}
 *
 * Flags: --url <ws-url> --token <bridgeToken> [--no-pong] [--epoch <id>]
 *        [--build-id <id>] [--clients-json <JSON array>]
 *
 * --clients-json sends one clients.snapshot right after the welcome, bound
 * to this connection's envelope identity and bridgeEpoch. Test-only
 * surface; it is not a public tool or config option.
 */

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { BUILD_ID } from "../../../src/build.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

const url = argument("--url");
const token = argument("--token");
if (url === undefined || token === undefined) {
  process.stderr.write("usage: node fake-bridge.ts --url <ws-url> --token <bridgeToken> [--no-pong]\n");
  process.exit(2);
}
const noPong = process.argv.includes("--no-pong");
const bridgeEpoch = argument("--epoch") ?? `fake-${randomUUID().slice(0, 13)}`;
const buildId = argument("--build-id") ?? BUILD_ID;

const ws = new WebSocket(url, {
  headers: { Authorization: `Bearer ${token}` },
  maxPayload: 1024 * 1024,
});
let brokerInstanceId: string | null = null;
let sessionId: string | null = null;

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      v: 1,
      id: randomUUID(),
      type: "hello",
      payload: {
        role: "bridge",
        internalProtocol: 1,
        buildId,
        adapterDigest: "fake-bridge-test",
        environment: {
          bridgeEpoch,
          serverPid: process.pid,
          serverStartedAt: new Date().toISOString(),
          serverIdentityVerifiable: true,
        },
      },
    }),
  );
});

ws.on("message", (data: unknown) => {
  let message: { type?: string; payload?: { nonce?: string } };
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  if (message.type === "welcome") {
    const payload = message.payload as { brokerInstanceId: string; sessionId: string };
    brokerInstanceId = payload.brokerInstanceId;
    sessionId = payload.sessionId;
    const clientsJson = argument("--clients-json");
    if (clientsJson !== undefined) {
      ws.send(JSON.stringify({
        v: 1, id: randomUUID(), brokerInstanceId, sessionId,
        type: "clients.snapshot",
        payload: { bridgeEpoch, clients: JSON.parse(clientsJson) },
      }));
    }
    console.log(JSON.stringify({ event: "ready", brokerInstanceId, sessionId, bridgeEpoch }));
    return;
  }
  if (message.type === "ping" && !noPong) {
    ws.send(
      JSON.stringify({
        v: 1,
        id: randomUUID(),
        ...(brokerInstanceId === null ? {} : { brokerInstanceId }),
        ...(sessionId === null ? {} : { sessionId }),
        type: "pong",
        payload: { nonce: message.payload?.nonce },
      }),
    );
  }
});

ws.on("close", (code: number, reason: Buffer) => {
  console.log(JSON.stringify({ event: "close", code, reason: reason.toString("utf8") }));
  process.exit(0);
});

ws.on("error", (error: Error) => {
  console.log(JSON.stringify({ event: "error", message: error.message }));
  process.exit(1);
});

// Keep the process alive until the connection closes.
setInterval(() => {}, 60_000);
