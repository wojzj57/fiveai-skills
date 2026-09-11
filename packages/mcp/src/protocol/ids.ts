import { z } from "zod";

/**
 * Shared identity primitives for the v1 internal protocol (RFC §5).
 * Dates on the wire are UTC ISO 8601 strings; durations use monotonic
 * clocks, so only timestamps appear here as strings.
 */

/** UUID v4-shaped identifier used for broker/session/message/task ids. */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** FiveM server IDs, client IDs, and player IDs are positive safe integers (RFC §6.1). */
export const PlayerIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export type PlayerId = z.infer<typeof PlayerIdSchema>;

/**
 * UTC ISO 8601 timestamp (`2026-09-09T12:34:56.789Z`). Validated with an
 * explicit calendar check instead of Date.parse so behavior is identical
 * across desktop Node.js and the FiveM script runtimes (V8's Date.parse
 * accepts rollover dates like Feb 30 and 24:00).
 */
const ISO_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z(?![\s\S])/;

function isValidIsoUtc(value: string): boolean {
  const match = ISO_UTC_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const isLeapYear =
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  return hour <= 23 && minute <= 59 && second <= 59;
}

export const IsoUtcSchema = z.string().superRefine((value, ctx) => {
  if (!isValidIsoUtc(value)) {
    ctx.addIssue({
      code: "custom",
      message: "expected a valid UTC ISO 8601 timestamp",
    });
  }
});
export type IsoUtc = z.infer<typeof IsoUtcSchema>;

/** Monotonic duration in milliseconds (RFC §5.1: 耗时使用单调时钟). */
export const DurationMsSchema = z.number().int().min(0);
export type DurationMs = z.infer<typeof DurationMsSchema>;

/**
 * Epoch identity assigned by the bridge per client registration and per
 * bridge start (RFC §5.2). Opaque unique string for contract purposes.
 */
export const EpochSchema = z.string().min(8).max(64);
export type Epoch = z.infer<typeof EpochSchema>;
