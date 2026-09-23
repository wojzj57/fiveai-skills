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

test('HTTP tool contracts describe every field and default logs to one client',async()=>{
  const {validate,schema}=await import('../http-mcp/src/shared/schema.ts');
  const names=['status','queue','execute_lua','execute_js','resource','logs','esx','qbcore','ox','reference'];
  const resultMeaning={status:/Immediate server status snapshot/,queue:/Queue overview, one task, or recovery result/,execute_lua:/Submitted Lua task/,execute_js:/Submitted JavaScript task/,resource:/Resource list or status read, or a submitted change task/,logs:/Matching log lines, separate source coverage/,esx:/Submitted ESX task/,qbcore:/Submitted QBCore task/,ox:/Submitted ox task/,reference:/Immediate reference search results/};
  for(const name of names){
    const input=schema(name+'Input'),output=schema(name+'Output');
    assert.match(output.description,resultMeaning[name],`${name} output meaning`);
    for(const branch of input.oneOf??[input])for(const [key,property] of Object.entries(branch.properties??{}))assert.ok(property.description,`${name}.${key} needs a description`);
  }
  assert.equal(validate('logsInput',{}),true);
  assert.equal(validate('logsInput',{side:'client',clientId:7}),true);
  assert.equal(validate('logsInput',{side:'all'}),true);
  assert.equal(validate('logsInput',{side:'server',clientId:7}),false);
  assert.equal(validate('logsInput',{limit:501}),false);
  assert.equal(validate('resourceInput',{action:'list',name:'example'}),false);
  assert.equal(validate('resourceInput',{action:'status',name:'example'}),true);
  assert.equal(validate('resourceInput',{action:'start'}),false);
  assert.equal(schema('logsInput').oneOf[1].properties.side.default,'client');
});
