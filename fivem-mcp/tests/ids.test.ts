import assert from "node:assert/strict";
import test from "node:test";
import {
  DurationMsSchema,
  EpochSchema,
  IsoUtcSchema,
  PlayerIdSchema,
  UuidSchema,
} from "../src/protocol/ids.ts";

test("ISO 8601 UTC timestamps must be calendar-valid", () => {
  const valid = [
    "2026-09-09T04:35:50Z",
    "2026-09-09T04:35:50.123Z",
    "2024-02-29T23:59:59Z", // leap day
    "2000-02-29T00:00:00Z", // century leap year
    "0001-01-01T00:00:00Z",
  ];
  for (const value of valid) {
    assert.equal(IsoUtcSchema.safeParse(value).success, true, `${value} should parse`);
  }

  const invalid = [
    "2026-13-01T00:00:00Z", // month 13
    "2026-00-10T00:00:00Z", // month 0
    "2026-02-30T00:00:00Z", // Feb 30 rolls over in Date.parse but is invalid
    "2023-02-29T00:00:00Z", // non-leap Feb 29
    "2026-04-31T00:00:00Z", // April 31
    "2026-09-09T24:00:00Z", // hour 24 is an ISO extension; not accepted here
    "2026-09-09T00:60:00Z",
    "2026-09-09T00:00:60Z",
    "2026-09-09 04:35:50Z", // missing T
    "2026-09-09T04:35:50+00:00", // offsets are not the Z form
    "2026-09-09T04:35:50", // missing Z
    "2026-09-09T04:35:50Z\n", // trailing newline must not satisfy the anchor
    "not-a-timestamp",
  ];
  for (const value of invalid) {
    assert.equal(IsoUtcSchema.safeParse(value).success, false, `${value} must be rejected`);
  }
});

test("player/client/server IDs are positive safe integers", () => {
  assert.equal(PlayerIdSchema.safeParse(1).success, true);
  assert.equal(PlayerIdSchema.safeParse(Number.MAX_SAFE_INTEGER).success, true);
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7", null]) {
    assert.equal(PlayerIdSchema.safeParse(bad).success, false, `${String(bad)} must be rejected`);
  }
});

test("durations are non-negative integer milliseconds", () => {
  assert.equal(DurationMsSchema.safeParse(0).success, true);
  assert.equal(DurationMsSchema.safeParse(-1).success, false);
  assert.equal(DurationMsSchema.safeParse(1.5).success, false);
});

test("epochs are opaque bounded strings", () => {
  assert.equal(EpochSchema.safeParse("epoch-0123456789").success, true);
  assert.equal(EpochSchema.safeParse("short").success, false);
  assert.equal(EpochSchema.safeParse("x".repeat(65)).success, false);
});

test("uuids must be well-formed", () => {
  assert.equal(UuidSchema.safeParse("123e4567-e89b-42d3-a456-426614174000").success, true);
  assert.equal(UuidSchema.safeParse("not-a-uuid").success, false);
  assert.equal(UuidSchema.safeParse("123e4567-e89b-42d3-a456-4266141740g").success, false);
});
