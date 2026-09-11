import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryInfoSchema,
  RuntimeFileSchema,
} from "../src/protocol/runtime.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

test("runtime.json is discovery information only", () => {
  assert.deepEqual(
    RuntimeFileSchema.parse({
      version: 1,
      pid: 4242,
      brokerInstanceId: UUID,
      internalProtocol: 1,
      configDigest: "d1",
      startedAt: "2026-09-09T04:35:50.123Z",
    }),
    {
      version: 1,
      pid: 4242,
      brokerInstanceId: UUID,
      internalProtocol: 1,
      configDigest: "d1",
      startedAt: "2026-09-09T04:35:50.123Z",
    },
  );
  assert.equal(
    RuntimeFileSchema.safeParse({
      version: 1,
      pid: -1,
      brokerInstanceId: UUID,
      internalProtocol: 1,
      configDigest: "d1",
      startedAt: "2026-09-09T04:35:50.123Z",
    }).success,
    false,
  );
  assert.equal(
    RuntimeFileSchema.safeParse({
      version: 1,
      pid: 4242,
      brokerInstanceId: UUID,
      internalProtocol: 2,
      configDigest: "d1",
      startedAt: "2026-09-09T04:35:50.123Z",
    }).success,
    false,
  );
});

test("the lifetime-pipe discovery response carries port, protocol, and digest", () => {
  assert.equal(
    DiscoveryInfoSchema.safeParse({
      port: 43189,
      internalProtocol: 1,
      configDigest: "d1",
      brokerInstanceId: UUID,
    }).success,
    true,
  );
  assert.equal(
    DiscoveryInfoSchema.safeParse({
      port: 99999,
      internalProtocol: 1,
      configDigest: "d1",
      brokerInstanceId: UUID,
    }).success,
    false,
  );
});
