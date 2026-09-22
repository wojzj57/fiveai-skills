import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from './schema.ts';
export interface Config { port: number; clientLogDirectories: string[]; referenceOnline: boolean }
export function loadConfig(resourcePath: string): Config {
  let text: Buffer;
  try { text = readFileSync(join(resourcePath, 'config', 'config.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {port:30130, clientLogDirectories:[], referenceOnline:true};
    throw error;
  }
  if (text.byteLength > 16384) throw new Error('Invalid config: exceeds 16KiB');
  let value: unknown;
  try { value = JSON.parse(text.toString('utf8')); } catch { throw new Error('Invalid config JSON'); }
  if (!validate('Config', value)) throw new Error('Invalid config schema');
  return {port:30130, clientLogDirectories:[], referenceOnline:true, ...value as Partial<Config>};
}
