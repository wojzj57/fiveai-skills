import { z } from "zod";

/**
 * Fully tagged recursive wire value (RFC §6.3). Every value carries a `kind`
 * tag so user object keys can never collide with encoding labels, and
 * JSON null / Lua nil / JS undefined stay distinguishable.
 *
 * This is a result-encoding contract only: the depth (32), element count
 * (10,000), and byte (256 KiB) ceilings are enforced by the runtime encoder,
 * not by this schema. Function, thread, and unknown userdata values are
 * reported as RESULT_UNSERIALIZABLE errors instead of being encoded.
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
    }),
  ]),
);

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
