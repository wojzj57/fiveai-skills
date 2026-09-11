import WebSocket from "ws";
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createExecutor, utf8Bytes } from "../shared/execution.js";
import { validOutcome } from "../shared/outcome.js";

const resource = GetCurrentResourceName();
const event = name => `${resource}:${name}`;
const bridgeEpoch = randomUUID();
const clients = new Map();
const incoming = [];
const execute = createExecutor({ resource, on, emit }, randomUUID);
let socket = null;
let identity = null;
let stopped = false;
let retryAt = 0;
let attempts = 0;
let lastSeen = 0;
let verificationBusy = false;
let clientInvocation = null;
let identityReady = process.platform !== "win32";
const observationTimers = new Set();
const environment = {
  bridgeEpoch, serverPid: process.pid,
  serverStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  serverIdentityVerifiable: false,
};

// An unavailable OS identity remains explicitly unverifiable. Never use the
// resource epoch as evidence of an FXServer process restart.
if (process.platform === "win32") {
  const shell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  execFile(shell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToString('o')`],
    { windowsHide: true, timeout: 3000, maxBuffer: 4096 }, (error, stdout) => {
      incoming.push({ kind: "identity", startedAt: !error && Number.isFinite(Date.parse(stdout.trim())) ? new Date(stdout.trim()).toISOString() : null });
    });
}

// Private server convars only. Never replicate these or include them in files.
const url = GetConvar("fiveai_mcp_broker_url", "ws://127.0.0.1:43189/internal/v1/bridge");
const token = GetConvar("fiveai_mcp_bridge_token", "");
const enabled = /^ws:\/\/127\.0\.0\.1:\d+\/internal\/v1\/bridge$/.test(url) && /^[A-Za-z0-9+/]+={0,2}$/.test(token) && Buffer.from(token, "base64").length >= 32;
if (!enabled) console.log("[fivem-plugin] bridge disconnected: configure private broker URL and bridge token");

function send(type, payload) {
  if (socket?.readyState !== WebSocket.OPEN || !identity) return;
  if (socket.bufferedAmount > 1024 * 1024) { socket.close(4007, "backpressure"); return; }
  socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, ...identity, payload }));
}

function snapshot() {
  send("clients.snapshot", { bridgeEpoch, clients: [...clients.values()].filter(c => c.ready).map(c => ({
    serverId: c.serverId, clientEpoch: c.clientEpoch, logMarker: c.logMarker,
    capabilities: ["lua", "javascript", "host-verification"],
  })) });
}

function connect() {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 1048576, perMessageDeflate: false });
  socket = ws; lastSeen = Date.now();
  // These callbacks perform no natives, exports or cross-runtime emits.
  ws.on("open", () => {
    if (incoming.length < 128) incoming.push({ kind: "open", ws }); else ws.terminate();
  });
  ws.on("message", data => {
    if (incoming.length >= 128) { ws.close(4007, "inbound queue full"); return; }
    incoming.push({ kind: "frame", ws, text: String(data) });
  });
  ws.on("close", () => {
    if (socket !== ws) return;
    socket = null; identity = null;
    retryAt = Date.now() + ([1000, 2000, 4000, 8000][attempts++] ?? 10000) + Math.floor(Math.random() * 500);
  });
  ws.on("error", () => {}); // close schedules reconnect; token never enters logs.
}

setTick(() => {
  if (stopped) return;
  for (let n = 0; n < 32 && incoming.length; n++) {
    const item = incoming.shift();
    if (item.kind === "identity") {
      if (item.startedAt) { environment.serverStartedAt = item.startedAt; environment.serverIdentityVerifiable = true; }
      identityReady = true;
      continue;
    }
    if (item.kind === "host-work") {
      try { item.resolve(item.work()); } catch (error) { item.reject(error); }
      continue;
    }
    if (item.ws !== socket || socket.readyState !== WebSocket.OPEN) continue;
    if (item.kind === "open") {
      socket.send(JSON.stringify({ v: 1, id: randomUUID(), type: "hello", payload: {
        role: "bridge", internalProtocol: 1, buildId: "fiveai-mcp/0.1.0", adapterDigest: "host-probe/no-adapters", environment,
      } }));
      continue;
    }
    try {
      const message = JSON.parse(item.text);
      if (message.v !== 1 || typeof message.id !== "string") throw new Error("protocol");
      if (!identity) {
        if (message.type !== "welcome" || typeof message.sessionId !== "string" || typeof message.brokerInstanceId !== "string" ||
            message.sessionId !== message.payload?.sessionId || message.brokerInstanceId !== message.payload?.brokerInstanceId) throw new Error("welcome");
        identity = { sessionId: message.sessionId, brokerInstanceId: message.brokerInstanceId };
        attempts = 0; lastSeen = Date.now(); snapshot();
      } else {
        if (message.sessionId !== identity.sessionId || message.brokerInstanceId !== identity.brokerInstanceId) throw new Error("identity");
        if (message.type !== "ping" || typeof message.payload?.nonce !== "string") throw new Error("unsupported message");
        lastSeen = Date.now(); send("pong", { nonce: message.payload.nonce });
      }
    } catch { socket.close(4007, "protocol mismatch"); }
  }
  if (socket && Date.now() - lastSeen > 15000) socket.terminate();
  if (enabled && identityReady && !socket && Date.now() >= retryAt) connect();
});

function onHostTick(work) {
  return new Promise((resolve, reject) => {
    if (incoming.length >= 128) { reject(new Error("host queue full")); return; }
    incoming.push({ kind: "host-work", work, resolve, reject });
  });
}

onNet(event("server:register"), nonce => {
  const serverId = Number(source); // Capture before any asynchronous work.
  if (!Number.isSafeInteger(serverId) || serverId <= 0 || !GetPlayerName(String(serverId)) || typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) return;
  let client = clients.get(serverId);
  if (client?.nonce === nonce) {
    if (Date.now() - client.lastSent < 1000) return;
  } else {
    if (client && Date.now() - client.lastSent < 1000) return;
    client = { serverId, nonce, clientEpoch: randomUUID(), challenge: randomBytes(32).toString("hex"), logMarker: randomUUID(), ready: false, lastSent: 0 };
    clients.set(serverId, client);
  }
  client.lastSent = Date.now();
  emitNet(event("client:bind"), serverId, { serverId, nonce, clientEpoch: client.clientEpoch, challenge: client.challenge, logMarker: client.logMarker });
});

onNet(event("server:ready"), (epoch, challenge) => {
  const client = clients.get(Number(source));
  if (!client || client.clientEpoch !== epoch || client.challenge !== challenge || client.ready) return;
  client.ready = true; snapshot();
});

on("playerDropped", () => { clients.delete(Number(source)); snapshot(); });

onNet(event("server:result"), (epoch, challenge, id, text) => {
  const client = clients.get(Number(source));
  const pending = clientInvocation;
  if (!client || !pending || pending.client !== client || client.clientEpoch !== epoch || client.challenge !== challenge || pending.id !== id || typeof text !== "string" || utf8Bytes(text) > 270336) return;
  try {
    const outcome = JSON.parse(text);
    if (!validOutcome(outcome)) return;
    clientInvocation = null;
    emitNet(event("client:ack"), client.serverId, epoch, challenge, id);
    pending.resolve(outcome);
  } catch { /* Invalid result does not establish completion. */ }
});

const fixtures = [
  { name: "lua-await-multiple-nil", language: "lua", code: "Citizen.Wait(50); return args.value, nil, 7, nil", args: { value: "fiveai" } },
  { name: "lua-vector", language: "lua", code: "return vector3(1, 2, 3)", args: {} },
  { name: "lua-error", language: "lua", code: "error('fiveai expected error')", args: {} },
  { name: "javascript-await", language: "javascript", code: "async (args) => { await new Promise(resolve => setTimeout(resolve, 50)); return [args.value, undefined, 42n, GetCurrentResourceName()]; }", args: { value: "fiveai" } },
  { name: "javascript-error", language: "javascript", code: "async () => { throw new Error('fiveai expected error'); }", args: {} },
];

// Fixed probes, console only, opt-in. No network event accepts server code and
// no arbitrary execute tool is exposed before the desktop scheduler exists.
RegisterCommand("fiveai_mcp_verify", (sender, args) => {
  if (Number(sender) !== 0 || GetConvar("fiveai_mcp_verify_enabled", "0") !== "1") return;
  if (verificationBusy) { console.log("[fivem-plugin] verification still running or unresolved"); return; }
  const target = args[0] ?? "server";
  const client = target === "server" ? null : clients.get(Number(target));
  if (target !== "server" && !client?.ready) { console.log("[fivem-plugin] client is not bound"); return; }
  verificationBusy = true;
  void (async () => {
    for (const fixture of fixtures) {
      const task = { ...fixture, id: randomUUID() };
      const started = Date.now();
      const report = value => console.log(`FIVEAI_MCP_VERIFY ${JSON.stringify({ fixture: fixture.name, target, bridgeEpoch, clientEpoch: client?.clientEpoch, elapsedMs: Date.now() - started, ...value })}`);
      const timeout = setTimeout(() => report({ state: "unknown", sideEffectsUnknown: true, retrySafe: false }), 10000);
      observationTimers.add(timeout);
      let outcome;
      try {
        outcome = await onHostTick(() => client ? new Promise(resolve => {
          if (clients.get(client.serverId) !== client) { resolve({ state: "failed", error: { code: "TARGET_SESSION_CHANGED", message: "client session changed before dispatch" }, evidence: { executionCompleted: false, noRemoteExecution: true } }); return; }
          clientInvocation = { client, id: task.id, resolve };
          emitNet(event("client:execute"), client.serverId, client.clientEpoch, client.challenge, task);
        }) : execute(task));
      } finally { clearTimeout(timeout); observationTimers.delete(timeout); }
      report({ outcome }); // Observation, not an automatic claim of host acceptance.
    }
    verificationBusy = false;
  })().catch(() => { console.log("[fivem-plugin] verification unresolved; inspect host logs"); });
}, true);

on("onResourceStop", name => {
  if (name !== resource) return;
  stopped = true; incoming.length = 0;
  for (const timer of observationTimers) clearTimeout(timer);
  socket?.terminate();
});
