import { z } from "zod";
import { LIMITS } from "./limits.ts";

/**
 * Iterative JSON payload bounds (review finding F5). Recursive zod schemas
 * (z.json(), the wire value tree) exhaust the call stack on small-but-deep
 * payloads (a 2,000-level array is only ~4 KiB), so every JSON payload field
 * is guarded by these checks FIRST; violations surface as ordinary
 * validation errors instead of RangeError.
 *
 * The checks never recurse: they walk the value with an explicit stack and
 * also validate JSON-ness (types, finite numbers), so a boundedJson field is
 * a complete replacement for z.json() on that field.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonBounds {
  /** Maximum container nesting: a scalar root sits at depth 0, a root array/object at depth 1. */
  maxDepth: number;
  /** Maximum total node count; omit to bound depth only. */
  maxElements?: number;
}

export type JsonBoundsResult =
  | { ok: true }
  | { ok: false; reason: "type" | "depth" | "elements"; message: string };

/**
 * Validate that `value` is a JSON value within `bounds`, iteratively.
 * Depth counts container nesting; every visited node (scalars included)
 * counts toward the element total.
 */
export function checkJsonBounds(
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
        message: `JSON payload exceeds the ${bounds.maxElements}-element limit`,
      };
    }
    if (node === null || typeof node === "boolean" || typeof node === "string") {
      continue;
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        return {
          ok: false,
          reason: "type",
          message: "non-finite numbers are not JSON values",
        };
      }
      continue;
    }
    const childDepth = depth + 1;
    if (childDepth > bounds.maxDepth) {
      return {
        ok: false,
        reason: "depth",
        message: `JSON payload nests deeper than ${bounds.maxDepth} levels`,
      };
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        stack.push({ node: child, depth: childDepth });
      }
      continue;
    }
    if (typeof node === "object") {
      // Only plain objects are JSON values — matching z.json(), which rejects
      // Date/Map/Set/class instances. Without this check those would pass
      // validation while JSON.stringify serializes them differently.
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) {
        return {
          ok: false,
          reason: "type",
          message: "only plain objects are JSON values",
        };
      }
      for (const child of Object.values(node)) {
        stack.push({ node: child, depth: childDepth });
      }
      continue;
    }
    return {
      ok: false,
      reason: "type",
      message:
        "value is not a JSON value (undefined, symbol, function, or bigint)",
    };
  }
  return { ok: true };
}

/** Bounds for submitted tool arguments (review F5 input policy). */
export const ARGS_JSON_BOUNDS: JsonBounds = {
  maxDepth: LIMITS.payload.argsMaxDepth,
  maxElements: LIMITS.payload.argsMaxElementCount,
};

/**
 * Bounds for control-channel results: depth-bounded only. Logs responses may
 * legitimately carry more than 10,000 nodes (1,000 records); their size is
 * governed by the RFC §6.2 response byte caps and the 1 MiB frame limit.
 */
export const CONTROL_RESULT_JSON_BOUNDS: JsonBounds = {
  maxDepth: LIMITS.payload.argsMaxDepth,
};

/**
 * Bounded JSON value field: validates JSON-ness and bounds in one iterative
 * pass, replacing z.json() on payload fields so deep input fails as a
 * structured validation error.
 */
export function boundedJson(bounds: JsonBounds): z.ZodType<JsonValue> {
  return z.custom<JsonValue>(
    (value) => checkJsonBounds(value, bounds).ok,
    {
      message: `value must be JSON within bounds (depth <= ${bounds.maxDepth}, elements <= ${bounds.maxElements ?? "unlimited"})`,
    },
  );
}

/** Bounded JSON array field for positional tool arguments. */
export function boundedJsonArray(bounds: JsonBounds): z.ZodType<JsonValue[]> {
  return z.custom<JsonValue[]>(
    (value) => Array.isArray(value) && checkJsonBounds(value, bounds).ok,
    {
      message: `value must be a JSON array within bounds (depth <= ${bounds.maxDepth}, elements <= ${bounds.maxElements ?? "unlimited"})`,
    },
  );
}
