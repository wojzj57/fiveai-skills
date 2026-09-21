import type { FifoTool } from "../protocol/tool-names.ts";

export type ScheduledTaskState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface TaskSubmission {
  readonly taskId: string;
  readonly ownerSessionId: string;
  readonly tool: FifoTool;
  readonly arguments: unknown;
}

export interface ScheduledTask extends TaskSubmission {
  readonly sequence: number;
  readonly createdAt: number;
  state: ScheduledTaskState;
}

/**
 * In-memory side-effect gate shared by every entry and target. Persistence
 * and bridge dispatch are intentionally outside this class: callers must
 * durably record dispatch intent before moving the head to running.
 */
export class TaskScheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private sequence = 0;
  private activeTaskId: string | null = null;

  enqueue(submission: TaskSubmission): ScheduledTask {
    if (this.tasks.has(submission.taskId)) {
      throw new Error(`task already exists: ${submission.taskId}`);
    }
    const task: ScheduledTask = {
      ...submission,
      sequence: ++this.sequence,
      createdAt: Date.now(),
      state: "queued",
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  get(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  list(limit = 1000): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.sequence - b.sequence).slice(-limit);
  }

  /** The next task is available only while no running/unknown task owns the slot. */
  next(): ScheduledTask | null {
    if (this.activeTaskId !== null) return null;
    return this.list().find((task) => task.state === "queued") ?? null;
  }

  markRunning(taskId: string): ScheduledTask {
    const task = this.requireQueuedHead(taskId);
    task.state = "running";
    this.activeTaskId = taskId;
    return task;
  }

  markUnknown(taskId: string): ScheduledTask {
    const task = this.requireActive(taskId, "running");
    task.state = "unknown";
    return task;
  }

  settle(taskId: string, state: "succeeded" | "failed"): ScheduledTask {
    const task = this.requireActive(taskId, "running", "unknown");
    task.state = state;
    this.activeTaskId = null;
    return task;
  }

  cancel(taskId: string, ownerSessionId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.ownerSessionId !== ownerSessionId || task.state !== "queued") return false;
    task.state = "cancelled";
    return true;
  }

  private requireQueuedHead(taskId: string): ScheduledTask {
    const task = this.tasks.get(taskId);
    if (task === undefined || task.state !== "queued" || this.next()?.taskId !== taskId) {
      throw new Error(`task is not the queued head: ${taskId}`);
    }
    return task;
  }

  private requireActive(taskId: string, ...states: ScheduledTaskState[]): ScheduledTask {
    const task = this.tasks.get(taskId);
    if (task === undefined || this.activeTaskId !== taskId || !states.includes(task.state)) {
      throw new Error(`task is not active: ${taskId}`);
    }
    return task;
  }
}
