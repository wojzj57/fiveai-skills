const MAX_RESULT_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const MAX_ITEMS = 1_024;
import { utf8ByteLength } from '../../../src/protocol/utf8.ts';

export type ClientWireValue =
  | null
  | boolean
  | number
  | string
  | ClientWireValue[]
  | { [key: string]: ClientWireValue }
  | { $mcp: string; [key: string]: ClientWireValue };

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const bits = (first << 16) | (second << 8) | third;
    output += alphabet[(bits >> 18) & 63];
    output += alphabet[(bits >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(bits >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[bits & 63] : "=";
  }
  return output;
}

export function byteLength(value: string): number {
  return utf8ByteLength(value);
}

/** Browser/FiveM-client encoder. It deliberately has no Node Buffer dependency. */
export function encodeClientValues(values: unknown[]): { kind: "values"; values: ClientWireValue[] } {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const count = (text: string): void => {
    bytes += byteLength(text);
    if (bytes > MAX_RESULT_BYTES) throw new Error("RESULT_TOO_LARGE");
  };
  const encode = (value: unknown, depth: number): ClientWireValue => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("RESULT_TOO_LARGE");
    if (value === undefined) return { $mcp: "undefined" };
    if (typeof value === "bigint") {
      const text = String(value);
      count(text);
      return { $mcp: "integer", value: text };
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : { $mcp: "number", value: String(value) };
    }
    if (typeof value === "string") {
      count(JSON.stringify(value));
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value !== "object" || seen.has(value)) throw new Error("RESULT_UNSUPPORTED");
    if (value instanceof Uint8Array) {
      const encoded = base64(value);
      count(encoded);
      return { $mcp: "bytes", base64: encoded };
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype) {
      throw new Error("RESULT_UNSUPPORTED");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("RESULT_UNSUPPORTED");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
      throw new Error("RESULT_UNSUPPORTED");
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_ITEMS || (Array.isArray(value) && value.length > MAX_ITEMS)) {
      throw new Error("RESULT_TOO_LARGE");
    }
    seen.add(value);
    let result: ClientWireValue;
    if (Array.isArray(value)) {
      result = Array.from({ length: value.length }, (_, index) =>
        encode(descriptors[String(index)]?.value, depth + 1),
      );
    } else {
      const entries = keys.map((key) => {
        count(JSON.stringify(key));
        return [key, encode(descriptors[key]!.value, depth + 1)] as [string, ClientWireValue];
      });
      result = Object.hasOwn(value, "$mcp")
        ? ({ $mcp: "object", entries } as unknown as ClientWireValue)
        : (Object.fromEntries(entries) as ClientWireValue);
    }
    seen.delete(value);
    return result;
  };
  const result = { kind: "values" as const, values: values.map((value) => encode(value, 0)) };
  if (byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new Error("RESULT_TOO_LARGE");
  return result;
}
