import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('wire encoding preserves reserved keys and rejects accessors without invoking them', async () => {
  const { encodeValues } = await import('../http-mcp/src/shared/wire.ts');
  assert.deepEqual(encodeValues([undefined, 42n, NaN, {$mcp:'nil'}]), {kind:'values',values:[{$mcp:'undefined'},{$mcp:'integer',value:'42'},{$mcp:'number',value:'NaN'},{$mcp:'object',entries:[['$mcp','nil']]}]});
  let accessed = false;
  assert.throws(()=>encodeValues([{get x(){accessed=true;return 1;}}]), /RESULT_UNSUPPORTED/);
  assert.equal(accessed,false);
  const cycle={};cycle.self=cycle;
  assert.throws(()=>encodeValues([cycle]), /RESULT_UNSUPPORTED/);
  assert.throws(()=>encodeValues(['x'.repeat(262144)]), /RESULT_TOO_LARGE/);
});

test('config is strict, bounded and defaults only when absent', async () => {
  const { loadConfig } = await import('../http-mcp/src/shared/config.ts');
  const dir=await mkdtemp(join(tmpdir(),'mcp-config-'));
  try {
    assert.deepEqual(loadConfig(dir),{port:30130,clientLogDirectories:[],referenceOnline:true});
    await mkdir(join(dir,'config'));
    await writeFile(join(dir,'config/config.json'),'{"port":30131}');
    assert.equal(loadConfig(dir).port,30131);
    await writeFile(join(dir,'config/config.json'),'{"port":"30131"}');
    assert.throws(()=>loadConfig(dir),/config/i);
    await writeFile(join(dir,'config/config.json'),'{"extra":true}');
    assert.throws(()=>loadConfig(dir),/config/i);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('schema publishes self-contained 2020 schemas and validates tuple arguments', async () => {
  const { validate, schema } = await import('../http-mcp/src/shared/schema.ts');
  assert.equal(validate('execute_tsInput',{side:'server',code:'return 1;'}),true);
  assert.equal(validate('execute_tsInput',{side:'server',clientId:1,code:'return 1;'}),false);
  assert.equal(validate('execute_tsInput',{side:'server',code:'return 1;',approved:true}),false);
  assert.ok(schema('execute_tsOutput').$defs.Task);
});
