import { z } from "zod";
import { PlayerIdSchema } from "../protocol/ids.ts";
import { LIMITS } from "../protocol/limits.ts";
import { utf8ByteLength } from "../protocol/utf8.ts";
import {
  ARGS_JSON_BOUNDS,
  boundedJson,
  boundedJsonArray,
} from "../protocol/json-bounds.ts";
import type { ToolName } from "../protocol/tool-names.ts";

/**
 * Public MCP tool input schemas (RFC §6.1). All objects are strict
 * (additionalProperties=false). Common rules:
 * - resource names: non-empty, ≤128 chars, no path separators, control
 *   characters, or wildcards;
 * - method paths: exact, case-sensitive manifest keys; `__proto__`,
 *   `prototype`, and `constructor` path segments are forbidden;
 * - clientId/playerId: positive safe integers; client side requires
 *   clientId, server side forbids it;
 * - string sizes are enforced as UTF-8 byte limits;
 * - integers are range-checked before a task is allocated.
 */

const SideSchema = z.enum(["server", "client"]);

export const ResourceNameSchema = z
  .string()
  .min(1)
  .max(128)
  .superRefine((name, ctx) => {
    if (/[\\/\x00-\x1f]/.test(name)) {
      ctx.addIssue({
        code: "custom",
        message: "resource names must not contain path separators or control characters",
      });
    }
    if (/[*?]/.test(name)) {
      ctx.addIssue({
        code: "custom",
        message: "resource names must not contain wildcards",
      });
    }
  });

const MethodPathSchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((method, ctx) => {
    const segments = method.split(".");
    if (
      segments.includes("__proto__") ||
      segments.includes("prototype") ||
      segments.includes("constructor")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "method paths must not traverse __proto__, prototype, or constructor",
      });
    }
  });

const TimeoutMsSchema = z
  .number()
  .int()
  .min(LIMITS.execution.timeoutMsMin)
  .max(LIMITS.execution.timeoutMsMax)
  .default(LIMITS.execution.timeoutMsDefault);

function utf8BytesAtMost(maxBytes: number, label: string) {
  return (value: string, ctx: z.RefinementCtx) => {
    if (utf8ByteLength(value) > maxBytes) {
      ctx.addIssue({
        code: "custom",
        message: `${label} exceeds the ${maxBytes}-byte UTF-8 limit`,
      });
    }
  };
}

/** side/clientId rule shared by execute_*, esx/qbcore, and ox (RFC §6.1). */
function checkClientTargeting(
  input: { side: "server" | "client"; clientId?: number },
  ctx: z.RefinementCtx,
) {
  if (input.side === "client" && input.clientId === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["clientId"],
      message: "clientId is required when side is client",
    });
  }
  if (input.side === "server" && input.clientId !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["clientId"],
      message: "clientId must not be provided when side is server",
    });
  }
}

/** args must fit the encoded size budget (RFC §6.2). */
function checkArgsSize(args: unknown, ctx: z.RefinementCtx) {
  const encoded = utf8ByteLength(JSON.stringify(args));
  if (encoded > LIMITS.payload.argsMaxBytes) {
    ctx.addIssue({
      code: "custom",
      path: ["args"],
      message: `encoded args exceed the ${LIMITS.payload.argsMaxBytes}-byte limit`,
    });
  }
}

/** status — {} or {clientId} (RFC §6.1). */
export const StatusInputSchema = z.strictObject({
  clientId: PlayerIdSchema.optional(),
});

/** queue — control channel, independent of the FIFO (RFC §6.1). */
export const QueueInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("status"),
    taskId: z.uuid().optional(),
    // Contract choice: bounded by the completed-task cache size (RFC §6.2).
    limit: z.number().int().min(1).max(LIMITS.taskCache.maxEntries).optional(),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    taskId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal("recover"),
    taskId: z.uuid().optional(),
  }),
]);

/** execute_lua / execute_ts — fragment body plus JSON args (RFC §6.1). */
const ExecuteInputSchema = z
  .strictObject({
    side: SideSchema,
    /**
     * RFC §6.1 requires code to be present, not non-empty: an empty
     * function body is a legal fragment that returns nil/undefined.
     */
    code: z
      .string()
      .superRefine(utf8BytesAtMost(LIMITS.payload.codeMaxBytes, "code")),
    args: boundedJson(ARGS_JSON_BOUNDS).default({}),
    clientId: PlayerIdSchema.optional(),
    timeoutMs: TimeoutMsSchema,
  })
  .superRefine((input, ctx) => {
    checkClientTargeting(input, ctx);
    checkArgsSize(input.args, ctx);
  });

export const ExecuteLuaInputSchema = ExecuteInputSchema;
export const ExecuteTsInputSchema = ExecuteInputSchema;

/** resource — exact names, no wildcards or batches (RFC §6.1, §11). */
export const ResourceInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("status"),
    name: ResourceNameSchema,
  }),
  z.strictObject({
    action: z.literal("start"),
    name: ResourceNameSchema,
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    action: z.literal("stop"),
    name: ResourceNameSchema,
    timeoutMs: TimeoutMsSchema,
  }),
  z.strictObject({
    action: z.literal("restart"),
    name: ResourceNameSchema,
    timeoutMs: TimeoutMsSchema,
  }),
]);

/** logs — filters AND-combined, then last-N (RFC §6.1, §12). */
export const LogsInputSchema = z
  .strictObject({
    side: z.enum(["server", "client", "all"]).default("server"),
    clientId: PlayerIdSchema.optional(),
    resource: ResourceNameSchema.optional(),
    prefix: z.string().min(1).optional(),
    contains: z.string().min(1).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.logs.queryLimitMax)
      .default(LIMITS.logs.queryLimitDefault),
    includeRaw: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.side === "server" && input.clientId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["clientId"],
        message: "clientId must not be provided when side is server",
      });
    }
  });

/** esx / qbcore — framework and player scopes (RFC §6.1, §7.1). */
const FrameworkInputSchema = z
  .strictObject({
    side: SideSchema,
    scope: z.enum(["framework", "player"]),
    method: MethodPathSchema,
    args: boundedJsonArray(ARGS_JSON_BOUNDS).default([]),
    clientId: PlayerIdSchema.optional(),
    playerId: PlayerIdSchema.optional(),
    timeoutMs: TimeoutMsSchema,
  })
  .superRefine((input, ctx) => {
    checkClientTargeting(input, ctx);
    if (input.scope === "player") {
      if (input.playerId === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["playerId"],
          message: "playerId is required when scope is player",
        });
      }
      if (input.side !== "server") {
        ctx.addIssue({
          code: "custom",
          path: ["side"],
          message: "player scope is only available on the server side",
        });
      }
    } else if (input.playerId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["playerId"],
        message: "playerId must not be provided when scope is framework",
      });
    }
    checkArgsSize(input.args, ctx);
  });

export const EsxInputSchema = FrameworkInputSchema;
export const QbcoreInputSchema = FrameworkInputSchema;

/** ox — ox_lib / ox_target / oxmysql with original method names (RFC §6.1, §7.2). */
export const OxInputSchema = z
  .strictObject({
    library: z.enum(["ox_lib", "ox_target", "oxmysql"]),
    side: SideSchema,
    method: MethodPathSchema,
    args: boundedJsonArray(ARGS_JSON_BOUNDS).default([]),
    clientId: PlayerIdSchema.optional(),
    timeoutMs: TimeoutMsSchema,
  })
  .superRefine((input, ctx) => {
    checkClientTargeting(input, ctx);
    if (input.library === "oxmysql" && input.side !== "server") {
      ctx.addIssue({
        code: "custom",
        path: ["side"],
        message: "oxmysql only executes on the server side",
      });
    }
    checkArgsSize(input.args, ctx);
  });

/** reference — local-first with online fallback (RFC §6.1, §13). */
export const ReferenceInputSchema = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(LIMITS.reference.queryMaxChars),
  category: z.enum(["native", "event", "guide", "all"]).default("all"),
  side: z.enum(["client", "server", "shared"]).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.reference.limitMax)
    .default(LIMITS.reference.limitDefault),
});

/** All ten public tool input schemas keyed by tool name. */
export const TOOL_INPUT_SCHEMAS = {
  status: StatusInputSchema,
  queue: QueueInputSchema,
  execute_lua: ExecuteLuaInputSchema,
  execute_ts: ExecuteTsInputSchema,
  resource: ResourceInputSchema,
  logs: LogsInputSchema,
  esx: EsxInputSchema,
  qbcore: QbcoreInputSchema,
  ox: OxInputSchema,
  reference: ReferenceInputSchema,
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolInputOf<T extends ToolName> = z.infer<
  (typeof TOOL_INPUT_SCHEMAS)[T]
>;

/**
 * JSON Schema for a tool input, generated from the same zod declaration
 * (RFC §3.1: 工具 schema 和内部消息从同一声明产生). Uses the input shape
 * so defaulted fields stay optional for MCP clients.
 *
 * Known limitation: zod refinements (byte limits, side/clientId
 * conditional rules, args budgets) are not expressible in generated JSON
 * Schema, so the published schema is weaker than server-side validation;
 * violating inputs are still rejected with INVALID_ARGUMENT at runtime.
 */
export function toolInputJsonSchema(tool: ToolName): unknown {
  return z.toJSONSchema(TOOL_INPUT_SCHEMAS[tool], {
    io: "input",
    unrepresentable: "any",
  });
}
