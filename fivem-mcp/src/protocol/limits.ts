/**
 * First-version engineering limits (RFC §6.2, plus the timing values fixed by
 * RFC §4.3 and frame limits from RFC §5.1). The status tool surfaces the
 * effective values; schemas must reference these constants instead of
 * duplicating numbers so limits cannot drift silently.
 */

export const LIMITS = {
  /** RFC §4.3: WebSocket heartbeat interval and loss threshold. */
  heartbeat: {
    intervalMs: 5_000,
    lossAfterMs: 15_000,
  },
  /** RFC §4.3: grace period after the last entry disconnects. */
  gracePeriodMs: 30_000,
  /** RFC §4.3: bridge reconnect backoff schedule (seconds 1/2/4/8, capped at 10) with jitter. */
  bridgeReconnect: {
    backoffScheduleMs: [1_000, 2_000, 4_000, 8_000],
    backoffCapMs: 10_000,
  },
  /** RFC §5.1: maximum size of one internal message frame; compression disabled. */
  message: {
    frameMaxBytes: 1024 * 1024,
    logsBatchMaxRecords: 100,
    logsBatchFlushMs: 100,
  },
  /** RFC §6.2: execution timeout defaults and bounds (resource mutations included). */
  execution: {
    timeoutMsDefault: 30_000,
    timeoutMsMin: 100,
    timeoutMsMax: 300_000,
  },
  /** RFC §6.2: tool synchronous wait — not a remote timeout, not timeoutMs. */
  toolSyncWaitMs: 20_000,
  /** RFC §6.2: database approval wait and per-entry pending cap; outside the FIFO. */
  approval: {
    waitMs: 300_000,
    maxPendingPerEntry: 5,
    displayMaxBytes: 32 * 1024,
  },
  /** RFC §6.2: queue capacities; full queue rejects, never evicts. */
  queue: {
    maxQueued: 100,
    maxRunningOrUnknown: 1,
  },
  /** RFC §6.2: submitted code and argument size ceilings. */
  payload: {
    codeMaxBytes: 64 * 1024,
    argsMaxBytes: 128 * 1024,
    /**
     * Defined input-depth policy (review F5): submitted JSON arguments are
     * bounded to the same depth/element ceilings as encoded results so the
     * iterative bounds check rejects pathological payloads with a structured
     * validation error before any recursive schema runs.
     */
    argsMaxDepth: 32,
    argsMaxElementCount: 10_000,
  },
  /** RFC §6.2: encoded result ceilings. */
  result: {
    maxBytes: 256 * 1024,
    maxEncodeDepth: 32,
    maxElementCount: 10_000,
  },
  /** RFC §6.2: completed-task cache retention. */
  taskCache: {
    maxEntries: 1_000,
    maxAgeMs: 30 * 60_000,
    maxTotalResultBytes: 32 * 1024 * 1024,
  },
  /** RFC §6.2: log stream and query limits. */
  logs: {
    perStreamMaxEntries: 50_000,
    perStreamMaxBytes: 16 * 1024 * 1024,
    globalMaxBytes: 64 * 1024 * 1024,
    queryLimitDefault: 100,
    queryLimitMax: 1_000,
    responseMaxBytes: 512 * 1024,
    lineMaxBytes: 64 * 1024,
  },
  /** RFC §6.2: reference query limits and online budget. */
  reference: {
    queryMaxChars: 256,
    limitDefault: 10,
    limitMax: 50,
    onlineBudgetMs: 8_000,
  },
  /** RFC §7.2: retained settled-record history bound. */
  settledHistoryMaxEntries: 100,
} as const;

export type Limits = typeof LIMITS;
