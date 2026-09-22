import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompilerRuntime} from '../http-mcp/src/execution/compiler-runtime.ts';

test('a post-return preparation budget faults TS and never returns generated code',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'renamed compiler with spaces '));
 try{
  await mkdir(join(dir,'dist'));
  await writeFile(join(dir,'dist/compiler-runtime.cjs'),`exports.initialize=()=>({version:'5.9.3',warmupMs:1});exports.compile=()=>({javascript:'must not dispatch',diagnostics:[]});`);
  const ticks=[0,1,2,5003],records=[];
  const runtime=new CompilerRuntime(()=>ticks.shift(),data=>records.push(data));
  runtime.initialize(dir);assert.equal(runtime.status().state,'ready');
  assert.throws(()=>runtime.compile('private source'),/PREPARATION_TIMEOUT/);
  assert.equal(runtime.status().state,'faulted');
  assert.throws(()=>runtime.compile('later'),/COMPILER_UNAVAILABLE/);
  assert.equal(JSON.stringify(records).includes('private source'),false);
  runtime.stop();
  const restarted=new CompilerRuntime(()=>1);restarted.initialize(dir);
  assert.equal(restarted.status().state,'ready');restarted.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
