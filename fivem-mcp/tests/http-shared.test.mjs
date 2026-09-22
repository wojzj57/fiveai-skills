import test from 'node:test';
import assert from 'node:assert/strict';

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
  const load = text => loadConfig('renamed-resource', (resource, file) => {
    assert.equal(resource, 'renamed-resource');
    assert.equal(file, 'config/config.json');
    return text;
  });
  assert.deepEqual(load(null),{port:30130,clientLogDirectories:[],referenceOnline:true});
  assert.equal(load('{"port":30131}').port,30131);
  for (const text of ['', '{', '{"port":"30131"}', '{"extra":true}', '中'.repeat(6000)]) {
    assert.throws(()=>load(text),/config/i);
  }
  assert.throws(()=>loadConfig('renamed-resource',()=>{throw new Error('read denied');}),/read denied/);
});

test('schema publishes self-contained 2020 schemas and validates tuple arguments', async () => {
  const { validate, schema } = await import('../http-mcp/src/shared/schema.ts');
  assert.equal(validate('execute_jsInput',{side:'server',code:'return 1;'}),true);
  assert.equal(validate('execute_jsInput',{side:'server',clientId:1,code:'return 1;'}),false);
  assert.equal(validate('execute_jsInput',{side:'server',code:'return 1;',approved:true}),false);
  assert.ok(schema('execute_jsOutput').$defs.Task);
});
