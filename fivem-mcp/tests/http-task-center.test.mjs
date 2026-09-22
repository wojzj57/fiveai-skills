import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = new URL("../", import.meta.url);
let buildRoot;
let TaskCenter;

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "fiveai-task-center-"));
  const outfile = join(buildRoot, "task-center.mjs");
  await build({
    entryPoints: [new URL("../http-mcp/src/tasks/index.ts", import.meta.url).pathname.slice(1)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
  });
  ({ TaskCenter } = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`));
});

after(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  const base = Date.parse("2026-09-22T00:00:00.000Z");
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  return {
    monotonic: () => now,
    wall: () => new Date(base + now).toISOString(),
    setTimer(callback, delayMs) {
      const id = nextTimer++;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    jump(ms) {
      now += ms;
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue;
          timer.callback();
        }
        await flush();
      }
      await flush();
    },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function serverTarget(epoch = "00000000-0000-4000-8000-000000000001") {
  return { binding: { resourceEpoch: epoch, side: "server" } };
}

function clientTarget(connectionId = "00000000-0000-4000-8000-000000000010") {
  return {
    binding: {
      resourceEpoch: "00000000-0000-4000-8000-000000000001",
      side: "client",
      clientId: 7,
      connectionId,
      clientEpoch: "00000000-0000-4000-8000-000000000020",
    },
  };
}

function values(...values) {
  return { kind: "values", values };
}

function submit(center, overrides = {}) {
  return center.submit({
    sessionId: "session-a",
    tool: "execute_ts",
    target: serverTarget(),
    payload: { code: "return 1", args: {} },
    ...overrides,
  });
}

function assertAccepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.task;
}

function makeCenter(overrides = {}) {
  const clock = overrides.clock ?? fakeClock();
  const dispatched = [];
  const center = new TaskCenter({
    resourceEpoch: "00000000-0000-4000-8000-000000000001",
    clock,
    yieldControl: async () => {},
    prepare: async ({ payload }) => ({ ok: true, value: payload }),
    dispatch: async (context) => {
      assert.equal(context.dispatchCommitted(), true);
      dispatched.push(context.taskId);
    },
    ...overrides,
    clock,
  });
  return { center, clock, dispatched };
}

test("one global slot dispatches independent sessions in accepted FIFO order", async () => {
  const { center, dispatched } = makeCenter();
  const first = assertAccepted(submit(center, { sessionId: "one" }));
  const second = assertAccepted(submit(center, { sessionId: "two" }));
  const third = assertAccepted(submit(center, { sessionId: "one" }));
  await flush();

  assert.deepEqual(dispatched, [first.taskId]);
  assert.deepEqual(center.overview().queued.map((task) => task.taskId), [second.taskId, third.taskId]);
  assert.equal(center.settle(first.taskId, { identity: first.target.binding, execution: "ended", result: values(1) }).accepted, true);
  await flush();
  assert.deepEqual(dispatched, [first.taskId, second.taskId]);
  assert.equal(center.settle(second.taskId, { identity: second.target.binding, execution: "ended", result: values(2) }).accepted, true);
  await flush();
  assert.deepEqual(dispatched, [first.taskId, second.taskId, third.taskId]);
  assert.equal(center.get(first.taskId).state, "succeeded");
});

test("queued capacity is 32 per session and 128 globally without implicit eviction", async () => {
  const { center } = makeCenter();
  assertAccepted(submit(center, { sessionId: "active" }));
  await flush();

  for (let session = 0; session < 4; session += 1) {
    for (let index = 0; index < 32; index += 1) {
      assertAccepted(submit(center, { sessionId: `queued-${session}` }));
    }
  }
  const globalRefusal = submit(center, { sessionId: "overflow" });
  assert.equal(globalRefusal.ok, false);
  assert.equal(globalRefusal.error.code, "QUEUE_FULL");
  assert.equal(center.overview().queued.length, 128);

  const isolated = makeCenter().center;
  assertAccepted(submit(isolated, { sessionId: "active" }));
  await flush();
  for (let index = 0; index < 32; index += 1) assertAccepted(submit(isolated, { sessionId: "same" }));
  const perSessionRefusal = submit(isolated, { sessionId: "same" });
  assert.equal(perSessionRefusal.ok, false);
  assert.equal(perSessionRefusal.error.code, "QUEUE_FULL");
  assert.equal(isolated.overview().queued.length, 32);
});

test("queued work expires while an unknown task pauses dispatch", async () => {
  const { center, clock, dispatched } = makeCenter();
  const blocking = assertAccepted(submit(center));
  await flush();
  assert.equal(center.settle(blocking.taskId, {
    identity: blocking.target.binding,
    execution: "unknown",
    error: {
      code: "EXECUTION_UNKNOWN",
      message: "execution deadline elapsed",
      phase: "dispatched",
      retryable: false,
      execution: "unknown",
    },
  }).accepted, true);
  const waiting = assertAccepted(submit(center, { sessionId: "waiting" }));
  await clock.advance(600_001);

  assert.equal(center.get(waiting.taskId).state, "failed");
  assert.equal(center.get(waiting.taskId).error.code, "QUEUE_EXPIRED");
  assert.equal(center.overview().paused, true);
  assert.equal(center.overview().blockingTaskId, blocking.taskId);
  assert.deepEqual(dispatched, [blocking.taskId]);
});

test("cancel before preparation completes wins and does not overlap the next preparation", async () => {
  const preparation = deferred();
  const prepared = [];
  const dispatched = [];
  const { center } = makeCenter({
    prepare: async ({ taskId }) => {
      prepared.push(taskId);
      if (prepared.length === 1) await preparation.promise;
      return { ok: true, value: taskId };
    },
    dispatch: async (context) => {
      assert.equal(context.dispatchCommitted(), true);
      dispatched.push(context.taskId);
    },
  });
  const first = assertAccepted(submit(center));
  const second = assertAccepted(submit(center, { sessionId: "two" }));
  await flush();
  assert.deepEqual(prepared, [first.taskId]);
  assert.equal(center.cancel(first.taskId).ok, true);
  assert.equal(center.get(first.taskId).state, "cancelled");
  assert.deepEqual(prepared, [first.taskId], "the second preparation waits for the cancelled hook to unwind");

  preparation.resolve();
  await flush();
  assert.deepEqual(prepared, [first.taskId, second.taskId]);
  assert.deepEqual(dispatched, [second.taskId]);
});

test("yield and dispatchCommitted form the cancellation linearization boundary", async () => {
  const yielded = deferred();
  let dispatchContext;
  const { center } = makeCenter({
    yieldControl: () => yielded.promise,
    dispatch: async (context) => {
      dispatchContext = context;
    },
  });
  const beforeCommit = assertAccepted(submit(center));
  await flush();
  assert.equal(center.get(beforeCommit.taskId).phase, "waiting_host");
  assert.equal(center.cancel(beforeCommit.taskId).ok, true);
  yielded.resolve();
  await flush();
  assert.equal(dispatchContext, undefined, "cancelled work never reaches host dispatch");

  const committed = [];
  const secondCenter = makeCenter({
    dispatch: async (context) => {
      committed.push(context);
      assert.equal(context.dispatchCommitted(), true);
    },
  }).center;
  const afterCommit = assertAccepted(submit(secondCenter));
  await flush();
  assert.equal(secondCenter.get(afterCommit.taskId).phase, "dispatched");
  const refused = secondCenter.cancel(afterCommit.taskId);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "TASK_NOT_CANCELLABLE");
  assert.equal(secondCenter.dispatchCommitted(afterCommit.taskId), false, "commit is idempotent but cannot commit twice");
});

test("commit validation can prove a changed target was never dispatched", async () => {
  const { center, dispatched } = makeCenter({
    validateCommit: () => ({
      code: "TARGET_CHANGED",
      message: "target generation changed",
      phase: "waiting_host",
      retryable: true,
      execution: "not_dispatched",
    }),
  });
  const task = assertAccepted(submit(center, { target: clientTarget() }));
  await flush();
  assert.deepEqual(dispatched, []);
  assert.equal(center.get(task.taskId).state, "failed");
  assert.equal(center.get(task.taskId).error.code, "TARGET_CHANGED");
  assert.equal(center.get(task.taskId).execution, "not_dispatched");
});

test("execution timeout starts at commit, pauses the queue, and a matching late terminal resumes it", async () => {
  const { center, clock, dispatched } = makeCenter();
  const task = assertAccepted(submit(center, { timeoutMs: 100 }));
  const next = assertAccepted(submit(center, { sessionId: "next" }));
  await flush();
  await clock.advance(99);
  assert.equal(center.get(task.taskId).state, "running");
  await clock.advance(1);
  assert.equal(center.get(task.taskId).state, "unknown");
  assert.equal(center.overview().paused, true);

  const wrongIdentity = center.settle(task.taskId, {
    identity: clientTarget().binding,
    execution: "ended",
    result: values("wrong"),
  });
  assert.equal(wrongIdentity.accepted, false);
  assert.equal(center.get(task.taskId).state, "unknown");
  const late = center.settle(task.taskId, {
    identity: task.target.binding,
    execution: "ended",
    result: values("late"),
  });
  assert.equal(late.accepted, true);
  const conflict = center.settle(task.taskId, {
    identity: task.target.binding,
    execution: "ended",
    error: {
      code: "EXECUTION_FAILED",
      message: "conflicting duplicate",
      phase: "dispatched",
      retryable: false,
      execution: "ended",
    },
  });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, "conflict");
  assert.deepEqual(center.get(task.taskId).result, values("late"));
  await flush();
  assert.deepEqual(dispatched, [task.taskId, next.taskId]);
});

test("recover only probes the same task and never replays execution", async () => {
  let probes = 0;
  const { center, clock, dispatched } = makeCenter({
    recover: async ({ task }) => {
      probes += 1;
      if (probes === 1) return null;
      return { identity: task.target.binding, execution: "ended", result: values(42) };
    },
  });
  const task = assertAccepted(submit(center, { timeoutMs: 100 }));
  await flush();
  await clock.advance(100);
  const unproven = await center.recover(task.taskId);
  assert.equal(unproven.ok, false);
  assert.equal(unproven.error.code, "RECOVERY_UNPROVEN");
  assert.deepEqual(dispatched, [task.taskId]);

  const recovered = await center.recover(task.taskId);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.task.state, "succeeded");
  assert.equal(probes, 2);
  assert.deepEqual(dispatched, [task.taskId], "recover must never resend dispatch");
  const idempotent = await center.recover(task.taskId);
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.task.state, "succeeded");
  assert.equal(probes, 2, "a retained terminal does not need another probe");
});

test("sessionClosed cancels only undispatched work from that session", async () => {
  const preparation = deferred();
  const dispatched = [];
  const { center } = makeCenter({
    prepare: async ({ taskId }) => {
      await preparation.promise;
      return { ok: true, value: taskId };
    },
    dispatch: async (context) => {
      assert.equal(context.dispatchCommitted(), true);
      dispatched.push(context.taskId);
    },
  });
  const active = assertAccepted(submit(center, { sessionId: "closed" }));
  const sameSession = assertAccepted(submit(center, { sessionId: "closed" }));
  const otherSession = assertAccepted(submit(center, { sessionId: "open" }));
  await flush();
  const cancelled = center.sessionClosed("closed");
  assert.deepEqual(cancelled.map((task) => task.taskId), [active.taskId, sameSession.taskId]);
  assert.equal(center.get(active.taskId).error.code, "SESSION_ENDED");
  assert.equal(center.get(sameSession.taskId).error.code, "SESSION_ENDED");
  assert.equal(center.get(otherSession.taskId).state, "queued");
  assert.equal(submit(center, { sessionId: "closed" }).error.code, "SESSION_ENDED");

  preparation.resolve();
  await flush();
  assert.deepEqual(dispatched, [otherSession.taskId]);
});

test("preparation over five seconds fails without dispatch and resource defaults to thirty seconds", async () => {
  const clock = fakeClock();
  const { center, dispatched } = makeCenter({
    clock,
    prepare: async ({ payload }) => {
      clock.jump(5_001);
      return { ok: true, value: payload };
    },
  });
  const timedOut = assertAccepted(submit(center));
  await flush();
  assert.equal(center.get(timedOut.taskId).state, "failed");
  assert.equal(center.get(timedOut.taskId).error.code, "PREPARATION_TIMEOUT");
  assert.deepEqual(dispatched, []);

  const resourceClock = fakeClock();
  const resource = makeCenter({ clock: resourceClock }).center;
  const resourceTask = assertAccepted(submit(resource, { tool: "resource" }));
  await flush();
  await resourceClock.advance(10_000);
  assert.equal(resource.get(resourceTask.taskId).state, "running");
  await resourceClock.advance(20_000);
  assert.equal(resource.get(resourceTask.taskId).state, "unknown");
});

test("terminal retention keeps recent summaries bounded and evicts by count, bytes, and age", async () => {
  const clock = fakeClock();
  let center;
  ({ center } = makeCenter({
    clock,
    dispatch: async (context) => {
      assert.equal(context.dispatchCommitted(), true);
      context.settle({ identity: context.task.target.binding, execution: "ended", result: values(context.taskId) });
    },
  }));
  const ids = [];
  for (let index = 0; index < 257; index += 1) {
    const task = assertAccepted(submit(center, { sessionId: `count-${index}` }));
    ids.push(task.taskId);
    await flush();
  }
  assert.equal(center.get(ids[0]), undefined);
  assert.equal(center.overview().retainedCount, 256);
  assert.equal(center.overview().evictedCount, 1);
  assert.equal(center.overview().recent.length, 32);
  assert.equal(center.overview().recent[0].taskId, ids.at(-1));
  assert.equal(Object.hasOwn(center.overview().recent[0], "result"), false);

  const byteClock = fakeClock();
  const large = "x".repeat(240_000);
  const byteCenter = makeCenter({
    clock: byteClock,
    dispatch: async (context) => {
      assert.equal(context.dispatchCommitted(), true);
      context.settle({ identity: context.task.target.binding, execution: "ended", result: values(large) });
    },
  }).center;
  const byteIds = [];
  for (let index = 0; index < 72; index += 1) {
    byteIds.push(assertAccepted(submit(byteCenter, { sessionId: `bytes-${index}` })).taskId);
    await flush();
  }
  assert.equal(byteCenter.get(byteIds[0]), undefined, "the 16MiB terminal budget evicts oldest large results");
  assert.ok(byteCenter.overview().retainedCount < 72);

  const newest = byteIds.at(-1);
  await byteClock.advance(600_000);
  assert.equal(byteCenter.get(newest), undefined, "terminal tasks expire at ten minutes");
  assert.equal(byteCenter.overview().retainedCount, 0);
});

test("oversized trusted results become RESULT_TOO_LARGE and stop drops no work silently", async () => {
  const { center } = makeCenter();
  const oversized = assertAccepted(submit(center));
  await flush();
  center.settle(oversized.taskId, {
    identity: oversized.target.binding,
    execution: "ended",
    result: values("x".repeat(256 * 1024)),
  });
  assert.equal(center.get(oversized.taskId).state, "failed");
  assert.equal(center.get(oversized.taskId).error.code, "RESULT_TOO_LARGE");
  assert.equal(center.get(oversized.taskId).execution, "ended");

  const active = assertAccepted(submit(center, { sessionId: "active" }));
  const queued = assertAccepted(submit(center, { sessionId: "queued" }));
  await flush();
  await center.stop();
  assert.equal(center.get(active.taskId).state, "unknown");
  assert.equal(center.get(queued.taskId).state, "cancelled");
  assert.equal(center.submit({ sessionId: "later", tool: "execute_ts", target: serverTarget(), payload: {} }).error.code, "SESSION_ENDED");
});

test('closing a waiting-host session atomically cancels its queued successor',async()=>{
 const dispatched=[];const center=new TaskCenter({resourceEpoch:serverTarget().binding.resourceEpoch,prepare:()=>({ok:true,value:{}}),yieldControl:()=>{},dispatch:c=>dispatched.push(c)});
 const a=submit(center),b=submit(center),c=submit(center,{sessionId:'other'});await flush();
 center.sessionClosed('session-a');await flush();
 assert.equal(center.get(a.task.taskId).state,'cancelled');assert.equal(center.get(b.task.taskId).state,'cancelled');assert.equal(dispatched.some(x=>x.taskId===b.task.taskId),false);await center.stop();
});
test('a rejected yield settles without dispatch and the queue advances',async()=>{
 let calls=0;const center=new TaskCenter({resourceEpoch:serverTarget().binding.resourceEpoch,prepare:()=>({ok:true,value:{}}),yieldControl:()=>{if(++calls===1)throw new Error('yield failed');},dispatch:c=>{c.dispatchCommitted();c.settle({identity:c.task.target.binding,execution:'ended',result:values(2)});}});
 const a=submit(center),b=submit(center);await flush();await flush();assert.equal(center.get(a.task.taskId).state,'failed');assert.equal(center.get(b.task.taskId).state,'succeeded');await center.stop();
});
test('stale resource identities and inconsistent error evidence are rejected',async()=>{
 let context;const center=new TaskCenter({resourceEpoch:serverTarget().binding.resourceEpoch,prepare:()=>({ok:true,value:{}}),yieldControl:()=>{},dispatch:c=>{context=c;c.dispatchCommitted();}});
 assert.equal(submit(center,{target:serverTarget('old')}).ok,false);
 const task=submit(center);await flush();
 assert.equal(center.settle(task.task.taskId,{identity:serverTarget().binding,execution:'unknown',error:{code:'EXECUTION_UNKNOWN',message:'bad',phase:'queued',execution:'ended',retryable:false}}).accepted,false);
 await center.stop();
});

test("a committed executor rejection preserves trusted not_dispatched semantics and advances FIFO", async () => {
  const { center, dispatched } = makeCenter();
  const rejected = assertAccepted(submit(center));
  const next = assertAccepted(submit(center, { sessionId: "next" }));
  await flush();

  const executorFull = {
    code: "EXECUTOR_FULL",
    message: "executor refused before entering user code",
    phase: "dispatched",
    retryable: true,
    execution: "not_dispatched",
  };
  const wrongIdentity = center.settle(rejected.taskId, {
    identity: clientTarget().binding,
    execution: "not_dispatched",
    error: executorFull,
  });
  assert.equal(wrongIdentity.accepted, false);
  assert.equal(wrongIdentity.reason, "identity_mismatch");
  assert.equal(center.get(rejected.taskId).state, "running");

  const accepted = center.settle(rejected.taskId, {
    identity: rejected.target.binding,
    execution: "not_dispatched",
    error: executorFull,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.task.state, "failed");
  assert.equal(accepted.task.execution, "not_dispatched");
  assert.equal(accepted.task.error.execution, "not_dispatched");
  assert.equal(accepted.task.dispatchedAt !== undefined, true, "the internal commit remains observable");
  await flush();
  assert.deepEqual(dispatched, [rejected.taskId, next.taskId]);
});

test("malformed Error optional fields and additional properties cannot settle a task", async () => {
  const { center } = makeCenter();
  const task = assertAccepted(submit(center));
  await flush();
  const base = {
    code: "EXECUTION_FAILED",
    message: "execution failed",
    phase: "dispatched",
    retryable: false,
    execution: "ended",
  };
  let nested = { value: true };
  for (let index = 0; index < 33; index += 1) nested = { child: nested };
  const malformed = [
    { ...base, unexpected: true },
    { ...base, stack: 123 },
    { ...base, stack: "x".repeat(8_193) },
    { ...base, details: undefined },
    { ...base, details: nested },
  ];
  for (const taskError of malformed) {
    const result = center.settle(task.taskId, {
      identity: task.target.binding,
      execution: "ended",
      error: taskError,
    });
    assert.equal(result.accepted, false, JSON.stringify(taskError));
    assert.equal(result.reason, "invalid_evidence");
    assert.equal(center.get(task.taskId).state, "running");
  }

  const valid = center.settle(task.taskId, {
    identity: task.target.binding,
    execution: "ended",
    error: { ...base, stack: "user.ts:1:1", details: { attempt: 1 } },
  });
  assert.equal(valid.accepted, true);
  assert.deepEqual(valid.task.error.details, { attempt: 1 });
});

test("illegal evidence execution and malformed TaskResult or WireValue cannot settle a task", async () => {
  const { center } = makeCenter();
  const task = assertAccepted(submit(center));
  await flush();
  const invalidEvidence = [
    { identity: task.target.binding, execution: "teleported", result: values(1) },
    { identity: task.target.binding, execution: "ended", result: { kind: "other", values: [] } },
    { identity: task.target.binding, execution: "ended", result: { kind: "values", values: [], extra: true } },
    { identity: task.target.binding, execution: "ended", result: values({ $mcp: "nil", extra: true }) },
    { identity: task.target.binding, execution: "ended", result: values({ $mcp: "bogus" }) },
    { identity: task.target.binding, execution: "ended", result: values(Number.NaN) },
    { identity: task.target.binding, execution: "ended", result: { kind: "resource", change: { name: "demo" } } },
  ];
  for (const evidence of invalidEvidence) {
    const result = center.settle(task.taskId, evidence);
    assert.equal(result.accepted, false, JSON.stringify(evidence));
    assert.equal(result.reason, "invalid_evidence");
    assert.equal(center.get(task.taskId).state, "running");
  }

  const valid = center.settle(task.taskId, {
    identity: task.target.binding,
    execution: "ended",
    result: values(
      { $mcp: "nil" },
      { $mcp: "number", value: "Infinity" },
      { $mcp: "integer", value: "9007199254740993" },
      { $mcp: "bytes", base64: "AQI=" },
      { $mcp: "vector", values: [1, 2, 3] },
      { $mcp: "table", entries: [["key", true]] },
      { $mcp: "object", entries: [["$mcp", "user value"]] },
      { ordinary: [1, null, "value"] },
    ),
  });
  assert.equal(valid.accepted, true);
  assert.equal(valid.task.state, "succeeded");
});

test("hook-provided malformed Error objects are normalized before publication", async () => {
  const malformed = {
    code: "COMPILE_FAILED",
    message: "bad compile",
    phase: "preparing",
    retryable: false,
    execution: "not_dispatched",
    unexpected: true,
  };
  const preparing = makeCenter({ prepare: () => ({ ok: false, error: malformed }) }).center;
  const preparationTask = assertAccepted(submit(preparing));
  await flush();
  assert.equal(preparing.get(preparationTask.taskId).state, "failed");
  assert.equal(preparing.get(preparationTask.taskId).error.code, "INTERNAL_ERROR");
  assert.equal(Object.hasOwn(preparing.get(preparationTask.taskId).error, "unexpected"), false);

  const committing = makeCenter({ validateCommit: () => malformed }).center;
  const commitTask = assertAccepted(submit(committing));
  await flush();
  assert.equal(committing.get(commitTask.taskId).state, "failed");
  assert.equal(committing.get(commitTask.taskId).error.code, "INTERNAL_ERROR");
  assert.equal(Object.hasOwn(committing.get(commitTask.taskId).error, "unexpected"), false);
});


test('closed-session tombstones are bounded while transport validity prevents resurrection',async()=>{
 const {center,clock}=makeCenter({sessionValid:id=>id==='live'});
 for(let i=0;i<2000;i++)center.sessionClosed('closed-'+i);
 assert.ok(center.closedSessions.size<=512);
 assert.equal(submit(center,{sessionId:'closed-0'}).error.code,'SESSION_ENDED');
 clock.jump(605001);center.overview();assert.equal(center.closedSessions.size,0);
 assert.equal(submit(center,{sessionId:'closed-1999'}).error.code,'SESSION_ENDED');await center.stop();
});
