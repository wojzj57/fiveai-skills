import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const RESOURCE_EPOCH = "00000000-0000-4000-8000-000000000001";
const CLIENT_EPOCH = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000003";
const HASH = "a".repeat(64);
let buildRoot;
let ClientProtocol;
let encodeClientValues;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "fiveai-client-runtime-"));
  const outfile = join(buildRoot, "client.mjs");
  await build({
    entryPoints: [new URL("../http-mcp/src/client/index.ts", import.meta.url).pathname.slice(1)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: "inline",
  });
  await build({
    entryPoints: [new URL("../http-mcp/src/client/main.ts", import.meta.url).pathname.slice(1)],
    outfile: join(buildRoot, "client-entry.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
  });
  ({ ClientProtocol, encodeClientValues } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`));
});

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

function fakeClock() {
  let now = 0;
  return { now: () => now, advance: (ms) => (now += ms) };
}

function binding(overrides = {}) {
  return {
    resourceEpoch: RESOURCE_EPOCH,
    clientId: 7,
    connectionId: CONNECTION_ID,
    clientEpoch: CLIENT_EPOCH,
    ...overrides,
  };
}

function bindFrame(value = binding()) {
  return JSON.stringify({ v: 1, type: "bind", binding: value, payload: { logMarker: "b".repeat(32) } });
}

function executeFrame(sequence, overrides = {}) {
  return JSON.stringify({
    v: 1,
    type: "execute",
    binding: binding(),
    taskId: `${RESOURCE_EPOCH}:${sequence}`,
    payload: {
      kind: "js",
      code: "return args.value",
      args: { value: sequence },
      timeoutMs: 1000,
      planHash: HASH,
      ...overrides,
    },
  });
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function makeProtocol(executeJs = async (_code, args) => [args.value]) {
  const clock = fakeClock();
  const network = [];
  const local = [];
  const protocol = new ClientProtocol({
    resourceName: "renamed-resource",
    clientEpoch: CLIENT_EPOCH,
    send: (eventName, raw) => network.push({ eventName, message: JSON.parse(raw) }),
    sendLocal: (eventName, raw) => local.push({ eventName, message: JSON.parse(raw) }),
    executeJs,
    clock: clock.now,
  });
  return { protocol, clock, network, local };
}

test("client hello, bind, Lua readiness, and heartbeat use the actual resource namespace", () => {
  const { protocol, clock, network, local } = makeProtocol();
  protocol.start();
  assert.equal(network[0].eventName, "renamed-resource:mcp:v1:hello");
  assert.deepEqual(network[0].message.payload, { clientEpoch: CLIENT_EPOCH, lua: true, js: true });

  assert.equal(protocol.receive(12, "bind", bindFrame()), false);
  assert.equal(protocol.receive(65535, "bind", bindFrame()), true);
  assert.equal(local[0].eventName, "renamed-resource:mcp:v1:local:clientBind");
  protocol.luaReady(JSON.stringify({ binding: binding() }));
  clock.advance(5_000);
  protocol.tick();
  assert.equal(network.at(-1).eventName, "renamed-resource:mcp:v1:heartbeat");
  assert.deepEqual(network.at(-1).message.payload, { lua: true, js: true });
});

test("a bound client keeps announcing the same epoch so a restarted server can bind it", () => {
  const { protocol, clock, network } = makeProtocol();
  protocol.start();
  protocol.receive(65535, "bind", bindFrame());
  network.length = 0;
  clock.advance(2_000);
  protocol.tick();
  assert.equal(network[0].eventName, "renamed-resource:mcp:v1:hello");
  assert.equal(network[0].message.payload.clientEpoch, CLIENT_EPOCH);
});

test("JS execution saves before reporting, deduplicates, resends, acknowledges, and probes without replay", async () => {
  let executions = 0;
  const { protocol, clock, network } = makeProtocol(async (_code, args) => {
    executions += 1;
    return [args.value, undefined];
  });
  protocol.start();
  protocol.receive(65535, "bind", bindFrame());
  network.length = 0;

  assert.equal(protocol.receive(65535, "execute", executeFrame(1)), true);
  await flush();
  assert.equal(executions, 1);
  assert.equal(network[0].eventName, "renamed-resource:mcp:v1:terminal");
  assert.deepEqual(network[0].message.payload.result.values, [1, { $mcp: "undefined" }]);

  protocol.receive(65535, "execute", executeFrame(1));
  await flush();
  assert.equal(executions, 1);
  assert.equal(network.filter((item) => item.message.type === "terminal").length, 2);
  clock.advance(2_000);
  protocol.tick();
  assert.equal(network.filter((item) => item.message.type === "terminal").length, 3);

  const ack = JSON.stringify({ v: 1, type: "terminalAck", binding: binding(), taskId: `${RESOURCE_EPOCH}:1`, payload: {} });
  protocol.receive(65535, "terminalAck", ack);
  clock.advance(2_000);
  protocol.tick();
  assert.equal(network.filter((item) => item.message.type === "terminal").length, 3);

  const probe = JSON.stringify({ v: 1, type: "probe", binding: binding(), taskId: `${RESOURCE_EPOCH}:1`, payload: {} });
  protocol.receive(65535, "probe", probe);
  assert.equal(executions, 1);
  assert.deepEqual(network.at(-1).message.payload, {
    known: true,
    terminal: { execution: "ended", result: { kind: "values", values: [1, { $mcp: "undefined" }] } },
  });
});

test("client rejects InternalMessage fields outside the normative schema", async () => {
  let executions = 0;
  const { protocol, network } = makeProtocol(async () => {
    executions += 1;
    return ["bad"];
  });
  protocol.start();
  protocol.receive(65535, "bind", bindFrame());
  const frame = JSON.parse(executeFrame(1));
  frame.payload.approved = true;
  assert.equal(protocol.receive(65535, "execute", JSON.stringify(frame)), false);
  await flush();
  assert.equal(executions, 0);
  assert.equal(network.some((item) => item.message.type === "terminal"), false);
});

test("high-water dedupe survives cache eviction and conflicting hashes never execute", async () => {
  let executions = 0;
  const { protocol, clock, network } = makeProtocol(async () => {
    executions += 1;
    return ["ok"];
  });
  protocol.start();
  protocol.receive(65535, "bind", bindFrame());
  protocol.receive(65535, "execute", executeFrame(10));
  await flush();
  protocol.receive(
    65535,
    "terminalAck",
    JSON.stringify({ v: 1, type: "terminalAck", binding: binding(), taskId: `${RESOURCE_EPOCH}:10`, payload: {} }),
  );
  clock.advance(300_001);
  protocol.tick();
  network.length = 0;

  protocol.receive(65535, "execute", executeFrame(9));
  await flush();
  assert.equal(executions, 1);
  assert.equal(network.at(-1).message.payload.execution, "not_dispatched");
  assert.equal(network.at(-1).message.payload.error.code, "EXECUTION_FAILED");

  protocol.receive(65535, "execute", executeFrame(10, { planHash: "c".repeat(64) }));
  await flush();
  assert.equal(executions, 1);
  assert.equal(network.at(-1).message.payload.execution, "not_dispatched");
});

test("32 unacknowledged terminals are retained and the next execute gets a bounded refusal", async () => {
  const { protocol, network } = makeProtocol(async (_code, args) => [args.value]);
  protocol.start();
  protocol.receive(65535, "bind", bindFrame());
  for (let sequence = 1; sequence <= 32; sequence += 1) {
    protocol.receive(65535, "execute", executeFrame(sequence));
    await flush();
  }
  assert.equal(protocol.cacheSnapshot().unacked, 32);
  protocol.receive(65535, "execute", executeFrame(33));
  await flush();
  assert.equal(protocol.cacheSnapshot().unacked, 32);
  assert.equal(protocol.cacheSnapshot().rejectionTaskId, `${RESOURCE_EPOCH}:33`);
  assert.equal(network.at(-1).message.payload.error.code, "EXECUTOR_FULL");

  protocol.receive(65535, "execute", executeFrame(34));
  await flush();
  assert.equal(protocol.cacheSnapshot().highWater, "33");
});

test("browser wire encoder handles bytes and rejects getters without Node Buffer", () => {
  assert.deepEqual(encodeClientValues([new Uint8Array([0, 255]), { $mcp: "nil" }]), {
    kind: "values",
    values: [
      { $mcp: "bytes", base64: "AP8=" },
      { $mcp: "object", entries: [["$mcp", "nil"]] },
    ],
  });
  let accessed = false;
  assert.throws(() => encodeClientValues([{ get secret() { accessed = true; return 1; } }]), /RESULT_UNSUPPORTED/);
  assert.equal(accessed, false);
});


test('client reserves terminal bytes before entering code and keeps repeated same-binding completion',async()=>{
 let executions=0;
 const {protocol,network}=makeProtocol(async()=>{executions++;return ['x'.repeat(262000)];});
 protocol.start();protocol.receive(65535,'bind',bindFrame());
 let rejected=false;
 for(let sequence=1;sequence<=33;sequence++){
  const before=executions;protocol.receive(65535,'execute',executeFrame(sequence));
  protocol.receive(65535,'bind',bindFrame());await flush();
  const terminal=network.filter(x=>x.message.type==='terminal').at(-1).message;
  if(terminal.payload.error?.code==='EXECUTOR_FULL'){
   assert.equal(terminal.payload.execution,'not_dispatched');assert.equal(executions,before);rejected=true;break;
  }
  assert.equal(terminal.payload.execution,'ended');
 }
 assert.equal(rejected,true);
});
