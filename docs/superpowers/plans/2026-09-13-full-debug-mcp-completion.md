# FiveAI Full Debug MCP Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement and validate the ten-tool FiveAI MCP runtime defined by the approved full-debug completion RFC.

**Architecture:** A single local Broker owns the global FIFO, durable recovery evidence, control-plane reads, approvals, TypeScript preparation, and strict tool routing. The FiveM resource validates versioned plans again, performs all host operations from host ticks, and retains terminal results until an acknowledged digest is durably reconciled.

**Tech Stack:** Node.js 22, TypeScript 5.9.3 Compiler API, MCP SDK 1.30.0, Fastify 5.12.3, ws 8.21.3, Zod 4.5.4, node-sql-parser 5.4.0, FiveM JavaScript/Lua runtimes, Node test runner.

**Spec:** `notes/fivem-mcp/rfcs/full-debug-mcp-completion-rfc.md`

## Global Constraints

- Register exactly `status`, `queue`, `execute_lua`, `execute_ts`, `resource`, `logs`, `esx`, `qbcore`, `ox`, and `reference`.
- Use internal protocol v2 and recovery file v2; keep public tool inputs and config version 1 compatible.
- Keep one global side-effect FIFO with at most 100 queued and one running-or-unknown slot; control reads stay responsive while execution is blocked.
- Persist dispatch intent, start intent, settled result digest, and result acknowledgement in that order; never replay uncertain execution.
- Validate at entry, Broker, and resource boundaries; never expose server execution through a client-triggerable network event.
- Run TypeScript preparation in a worker and ship TypeScript plus node-sql-parser inside the standalone Broker bundle.
- Do not start or stop FxDK/FXServer, install project resources, change framework configuration, or write a database without separate authorization.
- Build and process tests must use disposable fixtures and must not overwrite `dist/fiveai-mcp` or contend with a live user Broker.
- This invocation did not request commits; commit steps are intentionally omitted.

---

### Task 1: Protocol v2, digests, outputs, and recovery schema

**Files:**
- Create: `packages/mcp/src/protocol/digests.ts`
- Create: `packages/mcp/src/tools/outputs.ts`
- Modify: `packages/mcp/src/protocol/envelope.ts`
- Modify: `packages/mcp/src/protocol/messages.ts`
- Modify: `packages/mcp/src/protocol/runtime.ts`
- Modify: `packages/mcp/src/protocol/recovery.ts`
- Modify: `packages/mcp/src/protocol/close-codes.ts`
- Modify: `packages/mcp/src/protocol/errors.ts`
- Modify: `packages/mcp/src/protocol/limits.ts`
- Test: `packages/mcp/tests/digests.test.ts`
- Test: `packages/mcp/tests/messages.test.ts`
- Test: `packages/mcp/tests/recovery.test.ts`
- Test: `packages/mcp/tests/outputs.test.ts`

**Interfaces:**
- Produces: `digestTaskPayload`, `digestTaskResult`, `digestApproval`, `digestAdapterManifest`, strict v2 message schemas, `RecoveryFileV2Schema`, and strict output schemas keyed by `ToolName`.
- Consumes: existing input schemas, UUID schemas, JSON bounds, and the RFC's execution-binding/state unions.

- [ ] **Step 1: Write failing contract tests**

```ts
assert.equal(digest("task-payload", left), digest("task-payload", reordered));
assert.notEqual(digest("task-payload", left), digest("approval", left));
assert.equal(RecoveryFileV2Schema.safeParse(validReleasedUnknown).success, true);
assert.equal(AnyMessageSchema.safeParse(validTaskResultAcked).success, true);
```

- [ ] **Step 2: Run focused tests and confirm v1-only contracts fail**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/digests.test.ts tests/messages.test.ts tests/recovery.test.ts tests/outputs.test.ts
```

- [ ] **Step 3: Implement strict v2 schemas and canonical digest helpers**

```ts
export function protocolDigest(domain: DigestDomain, value: unknown): string {
  const canonical = canonicalizeStrict(value);
  return createHash("sha256").update(`fiveai-mcp:${domain}:v1\0`, "utf8").update(canonical, "utf8").digest("hex");
}
```

- [ ] **Step 4: Re-run focused tests**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/digests.test.ts tests/messages.test.ts tests/recovery.test.ts tests/outputs.test.ts
```

### Task 2: Catalog and MCP entry routing with elicitation

**Files:**
- Create: `packages/mcp/src/tools/catalog.ts`
- Create: `packages/mcp/src/cli/elicitation.ts`
- Modify: `packages/mcp/src/tools/registry.ts`
- Modify: `packages/mcp/src/cli/entry.ts`
- Test: `packages/mcp/tests/catalog.test.ts`
- Test: `packages/mcp/tests/entry-cli.test.ts`
- Test: `packages/mcp/tests/elicitation.test.ts`

**Interfaces:**
- Consumes: `TOOL_OUTPUT_SCHEMAS`, input schemas, protocol v2 messages, Broker control/task/approval replies.
- Produces: exact ten-tool list, generic tools/call routing, post-initialize immutable form capability, and exactly-once approval completion.

- [ ] **Step 1: Add failing list/call/approval tests**

```ts
assert.deepEqual(listed.map(tool => tool.name), EXPECTED_TOOL_NAMES);
assert.equal(noFormResult.error.code, "APPROVAL_UNSUPPORTED");
assert.equal(abortedApproval.submittedTaskCount, 0);
```

- [ ] **Step 2: Run the entry tests and observe status-only behavior fail**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/catalog.test.ts tests/entry-cli.test.ts tests/elicitation.test.ts
```

- [ ] **Step 3: Implement catalog-driven handlers and lazy post-initialize Broker connection**

```ts
server.oninitialized = () => link.setCapabilities(readFormCapability(server.getClientCapabilities()));
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_CATALOG.map(toMcpDefinition) }));
server.setRequestHandler(CallToolRequestSchema, (request, extra) => routeToolCall(request.params, extra.signal));
```

- [ ] **Step 4: Verify entry routing and cancellation**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/catalog.test.ts tests/entry-cli.test.ts tests/elicitation.test.ts
```

### Task 3: Durable FIFO scheduler and Broker integration

**Files:**
- Create: `packages/mcp/src/scheduler/task-store.ts`
- Create: `packages/mcp/src/scheduler/scheduler.ts`
- Create: `packages/mcp/src/scheduler/recovery.ts`
- Modify: `packages/mcp/src/broker/recovery-store.ts`
- Modify: `packages/mcp/src/broker/server.ts`
- Test: `packages/mcp/tests/scheduler.test.ts`
- Test: `packages/mcp/tests/recovery-store.test.ts`
- Test: `packages/mcp/tests/process/broker-process.test.ts`

**Interfaces:**
- Consumes: validated tool requests, execution plans, v2 bindings/digests, bridge snapshots and task lifecycle messages.
- Produces: `submit`, `cancel`, `status`, `recover`, one-at-a-time dispatch/start, terminal result waiters, and durable reconciliation.

- [ ] **Step 1: Add failing FIFO, crash-boundary, cancellation, and unknown-block tests**

```ts
assert.deepEqual(dispatches.map(item => item.sequence), [1, 2, 3]);
assert.equal(cancelQueued.state, "cancelled");
assert.equal(afterStartTimeout.state, "unknown");
assert.equal(scheduler.canDispatch, false);
```

- [ ] **Step 2: Run scheduler and Broker process tests**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/scheduler.test.ts tests/recovery-store.test.ts tests/process/broker-process.test.ts
```

- [ ] **Step 3: Implement the state machine and atomic recovery transitions**

```ts
await recovery.saveDispatchIntent(task);
sendDispatch(task);
await recovery.saveStartIntent(task);
sendStart(task);
await recovery.saveSettled(result);
sendResultAck(result);
```

- [ ] **Step 4: Re-run scheduler and process tests serially**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test --test-concurrency=1 tests/scheduler.test.ts tests/recovery-store.test.ts tests/process/broker-process.test.ts
```

### Task 4: TypeScript worker and strict execution plans

**Files:**
- Create: `packages/mcp/src/execution/plans.ts`
- Create: `packages/mcp/src/execution/typescript-worker.ts`
- Create: `packages/mcp/src/execution/typescript.ts`
- Modify: `packages/mcp/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `packages/mcp/tests/typescript.test.ts`
- Test: `packages/mcp/tests/execution-plans.test.ts`

**Interfaces:**
- Consumes: validated public fragment/adapter/resource inputs and task binding.
- Produces: versioned `ExecutionPlan`, compiler-produced JavaScript expression, source map, and mapped error frames.

- [ ] **Step 1: Add failing compiler security and mapping tests**

```ts
await assert.rejects(() => compile("import('x')"), /COMPILATION_ERROR/);
assert.match((await runMapped("const 尾='值';\nthrow new Error('x')")).stack, /:2:/);
assert.equal(await controlPingDuringCompile(maxInput), "ok");
```

- [ ] **Step 2: Run compiler tests and confirm the module is absent**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/typescript.test.ts tests/execution-plans.test.ts
```

- [ ] **Step 3: Add fixed TypeScript/node-sql-parser dependencies and implement the worker boundary**

```ts
const output = sourceText.slice(0, expression.end);
return { javascript: output, sourceMap: transpiled.sourceMapText, virtualSource };
```

- [ ] **Step 4: Verify compiler behavior and type safety**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/typescript.test.ts tests/execution-plans.test.ts
```

### Task 5: FiveM task bridge, server/client execution, and resource control

**Files:**
- Create: `packages/fivem-plugin/shared/protocol.js`
- Create: `packages/fivem-plugin/shared/adapters.lua`
- Modify: `packages/fivem-plugin/server/main.js`
- Modify: `packages/fivem-plugin/client/main.js`
- Modify: `packages/fivem-plugin/shared/execution.js`
- Modify: `packages/fivem-plugin/shared/executor.lua`
- Modify: `packages/fivem-plugin/fxmanifest.lua`
- Test: `packages/mcp/tests/resource.test.ts`
- Test: `packages/mcp/tests/fixtures/lua-executor-check.py`

**Interfaces:**
- Consumes: strict v2 messages and plans from Broker.
- Produces: host-tick ready/start execution, server/client result cache, digest acknowledgements, resource read/mutation results, and generation snapshots.

- [ ] **Step 1: Extend the VM/Lua harness with ready/start, binding, cache, and resource lifecycle failures**

```ts
assert.equal(eventsBeforeStart.includes("executed"), false);
assert.equal(eventsAfterStart.filter(event => event === "executed").length, 1);
assert.equal(selfRestart.error.code, "SELF_RESOURCE_PROTECTED");
```

- [ ] **Step 2: Run the resource and Lua harness tests**

```powershell
pnpm run build:resource
pnpm --filter fiveai-mcp exec node --test tests/resource.test.ts
py -3 -X utf8 packages/mcp/tests/fixtures/lua-executor-check.py
```

- [ ] **Step 3: Implement authenticated task routing and host-tick execution**

```js
incoming.push({ kind: "task.dispatch", plan });
onHostTick(() => prepare(plan));
onHostTick(() => executeOnlyAfterMatchingStart(plan));
```

- [ ] **Step 4: Verify resource bundles and executor boundaries**

```powershell
pnpm run build:resource
pnpm --filter fiveai-mcp exec node --test tests/resource.test.ts
py -3 -X utf8 packages/mcp/tests/fixtures/lua-executor-check.py
```

### Task 6: Framework and ox adapter manifest

**Files:**
- Create: `packages/mcp/src/data/adapters/manifest.json`
- Create: `packages/mcp/src/adapters/manifest.ts`
- Create: `packages/fivem-plugin/shared/framework-adapters.lua`
- Test: `packages/mcp/tests/adapters.test.ts`
- Test: `packages/mcp/tests/resource.test.ts`

**Interfaces:**
- Consumes: `adapterCall` plans, exact manifest key, generation, side, player/client binding, and JSON args.
- Produces: fixed ESX/QBCore/ox_lib/ox_target/oxmysql method invocation plus bounded projected values.

- [ ] **Step 1: Add table-driven tests for every RFC method and error path**

```ts
for (const method of REQUIRED_METHODS) assert.ok(manifest.byKey(method));
assert.equal(invokePrototypePath.error.code, "METHOD_UNSUPPORTED");
assert.equal(staleGeneration.error.code, "TARGET_CHANGED");
```

- [ ] **Step 2: Run adapter tests**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/adapters.test.ts tests/resource.test.ts
```

- [ ] **Step 3: Implement fixed Lua closures and result projections without arbitrary reflection**

```lua
local handler = manifest[plan.manifestKey]
if not handler then return failure('METHOD_UNSUPPORTED', false) end
return handler(plan.args, plan.binding)
```

- [ ] **Step 4: Verify manifests, digest, resource generation, and projections**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/adapters.test.ts tests/resource.test.ts
```

### Task 7: SQL classification and approval binding

**Files:**
- Create: `packages/mcp/src/adapters/sql-classifier.ts`
- Create: `packages/mcp/src/adapters/database-call.ts`
- Modify: `packages/mcp/src/cli/elicitation.ts`
- Modify: `packages/mcp/src/broker/server.ts`
- Test: `packages/mcp/tests/sql-classifier.test.ts`
- Test: `packages/mcp/tests/elicitation.test.ts`

**Interfaces:**
- Consumes: oxmysql method/SQL/parameters and immutable target generation.
- Produces: conservative read-only classification or a one-use, 300-second, digest-bound approval.

- [ ] **Step 1: Add parser boundary and tamper/cancel tests**

```ts
assert.equal(classify("SELECT COUNT(*) FROM t").confirmationRequired, false);
assert.equal(classify("SELECT * FROM t FOR UPDATE").confirmationRequired, true);
assert.equal(tamperedApproval.error.code, "APPROVAL_INVALID");
```

- [ ] **Step 2: Run SQL and elicitation tests**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/sql-classifier.test.ts tests/elicitation.test.ts
```

- [ ] **Step 3: Implement the allowlist classifier and immutable approval record**

```ts
const classification = classifyDatabaseCall(call);
if (classification.confirmationRequired) await approvals.confirm(call, binding, signal);
return scheduler.submit(compileAdapterCall(call, binding));
```

- [ ] **Step 4: Verify all database calls either safely classify or require confirmation**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/sql-classifier.test.ts tests/elicitation.test.ts
```

### Task 8: Logs and reference control planes

**Files:**
- Create: `packages/mcp/src/logs/store.ts`
- Create: `packages/mcp/src/logs/client-tail.ts`
- Create: `packages/mcp/src/reference/search.ts`
- Create: `packages/mcp/src/reference/official-fallback.ts`
- Create: `packages/mcp/src/data/reference/index.json`
- Modify: `packages/fivem-plugin/server/main.js`
- Test: `packages/mcp/tests/logs.test.ts`
- Test: `packages/mcp/tests/reference.test.ts`

**Interfaces:**
- Consumes: validated log batches, client session markers, configured client log directory, reference queries.
- Produces: bounded log records/coverage gaps and stable local-first reference results with official-host-only fallback.

- [ ] **Step 1: Add failing stream, mapping, rotation, filtering, and local-first tests**

```ts
assert.deepEqual(query({ prefix: "x", contains: "y" }).records, expectedIntersection);
assert.equal(sharedClientMapping.error.code, "LOG_MAPPING_FAILED");
assert.equal(localHit.networkRequests, 0);
```

- [ ] **Step 2: Run log/reference tests**

```powershell
pnpm --filter fiveai-mcp exec node --test tests/logs.test.ts tests/reference.test.ts
```

- [ ] **Step 3: Implement bounded stores, byte decoders, session mapping, search, and guarded fallback**

```ts
const filtered = records.filter(matchesAllFilters).slice(-limit);
if (local.length > 0) return local;
return fetchOfficialWithinBudget(query, OFFICIAL_ALLOWLIST);
```

- [ ] **Step 4: Verify bounds and zero persistent online cache**

```powershell
pnpm --filter fiveai-mcp run typecheck
pnpm --filter fiveai-mcp exec node --test tests/logs.test.ts tests/reference.test.ts
```

### Task 9: Unified artifact and operator documentation

**Files:**
- Modify: `scripts/build-unified.mjs`
- Modify: `packages/fivem-plugin/scripts/build-resource.mjs`
- Modify: `packages/fivem-plugin/README.md`
- Modify: `tests/unified-pack.test.mjs`
- Modify: `tests/helpers/unified-fixture.mjs`
- Test: `tests/unified-pack.test.mjs`
- Test: `tests/unified-fixture-preservation.test.mjs`

**Interfaces:**
- Consumes: Broker bundle, resource files, compiler/parser/adapter/reference inputs.
- Produces: preserved install directory, standalone ZIP, deterministic build identity, and migration/rollback guidance.

- [ ] **Step 1: Add standalone TS/reference/SQL and preservation assertions**

```js
assert.equal(await unpacked.call("execute_ts", sample), expected);
assert.ok((await unpacked.call("reference", query)).records.length > 0);
assert.deepEqual(readBytesAfterBuild(userOwnedPaths), before);
```

- [ ] **Step 2: Run fixture-only pack tests**

```powershell
node --test tests/unified-pack.test.mjs tests/unified-fixture-preservation.test.mjs
```

- [ ] **Step 3: Update explicit build inputs/whitelists and migration documentation**

```js
const brokerInputs = ["typescript", "node-sql-parser", "src/data/adapters", "src/data/reference"];
assertNoUserOwnedPathInReplacementSet();
```

- [ ] **Step 4: Verify build and pack entirely inside disposable fixtures**

```powershell
node --test tests/unified-pack.test.mjs tests/unified-fixture-preservation.test.mjs
```

### Task 10: Full automated validation and exact working-tree review

**Files:**
- Modify: `notes/fivem-mcp/rfcs/full-debug-mcp-completion-rfc.md`
- Review: every path touched by Tasks 1–9 and this plan

**Interfaces:**
- Consumes: the completed implementation and A01–A16 test evidence.
- Produces: validated working tree plus an independent review verdict; H01–H14 remain NOT_EXECUTED unless separately authorized.

- [ ] **Step 1: Confirm no live user Broker owns the SID lifetime pipe**

```powershell
# Use the repository's read-only probeLifetimePipe; do not close an occupied pipe.
pnpm --filter fiveai-mcp exec tsx -e "import('./src/broker/pipes.ts').then(async m=>console.log(await m.probeLifetimePipe((await m.brokerPipeNames()).lifetime)))"
```

- [ ] **Step 2: Run focused and complete serial validation**

```powershell
pnpm run test
pnpm run test:mcp
pnpm run validate
py -3 -X utf8 packages/mcp/tests/fixtures/lua-executor-check.py
git diff --check
```

- [ ] **Step 3: Verify RFC coverage and forbidden placeholders**

```powershell
rg -n "scheduler not implemented|adapter manifest not implemented|internal/v1" packages/mcp/src packages/fivem-plugin
rg -n "status|queue|execute_lua|execute_ts|resource|logs|esx|qbcore|ox|reference" packages/mcp/src/tools/catalog.ts
```

- [ ] **Step 4: Invoke mandatory independent review of the exact touched paths**

```text
$code-review working-tree --paths <every exact touched path from this invocation>
```

- [ ] **Step 5: Record truthful host limitations**

```text
H01-H14 = NOT_EXECUTED unless the user separately authorizes host startup, framework changes, dependency installation, test identities, database writes, and cleanup.
```
