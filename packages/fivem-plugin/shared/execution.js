export const MAX_RESULT_BYTES = 256 * 1024;

export function utf8Bytes(text) {
  let size = 0;
  for (const c of text) { const n = c.codePointAt(0); size += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4; }
  return size;
}

function encodingError(code, path) {
  const error = new Error(`${code} at ${path}`);
  error.code = code;
  return error;
}

export function encodeValue(input) {
  const ancestors = new Set();
  let count = 1; // execution-value wrapper
  function visit(value, path, depth) {
    if (++count > 10000 || depth > 32) throw encodingError("RESULT_TOO_LARGE", path);
    if (value === null) return { kind: "null" };
    if (value === undefined) return { kind: "undefined" };
    if (typeof value === "string") {
      if (utf8Bytes(value) > MAX_RESULT_BYTES) throw encodingError("RESULT_TOO_LARGE", path);
      return { kind: "string", value };
    }
    if (typeof value === "boolean") return { kind: "boolean", value };
    if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", value } : { kind: "specialNumber", value: String(value) };
    if (typeof value === "bigint") return { kind: "bigint", value: String(value) };
    if (typeof value !== "object" || ancestors.has(value)) throw encodingError("RESULT_UNSERIALIZABLE", path);
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (value.length + count > 10000) throw encodingError("RESULT_TOO_LARGE", path);
      const array = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor) { count++; array.push({ kind: "hole" }); }
        else if (!("value" in descriptor)) throw encodingError("RESULT_UNSERIALIZABLE", `${path}[${i}]`);
        else array.push(visit(descriptor.value, `${path}[${i}]`, depth + 1));
      }
      result = { kind: "array", value: array };
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw encodingError("RESULT_UNSERIALIZABLE", path);
      const keys = Object.keys(value);
      if (keys.length + count > 10000) throw encodingError("RESULT_TOO_LARGE", path);
      const entries = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw encodingError("RESULT_UNSERIALIZABLE", `${path}.${key}`);
        entries.push({ key, value: visit(descriptor.value, `${path}.${key}`, depth + 1) });
      }
      result = { kind: "object", entries };
    }
    ancestors.delete(value);
    return result;
  }
  const value = visit(input, "$", 0);
  if (utf8Bytes(JSON.stringify({ language: "javascript", value })) > MAX_RESULT_BYTES) throw encodingError("RESULT_TOO_LARGE", "$");
  return value;
}

export function failure(code, message, completed) {
  return { state: "failed", error: { code, message: String(message).slice(0, 4096) }, evidence: { executionCompleted: completed, noRemoteExecution: !completed } };
}

/** Only compiler-produced function expressions arrive here. This is not a sandbox. */
export async function executeJavaScript(expression, args) {
  let fn;
  try {
    fn = (0, eval)(`(${expression}\n)`);
    if (typeof fn !== "function") throw new Error("expected an async function expression");
  } catch (error) { return failure("COMPILATION_ERROR", error?.message ?? "invalid function", false); }
  let value;
  try { value = await fn(args); }
  catch (error) { return failure("EXECUTION_ERROR", error?.stack ?? error?.message ?? "JavaScript threw a value", true); }
  try { return { state: "succeeded", result: { language: "javascript", value: encodeValue(value) } }; }
  catch (error) { return failure(error.code === "RESULT_TOO_LARGE" ? error.code : "RESULT_UNSERIALIZABLE", error.message ?? "encoding failed", true); }
}

/** Cross-language calls stay local to this resource and use a per-call correlation ID. */
export function createExecutor(host, uniqueId) {
  const pending = new Map();
  const resultEvent = `${host.resource}:local:luaResult`;
  host.on(resultEvent, (id, text) => {
    if (typeof id !== "string" || typeof text !== "string" || utf8Bytes(text) > MAX_RESULT_BYTES + 8192) return;
    const resolve = pending.get(id);
    if (!resolve) return;
    try { const value = JSON.parse(text); pending.delete(id); resolve(value); } catch { /* Unknown until valid completion. */ }
  });
  return async (task) => {
    if (task.language === "javascript") return executeJavaScript(task.code, task.args);
    if (task.language !== "lua") return failure("INVALID_ARGUMENT", "unsupported execution language", false);
    const id = uniqueId();
    let encoded;
    try { encoded = JSON.stringify(encodeValue(task.args)); }
    catch { return failure("INVALID_ARGUMENT", "arguments cannot cross the Lua boundary", false); }
    return new Promise(resolve => {
      pending.set(id, resolve);
      host.emit(`${host.resource}:local:executeLua`, id, task.code, encoded, task.id);
    });
  };
}
