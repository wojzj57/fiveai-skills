import { utf8Bytes, MAX_RESULT_BYTES } from "./execution.js";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

/** Validate JSON-decoded client/Lua outcomes before treating them as completion. */
export function validOutcome(value) {
  if (!object(value)) return false;
  if (value.state === "failed") {
    if (!keys(value, ["state", "error", "evidence"]) || !keys(value.error, ["code", "message"]) ||
        !keys(value.evidence, ["executionCompleted", "noRemoteExecution"])) return false;
    const { code, message } = value.error;
    const { executionCompleted: completed, noRemoteExecution: unstarted } = value.evidence;
    if (typeof message !== "string" || utf8Bytes(message) > 16384 || typeof completed !== "boolean" || typeof unstarted !== "boolean" || completed === unstarted) return false;
    if (["COMPILATION_ERROR", "INVALID_ARGUMENT", "TARGET_SESSION_CHANGED"].includes(code)) return unstarted;
    return ["EXECUTION_ERROR", "RESULT_TOO_LARGE", "RESULT_UNSERIALIZABLE"].includes(code) && completed;
  }
  if (value.state !== "succeeded" || !keys(value, ["state", "result"])) return false;
  const result = value.result;
  let nodes;
  if (keys(result, ["language", "returns"]) && result.language === "lua" && Array.isArray(result.returns)) nodes = result.returns;
  else if (keys(result, ["language", "value"]) && result.language === "javascript") nodes = [result.value];
  else return false;
  if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) return false;
  let count = 1;
  const stack = nodes.map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > 10000 || depth > 32 || !object(node)) return false;
    switch (node.kind) {
      case "null": case "nil": case "undefined": case "hole":
        if (!keys(node, ["kind"])) return false; break;
      case "boolean": case "string": case "number":
        if (!keys(node, ["kind", "value"]) || typeof node.value !== node.kind || node.kind === "number" && !Number.isFinite(node.value)) return false; break;
      case "bigint": case "int64":
        if (!keys(node, ["kind", "value"]) || typeof node.value !== "string" || !/^-?\d+$/.test(node.value)) return false;
        if (node.kind === "int64" && (BigInt(node.value) < -(2n ** 63n) || BigInt(node.value) > 2n ** 63n - 1n)) return false;
        break;
      case "specialNumber":
        if (!keys(node, ["kind", "value"]) || !["NaN", "Infinity", "-Infinity"].includes(node.value)) return false; break;
      case "vector":
        if (!keys(node, ["kind", "dimension", "components"]) || ![2, 3, 4].includes(node.dimension) || !Array.isArray(node.components) || node.components.length !== node.dimension || !node.components.every(Number.isFinite)) return false; break;
      case "array":
        if (!keys(node, ["kind", "value"]) || !Array.isArray(node.value) || node.value.length + count > 10000) return false;
        for (const child of node.value) stack.push({ node: child, depth: depth + 1 });
        break;
      case "object": case "map":
        if (!keys(node, ["kind", "entries"]) || !Array.isArray(node.entries) || node.entries.length + count > 10000) return false;
        for (const entry of node.entries) {
          if (!keys(entry, ["key", "value"])) return false;
          if (node.kind === "object") { if (typeof entry.key !== "string") return false; }
          else stack.push({ node: entry.key, depth: depth + 1 });
          stack.push({ node: entry.value, depth: depth + 1 });
        }
        break;
      default: return false;
    }
  }
  return true;
}
