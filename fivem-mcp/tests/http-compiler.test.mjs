import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('ordinary compiler accepts function bodies and rejects imports and syntax errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'compiler path with spaces '));
  try {
    const outfile = join(dir, 'compiler.cjs');
    await build({ entryPoints: ['http-mcp/src/compiler.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const compiler = createRequire(import.meta.url)(outfile);
    assert.equal(typeof compiler.initialize, 'function');
    assert.equal(compiler.initialize().version, '5.9.3');
    const result = compiler.compile({ code: 'const x: number = await Promise.resolve(41); return x + args.n;' });
    assert.equal(result.diagnostics.length, 0);
    const execute = new Function('args', `return (${result.javascript})(args)`);
    assert.equal(await execute({n:1}), 42);
    assert.ok(result.sourceMap);
    for (const code of ['import x from "x";', 'return import("x");', 'return require("x");', 'const x: = ;', 'function inner() { await Promise.resolve(1); }']) {
      assert.ok(compiler.compile({code}).diagnostics.length > 0, code);
    }
    assert.throws(() => compiler.compile({code:'中'.repeat(22000)}), /INPUT_TOO_LARGE/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
