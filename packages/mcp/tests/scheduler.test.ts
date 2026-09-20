import assert from "node:assert/strict";
import test from "node:test";
import { TaskScheduler } from "../src/scheduler/task-scheduler.ts";

const task = (id: string, ownerSessionId = "entry-a") => ({
  taskId: id,
  ownerSessionId,
  tool: "execute_lua" as const,
  arguments: { side: "server", code: "return 1", args: {}, timeoutMs: 100 },
});

test("scheduler assigns one global FIFO sequence and only starts the head", () => {
  const scheduler = new TaskScheduler();
  const first = scheduler.enqueue(task("00000000-0000-4000-8000-000000000001"));
  const second = scheduler.enqueue(task("00000000-0000-4000-8000-000000000002"));

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(scheduler.next()?.taskId, first.taskId);
  scheduler.markRunning(first.taskId);
  assert.equal(scheduler.next(), null, "a running task blocks later side effects");
});

test("scheduler lets only the creating entry cancel a queued task", () => {
  const scheduler = new TaskScheduler();
  const queued = scheduler.enqueue(task("00000000-0000-4000-8000-000000000003"));

  assert.equal(scheduler.cancel(queued.taskId, "entry-b"), false);
  assert.equal(scheduler.cancel(queued.taskId, "entry-a"), true);
  assert.equal(scheduler.get(queued.taskId)?.state, "cancelled");
  assert.equal(scheduler.next(), null);
});

test("an unknown outcome keeps the global execution slot blocked", () => {
  const scheduler = new TaskScheduler();
  const first = scheduler.enqueue(task("00000000-0000-4000-8000-000000000004"));
  scheduler.enqueue(task("00000000-0000-4000-8000-000000000005"));
  scheduler.markRunning(first.taskId);
  scheduler.markUnknown(first.taskId);

  assert.equal(scheduler.get(first.taskId)?.state, "unknown");
  assert.equal(scheduler.next(), null);
});
