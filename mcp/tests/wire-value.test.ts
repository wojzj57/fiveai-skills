import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionValueSchema,
  WireValueSchema,
} from "../src/protocol/wire-value.ts";

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

test("bytes carry base64 payload and byte count", () => {
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
