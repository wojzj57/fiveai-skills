import test from 'node:test';
import assert from 'node:assert/strict';
test('resource mutation protects itself and waits for final state',async()=>{
  const {ResourceController}=await import('../http-mcp/src/execution/resources.ts');
  const states=new Map([['mcp','started'],['example','stopped']]);let starts=0;
  const runtime=new ResourceController('mcp',{run:async f=>f()},{names:()=>[...states.keys()],state:n=>states.get(n)??'missing',start:n=>{starts++;setTimeout(()=>states.set(n,'started'),15);return true;},stop:n=>{states.set(n,'stopped');return true;}});
  assert.throws(()=>runtime.check('stop','mcp'),/SELF_RESOURCE_PROTECTED/);
  assert.throws(()=>runtime.check('start','*'),/RESOURCE_NOT_FOUND/);
  const result=await runtime.change('start','example');
  assert.equal(starts,1);assert.equal(result.change.after,'started');assert.equal(result.change.stages[0].after,'started');
});


test('resource native failures after entering a mutation remain unknown',async()=>{
 const {ResourceController}=await import('../http-mcp/src/execution/resources.ts');
 let mutation=false;
 const runtime=new ResourceController('mcp',{run:async fn=>fn()},{names:()=>['example'],state:()=> 'stopped',start:()=>{mutation=true;throw new Error('host lost after issuing start');},stop:()=>true});
 await assert.rejects(runtime.change('start','example'),error=>error.execution==='unknown');assert.equal(mutation,true);
 const pollFailure=new ResourceController('mcp',{run:async fn=>fn()},{names:()=>['example'],state:()=>{if(mutation)throw new Error('read failed');return 'stopped';},start:()=>{mutation=true;return true;},stop:()=>true});
 mutation=false;await assert.rejects(pollFailure.change('start','example'),error=>error.execution==='unknown');
});
