import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { TOOL_NAMES } from "../src/protocol/tool-names.ts";
import {
  REGISTERED_TOOLS,
  isToolRegistered,
} from "../src/tools/registry.ts";
import { TOOL_CATALOG } from "../src/tools/catalog.ts";
import {
  TOOL_INPUT_SCHEMAS,
  toolInputJsonSchema,
} from "../src/tools/schemas.ts";
import {
  SCREENSHOT_ENABLED,
  SCREENSHOT_IMPLEMENTED,
} from "../src/contracts/screenshot.disabled.ts";

test("the public tool surface is exactly the ten RFC tools", () => {
  assert.deepEqual([...TOOL_NAMES], [
    "status",
    "queue",
    "execute_lua",
    "execute_ts",
    "resource",
    "logs",
    "esx",
    "qbcore",
    "ox",
    "reference",
  ]);
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS).sort(), [...TOOL_NAMES].sort());
  assert.equal(TOOL_NAMES.includes("screenshot" as never), false);
});

test("the registered tool surface is the complete RFC catalog", () => {
  assert.deepEqual([...REGISTERED_TOOLS], [...TOOL_NAMES]);
  assert.deepEqual(Object.keys(TOOL_CATALOG), [...TOOL_NAMES]);
  for (const tool of TOOL_NAMES) {
    assert.equal(isToolRegistered(tool), true, `${tool} is registered`);
    assert.ok(TOOL_CATALOG[tool].description.length > 0, `${tool} is described`);
  }
});

test("every tool schema is strict and generates JSON Schema from the same declaration", () => {
  for (const tool of TOOL_NAMES) {
    const schema = TOOL_INPUT_SCHEMAS[tool];
    const probe = schema.safeParse({ __unexpected__: true });
    if (tool === "queue" || tool === "resource") {
      // discriminated unions reject unknown discriminators outright
      assert.equal(probe.success, false);
    } else {
      assert.equal(probe.success, false, `${tool} must reject unknown top-level fields`);
    }
    const jsonSchema = toolInputJsonSchema(tool);
    assert.equal(typeof jsonSchema, "object", `${tool} JSON Schema generation`);
  }
});

test("generated tool JSON Schema stays strict (additionalProperties false)", () => {
  const statusSchema = toolInputJsonSchema("status") as {
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  assert.equal(statusSchema.type, "object");
  assert.equal(statusSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(statusSchema.properties ?? {}), ["clientId"]);
});

test("generated framework/ox schemas keep the args array contract (completeness review F4)", () => {
  for (const tool of ["esx", "qbcore", "ox"] as const) {
    const generated = toolInputJsonSchema(tool) as {
      properties?: Record<string, { type?: string; default?: unknown }>;
    };
    const args = generated.properties?.args;
    assert.equal(args?.type, "array", `${tool} args must generate type:"array"`);
    assert.deepEqual(args?.default, []);
    assert.notEqual(args?.type, undefined);
  }
  // Runtime validation agrees with the published shape: only arrays pass,
  // and the iterative bounds still reject deep/wide payloads structurally.
  const base = { side: "server", scope: "framework", method: "GetJobs" } as const;
  assert.equal(
    TOOL_INPUT_SCHEMAS.esx.safeParse({ ...base, args: [1, "two", null] }).success,
    true,
  );
  assert.equal(
    TOOL_INPUT_SCHEMAS.esx.safeParse({ ...base, args: { 0: "positional" } }).success,
    false,
  );
  assert.equal(
    TOOL_INPUT_SCHEMAS.esx.safeParse({ ...base, args: "query" }).success,
    false,
  );
  const oxBase = { library: "ox_lib", side: "server", method: "notify" } as const;
  let deep: unknown = 0;
  for (let index = 0; index < 2_000; index += 1) deep = [deep];
  assert.equal(
    TOOL_INPUT_SCHEMAS.ox.safeParse({ ...oxBase, args: deep }).success,
    false,
  );
  assert.equal(
    TOOL_INPUT_SCHEMAS.ox.safeParse({ ...oxBase, args: [] }).success,
    true,
  );
});

test("the screenshot contract is disabled and unregistered", () => {
  assert.equal(SCREENSHOT_IMPLEMENTED, false);
  assert.equal(SCREENSHOT_ENABLED, false);
  assert.equal(
    (REGISTERED_TOOLS as readonly string[]).includes("screenshot"),
    false,
  );
});

test("zod remains importable at the pinned major behavior used by contracts", () => {
  assert.equal(typeof z.strictObject, "function");
  assert.equal(typeof z.toJSONSchema, "function");
});
