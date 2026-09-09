import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedExecutionValueSchema,
  BoundedWireValueSchema,
  ExecutionValueSchema,
  WireValueSchema,
  WIRE_VALUE_BOUNDS,
  checkWireBounds,
} from "../src/protocol/wire-value.ts";
import { LIMITS } from "../src/protocol/limits.ts";

test("json null, lua nil, and js undefined stay distinguishable", () => {
  for (const kind of ["null", "nil", "undefined"] as const) {
    assert.deepEqual(WireValueSchema.parse({ kind }), { kind });
  }
  assert.equal(WireValueSchema.safeParse({ kind: "null", value: 1 }).success, false);
});

test("scalars encode with finite numbers only", () => {
  assert.deepEqual(WireValueSchema.parse({ kind: "boolean", value: true }), {
    kind: "boolean",
    value: true,
  });
  assert.deepEqual(WireValueSchema.parse({ kind: "string", value: "s" }), {
    kind: "string",
    value: "s",
  });
  assert.equal(WireValueSchema.safeParse({ kind: "number", value: 1.5 }).success, true);
  assert.equal(WireValueSchema.safeParse({ kind: "number", value: Infinity }).success, false);
  assert.equal(WireValueSchema.safeParse({ kind: "number", value: NaN }).success, false);
});

test("non-finite numbers use the specialNumber string form", () => {
  for (const value of ["NaN", "Infinity", "-Infinity"] as const) {
    assert.deepEqual(WireValueSchema.parse({ kind: "specialNumber", value }), {
      kind: "specialNumber",
      value,
    });
  }
  assert.equal(
    WireValueSchema.safeParse({ kind: "specialNumber", value: "1" }).success,
    false,
  );
});

test("int64 is a decimal string in signed 64-bit range; bigint is unbounded decimal", () => {
  assert.equal(
    WireValueSchema.safeParse({ kind: "int64", value: "9223372036854775807" }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "int64", value: "-9223372036854775808" }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "int64", value: "9223372036854775808" }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "int64", value: "12.5" }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "int64", value: "12\n" }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bigint", value: "999999999999999999999999999" }).success,
    true,
  );
});

test("arrays nest recursively and holes are tagged", () => {
  assert.deepEqual(
    WireValueSchema.parse({
      kind: "array",
      value: [{ kind: "number", value: 1 }, { kind: "hole" }, { kind: "nil" }],
    }),
    {
      kind: "array",
      value: [{ kind: "number", value: 1 }, { kind: "hole" }, { kind: "nil" }],
    },
  );
});

test("objects use entry arrays so user keys cannot collide with tags", () => {
  assert.deepEqual(
    WireValueSchema.parse({
      kind: "object",
      entries: [
        { key: "kind", value: { kind: "string", value: "user data" } },
        { key: "value", value: { kind: "number", value: 2 } },
      ],
    }),
    {
      kind: "object",
      entries: [
        { key: "kind", value: { kind: "string", value: "user data" } },
        { key: "value", value: { kind: "number", value: 2 } },
      ],
    },
  );
});

test("maps keep non-string keys as wire values", () => {
  assert.equal(
    WireValueSchema.safeParse({
      kind: "map",
      entries: [
        { key: { kind: "number", value: 1 }, value: { kind: "string", value: "one" } },
      ],
    }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({
      kind: "map",
      entries: [{ key: "not-a-wire-value", value: { kind: "nil" } }],
    }).success,
    false,
  );
});

test("vectors constrain dimension and component count", () => {
  assert.equal(
    WireValueSchema.safeParse({ kind: "vector", dimension: 3, components: [1, 2, 3] }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "vector", dimension: 3, components: [1, 2] }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "vector", dimension: 5, components: [1, 2, 3, 4, 5] }).success,
    false,
  );
});

test("bytes carry base64 payload and a consistent byte count (review F6)", () => {
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQID", byteLength: 3 }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "not base64!!", byteLength: 3 }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQID\n", byteLength: 3 }).success,
    false,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQID", byteLength: -1 }).success,
    false,
  );
  // Declared length must match the actual encoded bytes.
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQID", byteLength: 1000 }).success,
    false,
    "declared length larger than the payload is rejected",
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQID", byteLength: 2 }).success,
    false,
    "declared length smaller than the payload is rejected",
  );
  // Padding counts: "AQI=" encodes 2 bytes, not 3.
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQI=", byteLength: 2 }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "AQI=", byteLength: 3 }).success,
    false,
  );
  // Empty bytes are representable.
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "", byteLength: 0 }).success,
    true,
  );
  assert.equal(
    WireValueSchema.safeParse({ kind: "bytes", base64: "", byteLength: 1 }).success,
    false,
  );
});

test("language wrappers separate lua multi-returns from js single values", () => {
  assert.deepEqual(
    ExecutionValueSchema.parse({
      language: "lua",
      returns: [{ kind: "number", value: 1 }, { kind: "nil" }],
    }),
    {
      language: "lua",
      returns: [{ kind: "number", value: 1 }, { kind: "nil" }],
    },
  );
  assert.equal(
    ExecutionValueSchema.safeParse({
      language: "javascript",
      value: { kind: "undefined" },
    }).success,
    true,
  );
  assert.equal(
    ExecutionValueSchema.safeParse({ language: "python", value: { kind: "nil" } }).success,
    false,
  );
});

test("wire bounds enforce RFC depth 32 without recursion (review F5)", () => {
  const nestedWire = (levels: number): unknown => {
    let node: unknown = { kind: "number", value: 1 };
    for (let index = 0; index < levels; index += 1) {
      node = { kind: "array", value: [node] };
    }
    return node;
  };
  assert.equal(WIRE_VALUE_BOUNDS.maxDepth, LIMITS.result.maxEncodeDepth);
  assert.equal(WIRE_VALUE_BOUNDS.maxElements, LIMITS.result.maxElementCount);
  // 32 nesting levels are within the RFC §6.2 ceilings.
  assert.equal(BoundedWireValueSchema.safeParse(nestedWire(32)).success, true);
  // The 33rd container level exceeds the encoding depth.
  assert.equal(BoundedWireValueSchema.safeParse(nestedWire(33)).success, false);
  assert.equal(checkWireBounds(nestedWire(33), WIRE_VALUE_BOUNDS).ok, false);
  // The wrapper itself is metadata and does not consume a depth level.
  assert.equal(
    BoundedExecutionValueSchema.safeParse({
      language: "lua",
      returns: [nestedWire(32)],
    }).success,
    true,
  );
  assert.equal(
    BoundedExecutionValueSchema.safeParse({
      language: "lua",
      returns: [nestedWire(33)],
    }).success,
    false,
  );
});

test("deep raw payloads fail as structured validation errors, not RangeError (review F5)", () => {
  // A 2,000-level array is only ~4 KiB of JSON but exhausts recursive
  // validation; the bounded schemas reject it before recursing.
  let deep: unknown = 0;
  for (let index = 0; index < 2_000; index += 1) deep = [deep];
  const wire = BoundedWireValueSchema.safeParse(deep);
  assert.equal(wire.success, false);
  const execution = BoundedExecutionValueSchema.safeParse({
    language: "javascript",
    value: deep,
  });
  assert.equal(execution.success, false);
  // Deep garbage hidden behind a wire label is bounded too...
  const hidden = BoundedWireValueSchema.safeParse({
    kind: "array",
    value: [deep],
  });
  assert.equal(hidden.success, false);
  // ...and inside map entries.
  const mapHidden = BoundedWireValueSchema.safeParse({
    kind: "map",
    entries: [{ key: deep, value: { kind: "nil" } }],
  });
  assert.equal(mapHidden.success, false);
});

test("wire bounds count every node toward the element limit (review F5)", () => {
  const flatWire = (count: number) => ({
    kind: "array",
    value: Array.from({ length: count }, () => ({ kind: "nil" })),
  });
  // root + 9,999 children = 10,000 nodes exactly.
  assert.equal(BoundedWireValueSchema.safeParse(flatWire(9_999)).success, true);
  assert.equal(BoundedWireValueSchema.safeParse(flatWire(10_000)).success, false);
});
