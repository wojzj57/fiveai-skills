import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { utf8ByteLength } from "../src/protocol/utf8.ts";

test("utf8ByteLength matches Buffer.byteLength for representative inputs", () => {
  const samples = [
    "",
    "ascii-only",
    "中文与五笔",
    "emoji \u{1F680} astral \u{10FFFF}",
    "mixed 混合 \t\n control",
    "e\u0301 combining",
  ];
  for (const sample of samples) {
    assert.equal(utf8ByteLength(sample), Buffer.byteLength(sample, "utf8"));
  }
});
