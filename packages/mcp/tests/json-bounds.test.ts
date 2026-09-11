import assert from "node:assert/strict";
import test from "node:test";
import {
  ARGS_JSON_BOUNDS,
  CONTROL_RESULT_JSON_BOUNDS,
  boundedJson,
  boundedJsonArray,
  checkJsonBounds,
} from "../src/protocol/json-bounds.ts";
import { LIMITS } from "../src/protocol/limits.ts";

/** Iteratively-built nesting so the test itself never recurses. */
function nested(containers: number): unknown {
  let node: unknown = 0;
  for (let index = 0; index < containers; index += 1) node = { v: node };
  return node;
}

test("bounds constants stay tied to the declared limits", () => {
  assert.equal(ARGS_JSON_BOUNDS.maxDepth, LIMITS.payload.argsMaxDepth);
  assert.equal(ARGS_JSON_BOUNDS.maxElements, LIMITS.payload.argsMaxElementCount);
  assert.equal(CONTROL_RESULT_JSON_BOUNDS.maxDepth, LIMITS.payload.argsMaxDepth);
  assert.equal(CONTROL_RESULT_JSON_BOUNDS.maxElements, undefined);
});

test("checkJsonBounds accepts scalars and well-formed JSON", () => {
  for (const value of [null, true, "s", 1.5, -0]) {
    assert.deepEqual(checkJsonBounds(value, ARGS_JSON_BOUNDS), { ok: true });
  }
  assert.deepEqual(checkJsonBounds({ a: [1, "b", null] }, ARGS_JSON_BOUNDS), { ok: true });
});

test("checkJsonBounds rejects non-JSON values wherever they appear", () => {
  for (const bad of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("s"),
    () => 1,
  ]) {
    const result = checkJsonBounds(bad, ARGS_JSON_BOUNDS);
    assert.equal(result.ok, false, `${String(bad)} must not be a JSON value`);
    assert.equal(result.ok === false && result.reason, "type");
  }
  assert.equal(checkJsonBounds({ a: undefined }, ARGS_JSON_BOUNDS).ok, false);
  assert.equal(checkJsonBounds([1, NaN], ARGS_JSON_BOUNDS).ok, false);
});

test("checkJsonBounds rejects exotic objects that z.json() also rejects", () => {
  // Date/Map/Set/class instances pass typeof "object" but are not JSON
  // values; accepting them would let validation and JSON.stringify diverge.
  for (const bad of [
    new Date(),
    new Map([["a", 1]]),
    new Set([1]),
    new (class Instance {
      x = 1;
    })(),
  ]) {
    const result = checkJsonBounds(bad, ARGS_JSON_BOUNDS);
    assert.equal(result.ok, false, `${bad.constructor.name} must be rejected`);
    assert.equal(result.ok === false && result.reason, "type");
    assert.equal(boundedJson(ARGS_JSON_BOUNDS).safeParse(bad).success, false);
  }
  // Object.create(null) plain objects and arrays stay accepted.
  const protoless = Object.create(null);
  protoless.key = "value";
  assert.deepEqual(checkJsonBounds(protoless, ARGS_JSON_BOUNDS), { ok: true });
});

test("depth is counted in container levels with the boundary inclusive", () => {
  assert.deepEqual(checkJsonBounds(nested(32), ARGS_JSON_BOUNDS), { ok: true });
  const tooDeep = checkJsonBounds(nested(33), ARGS_JSON_BOUNDS);
  assert.equal(tooDeep.ok, false);
  assert.equal(tooDeep.ok === false && tooDeep.reason, "depth");
  // Arrays and objects both count.
  let deepArray: unknown = 0;
  for (let index = 0; index < 33; index += 1) deepArray = [deepArray];
  assert.equal(checkJsonBounds(deepArray, ARGS_JSON_BOUNDS).ok, false);
});

test("every node counts toward the element limit", () => {
  // root object + list array + 9,998 children = 10,000 nodes exactly.
  const atLimit = { list: Array.from({ length: 9_998 }, () => 1) };
  assert.deepEqual(checkJsonBounds(atLimit, ARGS_JSON_BOUNDS), { ok: true });
  const overLimit = { list: Array.from({ length: 9_999 }, () => 1) };
  const result = checkJsonBounds(overLimit, ARGS_JSON_BOUNDS);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "elements");
});

test("depth-only bounds do not cap the element count", () => {
  // A logs-shaped response with more than 10,000 nodes is legal on the
  // control-result bounds; its size is governed by byte caps elsewhere.
  const wide = Array.from({ length: 12_000 }, (_, index) => ({
    logId: `l${index}`,
    message: "hello",
  }));
  assert.deepEqual(checkJsonBounds(wide, CONTROL_RESULT_JSON_BOUNDS), { ok: true });
  assert.equal(checkJsonBounds(wide, ARGS_JSON_BOUNDS).ok, false);
});

test("the walker never recurses, even on adversarial depth", () => {
  let deep: unknown = 0;
  for (let index = 0; index < 100_000; index += 1) deep = [deep];
  const result = checkJsonBounds(deep, ARGS_JSON_BOUNDS);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "depth");
});

test("boundedJson and boundedJsonArray surface bounds as validation errors", () => {
  const json = boundedJson(ARGS_JSON_BOUNDS);
  const array = boundedJsonArray(ARGS_JSON_BOUNDS);
  assert.equal(json.safeParse({ a: [1] }).success, true);
  assert.equal(json.safeParse(undefined).success, false);
  let deep: unknown = 0;
  for (let index = 0; index < 2_000; index += 1) deep = [deep];
  assert.equal(json.safeParse(deep).success, false);
  assert.equal(
    json.safeParse(deep).success === false &&
      (json.safeParse(deep).error?.issues[0]?.message.includes("bounds") ?? false),
    true,
    "the failure names the bounds",
  );
  assert.equal(array.safeParse([1, "two", null]).success, true);
  assert.equal(array.safeParse({ not: "an array" }).success, false);
  assert.equal(array.safeParse(deep).success, false);
});
