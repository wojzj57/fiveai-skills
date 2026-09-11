import { z } from "zod";
import { IsoUtcSchema, UuidSchema } from "./ids.ts";

/**
 * Broker discovery records (RFC §4.2). runtime.json is discovery
 * information only — an entry must still verify the instance through the
 * authenticated WebSocket handshake before trusting it; a PID or a file's
 * presence never proves validity. The lifetime named pipe exposes the same
 * summary read-only to competing entries.
 */

export const RuntimeFileSchema = z.strictObject({
  version: z.literal(1),
  pid: z.number().int().positive(),
  brokerInstanceId: UuidSchema,
  internalProtocol: z.literal(1),
  configDigest: z.string().min(1),
  startedAt: IsoUtcSchema,
});

/** Read-only lifetime pipe discovery response (RFC §4.2). */
export const DiscoveryInfoSchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  internalProtocol: z.literal(1),
  configDigest: z.string().min(1),
  brokerInstanceId: UuidSchema,
});

export type RuntimeFile = z.infer<typeof RuntimeFileSchema>;
export type DiscoveryInfo = z.infer<typeof DiscoveryInfoSchema>;
