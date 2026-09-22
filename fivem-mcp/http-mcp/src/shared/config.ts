import { validate } from './schema.ts';
export interface Config { port: number; clientLogDirectories: string[]; referenceOnline: boolean }
export function loadConfig(resourceName: string, readResource: (resource: string, file: string) => string | null = LoadResourceFile): Config {
  // Called on the host tick: resource-owned data uses FiveM's resource API,
  // independently of Node's filesystem permission grants or mounted paths.
  const text = readResource(resourceName, 'config/config.json');
  if (text === null) return {port:30130, clientLogDirectories:[], referenceOnline:true};
  if (Buffer.byteLength(text, 'utf8') > 16384) throw new Error('Invalid config: exceeds 16KiB');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid config JSON'); }
  if (!validate('Config', value)) throw new Error('Invalid config schema');
  return {port:30130, clientLogDirectories:[], referenceOnline:true, ...value as Partial<Config>};
}
