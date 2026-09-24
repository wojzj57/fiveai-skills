import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import contracts from './contracts.json' with { type: 'json' };
import type { ValidateFunction } from 'ajv';

const ajv = new Ajv2020({ strict: false, allErrors: false, ownProperties: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const definitions = contracts.$defs as Record<string, object>;
const validators = new Map<string, ValidateFunction>();
export function schema(name: string): Record<string, unknown> & { type: 'object' } {
  if (!definitions[name]) throw new Error(`Unknown contract: ${name}`);
  const needed: Record<string, object> = {};
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        const ref = child.replace('#/$defs/', '');
        if (!needed[ref]) { needed[ref] = definitions[ref]!; collect(needed[ref]); }
      } else collect(child);
    }
  }
  collect(definitions[name]);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', ...definitions[name], $defs: needed };
}
export function validate(name: string, value: unknown): boolean {
  let check = validators.get(name);
  if (!check) { check = ajv.compile(schema(name)); validators.set(name, check); }
  return check(value) === true;
}

/** Bound parsed inputs before recursive schema evaluation. */
export function bounded(value: unknown, maxBytes = 65536): void {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 10000 || depth > 32) throw new Error('INPUT_TOO_COMPLEX');
    if (item !== null && typeof item === 'object') {
      const values = Object.values(item);
      if (values.length > 1024) throw new Error('INPUT_TOO_COMPLEX');
      for (const v of values) visit(v, depth + 1);
    }
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw new Error('INPUT_TOO_LARGE');
}

export function parseBounded(text: string): unknown {
  let depth = 0, quoted = false, escaped = false;
  for (const ch of text) {
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') { if (++depth > 32) throw new Error('INPUT_TOO_COMPLEX'); }
    else if (ch === '}' || ch === ']') depth--;
  }
  const value: unknown = JSON.parse(text);
  bounded(value, 256 * 1024);
  return value;
}
