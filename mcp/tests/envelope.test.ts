import assert from "node:assert/strict";
import test from "node:test";
import {
  MessageEnvelopeSchema,
  MESSAGE_TYPES,
  parseMessage,
} from "../src/protocol/envelope.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "223e4567-e89b-42d3-a456-426614174001";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: UUID,
    type: "ping",
    brokerInstanceId: UUID2,
    sessionId: UUID,
    payload: { nonce: "n1" },
    ...overrides,
  };
}

test("a valid non-hello envelope with both identities parses", () => {
  const parsed = MessageEnvelopeSchema.parse(envelope());
  assert.equal(parsed.type, "ping");
});

test("unknown envelope fields are rejected", () => {
  assert.equal(
    MessageEnvelopeSchema.safeParse(envelope({ extra: true })).success,
    false,
  );
});

test("v must be exactly 1", () => {
  assert.equal(
    MessageEnvelopeSchema.safeParse(envelope({ v: 2 })).success,
    false,
  );
});

test("only hello may omit brokerInstanceId and sessionId", () => {
  assert.equal(
    MessageEnvelopeSchema.safeParse(
      envelope({ type: "hello", brokerInstanceId: undefined, sessionId: undefined, payload: {} }),
    ).success,
    true,
  );
  for (const field of ["brokerInstanceId", "sessionId"] as const) {
    const broken = envelope();
    (broken as Record<string, unknown>)[field] = undefined;
    assert.equal(
      MessageEnvelopeSchema.safeParse(broken).success,
      false,
      `${field} must be required for non-hello messages`,
    );
  }
});

test("payload must be an object", () => {
  assert.equal(
    MessageEnvelopeSchema.safeParse(envelope({ payload: "nope" })).success,
    false,
  );
});

test("parseMessage validates the payload against the type schema", () => {
  const ok = parseMessage(envelope(), "ping");
  assert.deepEqual(ok.payload, { nonce: "n1" });

  assert.throws(() =>
    parseMessage(envelope({ payload: { wrong: true } }), "ping"),
  );
  assert.throws(() =>
    parseMessage(envelope({ type: "welcome" }), "ping"),
  );
});

test("every declared message type has a payload schema", () => {
  assert.equal(MESSAGE_TYPES.length, 20);
  assert.deepEqual(
    MESSAGE_TYPES.filter((type) => type.startsWith("bridge.read.")),
    ["bridge.read.request", "bridge.read.result"],
  );
});
