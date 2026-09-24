import assert from "node:assert/strict";
import test from "node:test";
import {
  EsxInputSchema,
  ExecuteLuaInputSchema,
  ExecuteJsInputSchema,
  LogsInputSchema,
  OxInputSchema,
  QbcoreInputSchema,
  QueueInputSchema,
  ReferenceInputSchema,
  ResourceInputSchema,
  StatusInputSchema,
} from "../src/tools/schemas.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function rejects(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown, why: string) {
  assert.equal(schema.safeParse(value).success, false, why);
}

function accepts(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown, why: string) {
  assert.equal(schema.safeParse(value).success, true, why);
}

test("status takes an empty object or a client filter only", () => {
  accepts(StatusInputSchema, {}, "empty status input");
  accepts(StatusInputSchema, { clientId: 5 }, "client-filtered status");
  rejects(StatusInputSchema, { clientId: 0 }, "clientId must be positive");
  rejects(StatusInputSchema, { extra: 1 }, "unknown fields rejected");
});

test("queue actions carry their required fields", () => {
  accepts(QueueInputSchema, { action: "status" }, "status action");
  accepts(QueueInputSchema, { action: "status", taskId: UUID, limit: 1000 }, "status with task and limit");
  accepts(QueueInputSchema, { action: "recover" }, "recover defaults to the blocking task");
  rejects(QueueInputSchema, { action: "cancel" }, "cancel requires taskId");
  rejects(QueueInputSchema, { action: "status", limit: 1001 }, "limit bounded by task cache size");
  rejects(QueueInputSchema, { action: "purge" }, "unknown action");
});

test("execute_lua and execute_js enforce side/clientId pairing and defaults", () => {
  for (const schema of [ExecuteLuaInputSchema, ExecuteJsInputSchema]) {
    const parsed = schema.parse({ side: "server", code: "return 1" });
    assert.deepEqual(parsed.args, {});
    assert.equal(parsed.timeoutMs, 30_000);

    rejects(schema, { side: "server", code: "return 1", clientId: 2 }, "server side must not take clientId");
    rejects(schema, { side: "client", code: "return 1" }, "client side requires clientId");
    accepts(schema, { side: "client", code: "return 1", clientId: 2 }, "client side with clientId");
    rejects(schema, { side: "both", code: "return 1" }, "invalid side");
    rejects(schema, { side: "server" }, "code is required");
    accepts(schema, { side: "server", code: "" }, "empty function bodies are legal fragments");
    rejects(
      schema,
      { side: "server", code: "return 1", timeoutMs: 99 },
      "timeoutMs below the minimum",
    );
    rejects(
      schema,
      { side: "server", code: "return 1", timeoutMs: 300_001 },
      "timeoutMs above the maximum",
    );
  }
});

test("code is limited by UTF-8 bytes, not characters", () => {
  accepts(
    ExecuteLuaInputSchema,
    { side: "server", code: "a".repeat(64 * 1024) },
    "exactly 64 KiB of ASCII passes",
  );
  rejects(
    ExecuteLuaInputSchema,
    { side: "server", code: "a".repeat(64 * 1024 + 1) },
    "one byte over the code limit fails",
  );
  rejects(
    ExecuteLuaInputSchema,
    { side: "server", code: "\u{4E2D}".repeat(21_846) },
    "65,538 bytes of CJK under 64 KiB characters still fails",
  );
});

test("encoded args are limited to 128 KiB", () => {
  accepts(
    ExecuteJsInputSchema,
    { side: "server", code: "return args", args: { blob: "x".repeat(100_000) } },
    "args within budget",
  );
  rejects(
    ExecuteJsInputSchema,
    { side: "server", code: "return args", args: { blob: "x".repeat(140_000) } },
    "args over budget",
  );
});

test("deep or oversized args fail as structured validation errors, not RangeError (review F5)", () => {
  // 2,000 nesting levels are only ~4 KiB — well under the byte budget —
  // but exceed the defined input depth policy.
  let deep: unknown = 0;
  for (let index = 0; index < 2_000; index += 1) deep = [deep];
  for (const schema of [ExecuteLuaInputSchema, ExecuteJsInputSchema]) {
    const result = schema.safeParse({ side: "server", code: "return args", args: deep });
    assert.equal(result.success, false, "deep args are rejected");
  }
  // Legitimate nesting stays accepted.
  accepts(
    ExecuteLuaInputSchema,
    {
      side: "server",
      code: "return args",
      args: { list: [1, [2, [3, [4, { key: "value" }]]]] },
    },
    "moderately nested args",
  );
  // Wide-but-shallow args beyond the element count are rejected.
  const wide = Array.from({ length: 10_001 }, (_, index) => index);
  rejects(
    ExecuteLuaInputSchema,
    { side: "server", code: "return args", args: wide },
    "element count above the input policy",
  );
  rejects(
    EsxInputSchema,
    { side: "server", scope: "framework", method: "GetJobs", args: wide },
    "framework args element count above the input policy",
  );
  rejects(
    OxInputSchema,
    { library: "oxmysql", side: "server", method: "query", args: wide },
    "ox args element count above the input policy",
  );
});

test("resource actions require exact names without wildcards or paths", () => {
  accepts(ResourceInputSchema, { action: "list" }, "list takes no name");
  accepts(ResourceInputSchema, { action: "status", name: "my-resource" }, "status with name");
  accepts(
    ResourceInputSchema,
    { action: "restart", name: "my-resource", timeoutMs: 5_000 },
    "mutations may carry timeoutMs",
  );
  rejects(ResourceInputSchema, { action: "list", name: "x" }, "list must not carry a name");
  rejects(ResourceInputSchema, { action: "start" }, "mutations require a name");
  rejects(ResourceInputSchema, { action: "stop", name: "a/b" }, "path separators rejected");
  rejects(ResourceInputSchema, { action: "stop", name: "a\\b" }, "windows separators rejected");
  rejects(ResourceInputSchema, { action: "stop", name: "my*" }, "wildcards rejected");
  rejects(ResourceInputSchema, { action: "stop", name: "x".repeat(129) }, "name over 128 chars");
  rejects(
    ResourceInputSchema,
    { action: "status", name: "x", timeoutMs: 1_000 },
    "reads must not carry timeoutMs",
  );
});

test("logs defaults to the server side with limit 100", () => {
  const parsed = LogsInputSchema.parse({});
  assert.equal(parsed.side, "server");
  assert.equal(parsed.limit, 100);
  assert.equal(parsed.includeRaw, false);

  rejects(LogsInputSchema, { side: "server", clientId: 1 }, "server logs take no clientId");
  accepts(LogsInputSchema, { side: "client", clientId: 1 }, "client logs with clientId");
  accepts(LogsInputSchema, { side: "all", clientId: 1 }, "all means server plus one client");
  rejects(LogsInputSchema, { limit: 1_001 }, "limit above the maximum");
  rejects(LogsInputSchema, { prefix: "" }, "prefix must be non-empty");
  rejects(LogsInputSchema, { contains: "" }, "contains must be non-empty");
  rejects(LogsInputSchema, { resource: "bad/name" }, "resource filter uses resource-name rules");
});

test("esx and qbcore scope rules", () => {
  for (const schema of [EsxInputSchema, QbcoreInputSchema]) {
    accepts(
      schema,
      { side: "server", scope: "framework", method: "GetPlayerFromId", args: [12] },
      "framework scope on the server",
    );
    accepts(
      schema,
      { side: "server", scope: "player", playerId: 12, method: "getMoney" },
      "player scope with playerId on the server",
    );
    rejects(
      schema,
      { side: "server", scope: "player", method: "getMoney" },
      "player scope requires playerId",
    );
    rejects(
      schema,
      { side: "client", scope: "player", playerId: 12, clientId: 1, method: "getMoney" },
      "player scope is server-only",
    );
    rejects(
      schema,
      { side: "server", scope: "framework", playerId: 12, method: "GetJobs" },
      "framework scope forbids playerId",
    );
    rejects(
      schema,
      { side: "client", scope: "framework", method: "GetPlayerData" },
      "client side requires clientId",
    );
    rejects(
      schema,
      { side: "server", scope: "framework", method: "GetJobs", args: { key: "value" } },
      "framework args must be positional arrays",
    );
    rejects(
      schema,
      { side: "server", scope: "framework", method: "constructor" },
      "prototype-polluting method paths rejected",
    );
    rejects(
      schema,
      { side: "server", scope: "framework", method: "Functions.__proto__" },
      "__proto__ path segment rejected",
    );
  }
});

test("ox constrains libraries and oxmysql to the server side", () => {
  accepts(
    OxInputSchema,
    { library: "ox_lib", side: "client", clientId: 2, method: "notify", args: [{ title: "hi" }] },
    "ox_lib notify on a client",
  );
  accepts(
    OxInputSchema,
    { library: "oxmysql", side: "server", method: "query", args: ["SELECT 1"] },
    "oxmysql on the server",
  );
  rejects(
    OxInputSchema,
    { library: "oxmysql", side: "client", clientId: 2, method: "query", args: ["SELECT 1"] },
    "oxmysql is server-only",
  );
  rejects(
    OxInputSchema,
    { library: "ox_inventory", side: "server", method: "x" },
    "unknown library",
  );
  rejects(
    OxInputSchema,
    { library: "ox_lib", side: "client", method: "inputDialog" },
    "client side requires clientId",
  );
});

test("reference limits query length and result size", () => {
  const parsed = ReferenceInputSchema.parse({ query: "GetPlayerFromId" });
  assert.equal(parsed.category, "all");
  assert.equal(parsed.limit, 10);

  accepts(ReferenceInputSchema, { query: "q".repeat(256) }, "query at the 256-char cap");
  rejects(ReferenceInputSchema, { query: "q".repeat(257) }, "query over the cap");
  rejects(ReferenceInputSchema, { query: "" }, "query must be non-empty");
  rejects(ReferenceInputSchema, { query: "q", category: "snippet" }, "unknown category");
  rejects(ReferenceInputSchema, { query: "q", limit: 51 }, "limit above the maximum");
  accepts(
    ReferenceInputSchema,
    { query: "q", category: "native", side: "client" },
    "side filter optional",
  );
});
