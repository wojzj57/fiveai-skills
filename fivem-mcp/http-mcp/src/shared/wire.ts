/** Encode data without invoking getters, toJSON, or class methods. */
import type { JsonValue } from '../tasks/types.ts';
export function encodeValues(values: unknown[]): {kind:'values'; values: JsonValue[]} {
  const seen = new Set<object>();
  let nodes = 0, bytes = 0;
  const count = (value: string): void => { bytes += Buffer.byteLength(value, 'utf8'); if (bytes > 262144) throw new Error('RESULT_TOO_LARGE'); };
  function encode(value: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 32) throw new Error('RESULT_TOO_LARGE');
    if (value === undefined) return {$mcp:'undefined'};
    if (typeof value === 'bigint') {const s=String(value);count(s);return {$mcp:'integer',value:s};}
    if (typeof value === 'number') return Number.isFinite(value) ? value : {$mcp:'number',value:String(value)};
    if (typeof value === 'string') { count(JSON.stringify(value)); return value; }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('RESULT_UNSUPPORTED');
    if (value instanceof Uint8Array) {count('x'.repeat(Math.min(value.byteLength * 2,262145)));return {$mcp:'bytes',base64:Buffer.from(value).toString('base64')};}
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== null && proto !== Object.prototype) throw new Error('RESULT_UNSUPPORTED');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('RESULT_UNSUPPORTED');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(d => !('value' in d))) throw new Error('RESULT_UNSUPPORTED');
    const keys = Object.keys(value);
    if (keys.length > 1024 || (Array.isArray(value) && value.length > 1024)) throw new Error('RESULT_TOO_LARGE');
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = Array.from({length:value.length},(_,i)=>encode(descriptors[String(i)]?.value,depth+1));
    else {
      const entries = keys.map(key=>{count(JSON.stringify(key));return [key,encode(descriptors[key]!.value,depth+1)];});
      result = Object.hasOwn(value,'$mcp') ? {$mcp:'object',entries} : Object.fromEntries(entries);
    }
    seen.delete(value);
    return result;
  }
  const result = {kind:'values' as const,values:values.map(v=>encode(v,0))};
  if (Buffer.byteLength(JSON.stringify(result),'utf8') > 262144) throw new Error('RESULT_TOO_LARGE');
  return result as {kind:'values';values:JsonValue[]};
}
