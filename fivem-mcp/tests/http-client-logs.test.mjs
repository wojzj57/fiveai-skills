import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm,open} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('client logs need a unique marker and never attach preceding lines',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'client-logs-'));const store=new LogStore();const logs=new ClientLogs([dir],store);
 try{await writeFile(join(dir,'CitizenFX.log'),'old\nMARKER\nnew\n');logs.bind(7,'MARKER');await logs.poll();assert.equal(logs.coverage(7).state,'available');assert.deepEqual(store.query({side:'client',clientId:7}).lines.map(l=>l.message),['new']);
 await writeFile(join(dir,'CitizenFX-duplicate.log'),'MARKER\nwrong\n');logs.bind(7,'MARKER');await logs.poll();assert.equal(logs.coverage(7).state,'ambiguous');
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});


test('a bound log survives marker leaving the tail window and detects a newly ambiguous file',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'growing-client-log-')),store=new LogStore();let now=0;const logs=new ClientLogs([dir],store,()=>now);
 try{
  const path=join(dir,'CitizenFX.log');await writeFile(path,'MARKER\nfirst\n');logs.bind(7,'MARKER');await logs.poll();
  await appendFile(path,('x'.repeat(1023)+'\n').repeat(4200));now=6000;await logs.poll();
  assert.equal(logs.coverage(7).state,'available');assert.ok(store.query({side:'client',clientId:7,contains:'first'}).lines.some(line=>line.message==='first'));
  const before=store.query({side:'client',clientId:7,limit:1000}).lines.length;
  await writeFile(join(dir,'CitizenFX-copy.log'),'MARKER\nother\n');now=12000;await logs.poll();
  assert.equal(logs.coverage(7).state,'ambiguous');assert.equal(store.query({side:'client',clientId:7,limit:1000}).lines.length,before);
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});


test('shared scan budgets retain continuous bindings and rotate clients and candidates',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'bounded-log-scan-')),store=new LogStore();let now=0;const logs=new ClientLogs([dir],store,()=>now);
 try{
  await writeFile(join(dir,'CitizenFX-a.log'),'ONE\nfirst\n');logs.bind(7,'ONE');await logs.poll();
  await appendFile(join(dir,'CitizenFX-a.log'),('x'.repeat(1023)+'\n').repeat(4200));
  for(let i=0;i<10;i++){const file=await open(join(dir,'CitizenFX-filler'+i+'.log'),'w');try{await file.truncate(4194304);}finally{await file.close();}}
  await writeFile(join(dir,'CitizenFX-z.log'),'TWO\nsecond\n');logs.bind(8,'TWO');
  for(let i=0;i<15&&!store.query({side:'client',clientId:8,contains:'second'}).lines.length;i++){now+=6000;await logs.poll();}
  assert.ok(['available','partial'].includes(logs.coverage(7).state));
  assert.equal(store.query({side:'client',clientId:8,contains:'second'}).lines.length,1);
  assert.equal(store.query({side:'client',clientId:7,contains:'first'}).lines.length,1);
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});
