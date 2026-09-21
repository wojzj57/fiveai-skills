import { z } from "zod";
import { UuidSchema } from "./ids.ts";
import {
  ApprovalRequestSchema,
  ApprovalResultSchema,
  BridgeReadRequestSchema,
  BridgeReadResultSchema,
  ClientsSnapshotSchema,
  ControlRequestSchema,
  ControlResultSchema,
  HelloSchema,
  LogsBatchSchema,
  PongSchema,
  PingSchema,
  TaskAcceptedSchema,
  TaskDispatchSchema,
  TaskReceivedSchema,
  TaskResultAckSchema,
  TaskResultSchema,
  TaskStatusQuerySchema,
  TaskStatusResultSchema,
  TaskSubmitSchema,
  WelcomeSchema,
} from "./messages.ts";

/**
 * v1 internal message envelope (RFC §5.1). Unknown fields are rejected and
 * v must be exactly 1. Before the handshake completes, only `hello` may omit
 * brokerInstanceId/sessionId; afterwards the broker assigns/binds identities
 * and every other message carries both. `id` correlates request/response
 * messages; task execution uses `taskId` inside payloads — the two must not
 * be mixed. Dates are UTC ISO 8601; durations use monotonic clocks.
 */

export const MESSAGE_TYPES = [
  "hello",
  "welcome",
  "ping",
  "pong",
  "task.submit",
  "task.accepted",
  "task.dispatch",
  "task.received",
  "task.result",
  "task.resultAck",
  "task.status",
  "task.statusResult",
  "approval.request",
  "approval.result",
  "logs.batch",
  "clients.snapshot",
  "control.request",
  "control.result",
  "bridge.read.request",
  "bridge.read.result",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

const PAYLOAD_SCHEMAS = {
  hello: HelloSchema,
  welcome: WelcomeSchema,
  ping: PingSchema,
  pong: PongSchema,
  "task.submit": TaskSubmitSchema,
  "task.accepted": TaskAcceptedSchema,
  "task.dispatch": TaskDispatchSchema,
  "task.received": TaskReceivedSchema,
  "task.result": TaskResultSchema,
  "task.resultAck": TaskResultAckSchema,
  "task.status": TaskStatusQuerySchema,
  "task.statusResult": TaskStatusResultSchema,
  "approval.request": ApprovalRequestSchema,
  "approval.result": ApprovalResultSchema,
  "logs.batch": LogsBatchSchema,
  "clients.snapshot": ClientsSnapshotSchema,
  "control.request": ControlRequestSchema,
  "control.result": ControlResultSchema,
  "bridge.read.request": BridgeReadRequestSchema,
  "bridge.read.result": BridgeReadResultSchema,
} as const satisfies Record<MessageType, z.ZodType>;

/** Every message type maps to exactly one payload schema (drift guard). */
export const MESSAGE_PAYLOAD_SCHEMAS: Readonly<
  Record<MessageType, z.ZodType>
> = PAYLOAD_SCHEMAS;

export type MessagePayloadOf<T extends MessageType> = z.infer<
  (typeof PAYLOAD_SCHEMAS)[T]
>;

export const MessageEnvelopeSchema = z
  .strictObject({
    v: z.literal(1),
    id: UuidSchema,
    type: z.enum(MESSAGE_TYPES),
    brokerInstanceId: UuidSchema.optional(),
    sessionId: UuidSchema.optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .superRefine((envelope, ctx) => {
    if (envelope.type === "hello") return;
    if (envelope.brokerInstanceId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["brokerInstanceId"],
        message: "only hello may omit brokerInstanceId before the handshake",
      });
    }
    if (envelope.sessionId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionId"],
        message: "only hello may omit sessionId before the handshake",
      });
    }
  });

export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export type TypedMessage<T extends MessageType> = Omit<
  MessageEnvelope,
  "type" | "payload"
> & {
  type: T;
  payload: MessagePayloadOf<T>;
};

/** Any parsed message, discriminated by `type` (usable in switch narrowing). */
export type AnyTypedMessage = {
  [T in MessageType]: TypedMessage<T>;
}[MessageType];

/**
 * Parse an envelope and validate its payload against the schema registered
 * for its message type. Throws a ZodError on any violation.
 */
export function parseMessage(value: unknown): AnyTypedMessage;
export function parseMessage<T extends MessageType>(
  value: unknown,
  expectedType: T,
): TypedMessage<T>;
export function parseMessage(
  value: unknown,
  expectedType?: MessageType,
): AnyTypedMessage {
  const envelope = MessageEnvelopeSchema.parse(value);
  if (expectedType !== undefined && envelope.type !== expectedType) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["type"],
        message: `expected message type ${expectedType}, got ${envelope.type}`,
      },
    ]);
  }
  const payload = PAYLOAD_SCHEMAS[envelope.type].parse(envelope.payload);
  return {
    ...envelope,
    type: envelope.type,
    payload,
  } as AnyTypedMessage;
}
