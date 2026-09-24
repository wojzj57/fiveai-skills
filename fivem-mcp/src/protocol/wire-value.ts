import { z } from "zod";
import { LIMITS } from "./limits.ts";
import type { JsonBounds, JsonBoundsResult } from "./json-bounds.ts";

/**
 * Fully tagged recursive wire value (RFC §6.3). Every value carries a `kind`
 * tag so user object keys can never collide with encoding labels, and
 * JSON null / Lua nil / JS undefined stay distinguishable.
 *
 * The recursive schemas are the wire FORMAT contract. Receiving boundaries
 * must use BoundedWireValueSchema / BoundedExecutionValueSchema, which run
 * the iterative bounds walk (RFC §6.2 depth 32 / elements 10,000) before the
 * recursion, so adversarial payloads fail as validation errors instead of
 * exhausting the call stack (review F5). Function, thread, and unknown
 * userdata values are reported as RESULT_UNSERIALIZABLE errors instead of
 * being encoded.
 */

const DecimalStringSchema = z.string().regex(
  /^-?\d+(?![\s\S])/,
  "expected a decimal string",
);

/** Lua 64-bit signed integer range check. */
const Int64StringSchema = DecimalStringSchema.superRefine((value, ctx) => {
  // The base regex already rejects non-decimal strings; skip those here
  // because all checks run even when an earlier one failed.
  if (!/^-?\d+$/.test(value)) return;
  const parsed = BigInt(value);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) {
    ctx.addIssue({
      code: "custom",
      message: "int64 out of 64-bit signed range",
    });
  }
});

const Base64Schema = z.string().regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/,
  "expected base64 data",
);

export type WireValue =
  | { kind: "null" }
  | { kind: "nil" }
  | { kind: "undefined" }
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "int64"; value: string }
  | { kind: "bigint"; value: string }
  | { kind: "specialNumber"; value: "NaN" | "Infinity" | "-Infinity" }
  | { kind: "hole" }
  | { kind: "array"; value: WireValue[] }
  | { kind: "object"; entries: { key: string; value: WireValue }[] }
  | { kind: "map"; entries: { key: WireValue; value: WireValue }[] }
  | {
      kind: "vector";
      dimension: 2 | 3 | 4;
      components: number[];
    }
  | { kind: "bytes"; base64: string; byteLength: number };

export const WireValueSchema: z.ZodType<WireValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("null") }),
    z.strictObject({ kind: z.literal("nil") }),
    z.strictObject({ kind: z.literal("undefined") }),
    z.strictObject({ kind: z.literal("hole") }),
    z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
    z.strictObject({ kind: z.literal("string"), value: z.string() }),
    z.strictObject({ kind: z.literal("number"), value: z.number().finite() }),
    z.strictObject({ kind: z.literal("int64"), value: Int64StringSchema }),
    z.strictObject({ kind: z.literal("bigint"), value: DecimalStringSchema }),
    z.strictObject({
      kind: z.literal("specialNumber"),
      value: z.enum(["NaN", "Infinity", "-Infinity"]),
    }),
    z.strictObject({ kind: z.literal("array"), value: z.array(WireValueSchema) }),
    z.strictObject({
      kind: z.literal("object"),
      entries: z.array(
        z.strictObject({ key: z.string(), value: WireValueSchema }),
      ),
    }),
    z.strictObject({
      kind: z.literal("map"),
      entries: z.array(
        z.strictObject({ key: WireValueSchema, value: WireValueSchema }),
      ),
    }),
    z.strictObject({
      kind: z.literal("vector"),
      dimension: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      components: z.array(z.number().finite()),
    }).superRefine((vector, ctx) => {
      if (vector.components.length !== vector.dimension) {
        ctx.addIssue({
          code: "custom",
          path: ["components"],
          message: "component count must equal the vector dimension",
        });
      }
    }),
    z.strictObject({
      kind: z.literal("bytes"),
      base64: Base64Schema,
      byteLength: z.number().int().min(0),
    }).superRefine((bytes, ctx) => {
      const actual = base64DecodedLength(bytes.base64);
      if (actual !== bytes.byteLength) {
        ctx.addIssue({
          code: "custom",
          path: ["byteLength"],
          message: `byteLength ${bytes.byteLength} contradicts the ${actual} bytes encoded in base64`,
        });
      }
    }),
  ]),
);

/**
 * Exact byte count of canonical base64 data (the regex above guarantees a
 * length that is a multiple of 4 with valid padding).
 */
function base64DecodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * Language-tagged execution result (RFC §6.3): Lua returns keep multiple
 * return values (tail nils preserved via table.pack n by the encoder);
 * JavaScript yields a single value.
 */
export const LuaResultSchema = z.strictObject({
  language: z.literal("lua"),
  returns: z.array(WireValueSchema),
});

export const JavaScriptResultSchema = z.strictObject({
  language: z.literal("javascript"),
  value: WireValueSchema,
});

export const ExecutionValueSchema = z.discriminatedUnion("language", [
  LuaResultSchema,
  JavaScriptResultSchema,
]);

export type ExecutionValue = z.infer<typeof ExecutionValueSchema>;

/**
 * RFC §6.2 encoded-result ceilings applied when receiving wire values
 * (review F5): depth 32, at most 10,000 wire nodes.
 */
export const WIRE_VALUE_BOUNDS: JsonBounds = {
  maxDepth: LIMITS.result.maxEncodeDepth,
  maxElements: LIMITS.result.maxElementCount,
};

/**
 * Children of a node in the recursive wire shapes, or null for leaves and
 * malformed nodes. Malformed nodes are safe as leaves because the strict
 * wire schema rejects them without recursing into their fields.
 * `wraps` marks the two execution-value language wrappers, which are
 * metadata rather than data nesting and do not consume a depth level.
 */
function wireChildren(
  node: unknown,
): { children: unknown[]; wraps: boolean } | null {
  if (typeof node !== "object" || node === null) return null;
  const record = node as {
    kind?: unknown;
    language?: unknown;
    value?: unknown;
    entries?: unknown;
    returns?: unknown;
  };
  if (record.kind === "array" && Array.isArray(record.value)) {
    return { children: record.value, wraps: false };
  }
  if (
    (record.kind === "object" || record.kind === "map") &&
    Array.isArray(record.entries)
  ) {
    const children: unknown[] = [];
    for (const entry of record.entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as { key?: unknown; value?: unknown };
      if (e.value !== undefined) children.push(e.value);
      if (record.kind === "map" && e.key !== undefined) children.push(e.key);
    }
    return { children, wraps: false };
  }
  if (record.language === "lua" && Array.isArray(record.returns)) {
    return { children: record.returns, wraps: true };
  }
  if (record.language === "javascript" && "value" in record) {
    return { children: [record.value], wraps: true };
  }
  return null;
}

/**
 * Iterative bounds walk over wire value trees (review F5). Follows the only
 * recursive shapes in the format — array values, object/map entries, and the
 * language wrappers — so the recursive schema afterwards only ever sees a
 * tree within bounds. Counts one element per visited node.
 */
export function checkWireBounds(
  value: unknown,
  bounds: JsonBounds,
): JsonBoundsResult {
  let elements = 0;
  const stack: { node: unknown; depth: number }[] = [
    { node: value, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    elements += 1;
    if (bounds.maxElements !== undefined && elements > bounds.maxElements) {
      return {
        ok: false,
        reason: "elements",
        message: `wire value exceeds the ${bounds.maxElements}-element limit`,
      };
    }
    const shape = wireChildren(node);
    if (shape === null) continue;
    if (shape.wraps) {
      for (const child of shape.children) {
        stack.push({ node: child, depth });
      }
      continue;
    }
    const childDepth = depth + 1;
    if (childDepth > bounds.maxDepth) {
      return {
        ok: false,
        reason: "depth",
        message: `wire value nests deeper than ${bounds.maxDepth} levels`,
      };
    }
    for (const child of shape.children) {
      stack.push({ node: child, depth: childDepth });
    }
  }
  return { ok: true };
}

/**
 * Wire value schema for RECEIVING boundaries (review F5): bounds are checked
 * iteratively before the recursive format validation runs. Encoder-side code
 * that constructs values programmatically may use WireValueSchema directly,
 * but must also obey WIRE_VALUE_BOUNDS when encoding.
 */
export const BoundedWireValueSchema: z.ZodType<WireValue> = z.preprocess(
  (value, ctx) => {
    const check = checkWireBounds(value, WIRE_VALUE_BOUNDS);
    if (!check.ok) {
      ctx.addIssue({ code: "custom", message: check.message });
      return z.NEVER;
    }
    return value;
  },
  WireValueSchema,
);

/** Execution value schema for receiving boundaries (bounded, review F5). */
export const BoundedExecutionValueSchema = z.preprocess(
  (value, ctx) => {
    const check = checkWireBounds(value, WIRE_VALUE_BOUNDS);
    if (!check.ok) {
      ctx.addIssue({ code: "custom", message: check.message });
      return z.NEVER;
    }
    return value;
  },
  ExecutionValueSchema,
);
