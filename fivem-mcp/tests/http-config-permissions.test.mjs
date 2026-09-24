import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('resource config loads with Node filesystem reads denied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-config-permission-'));
  try {
    const outfile = join(dir, 'config.cjs');
    await build({entryPoints:['http-mcp/src/shared/config.ts'],outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.throws(() => fs.readFileSync('config/config.json'), {code:'ERR_ACCESS_DENIED'});
      global.LoadResourceFile = (resource, file) => {
        assert.equal(resource, 'renamed-resource');
        assert.equal(file, 'config/config.json');
        return '{"port":30131}';
      };
      try {
        const config = require(process.argv[1]).loadConfig('renamed-resource');
        assert.equal(config.port, 30131);
      } catch (error) {
        console.error('FIVEAI_MCP config-error ' + JSON.stringify({message:String(error)}));
        process.exitCode = 1;
      }
    `;
    const result = spawnSync(process.execPath, ['--experimental-permission', '--allow-fs-read='+outfile, '-e',script,outfile], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
