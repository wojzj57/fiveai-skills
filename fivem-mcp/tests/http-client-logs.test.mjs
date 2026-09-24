import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm,open} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';

test('latest game load excludes earlier sessions and binding credentials',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'client-load-boundary-')),store=new LogStore(),logs=new ClientLogs([dir],store);
 const marker='FIVEM_MCP_BIND:test-secret';
 try{
  await writeFile(join(dir,'CitizenFX.log'),'Game finished loading!\n[script:exnui] previous session\nGame finished loading!\n[script:exnui] startup\n'+marker+'\n[script:exnui] current\n');
  logs.bind(7,marker);await logs.poll();
  assert.deepEqual(store.query({side:'client',resource:'exnui',includeRaw:true}).lines.map(x=>x.message),['startup','current']);
  assert.ok(!JSON.stringify(store.query({side:'client',includeRaw:true})).includes('test-secret'));
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});

test('a binding without a game load boundary does not claim complete history',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'client-no-load-')),store=new LogStore(),logs=new ClientLogs([dir],store);
 try{await writeFile(join(dir,'CitizenFX.log'),'MARKER\n[script:exnui] unknown session\n');logs.bind(7,'MARKER');await logs.poll();assert.equal(logs.coverage(7).state,'unlocated');assert.equal(store.query({side:'client'}).lines.length,0);}
 finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});
test('client logs replay since the last game load, including lines preceding binding',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'client-logs-'));const store=new LogStore();const logs=new ClientLogs([dir],store);
 try{await writeFile(join(dir,'CitizenFX.log'),'old\n[  1] [fxdk_b3258_Gam] MainThrd/ ^2Game finished loading!\n[exnui] startup\nMARKER\nnew\n');logs.bind(7,'MARKER');await logs.poll();assert.equal(logs.coverage(7).state,'available');assert.deepEqual(store.query({side:'client',clientId:7}).lines.map(l=>l.message),['[exnui] startup','MARKER','new']);
 await writeFile(join(dir,'CitizenFX-duplicate.log'),'MARKER\nwrong\n');logs.bind(7,'MARKER');await logs.poll();assert.equal(logs.coverage(7).state,'ambiguous');
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});


test('a bound log survives marker leaving the tail window and detects a newly ambiguous file',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const dir=await mkdtemp(join(tmpdir(),'growing-client-log-')),store=new LogStore();let now=0;const logs=new ClientLogs([dir],store,()=>now);
 try{
  const path=join(dir,'CitizenFX.log');await writeFile(path,'Game finished loading!\nMARKER\nfirst\n');logs.bind(7,'MARKER');await logs.poll();
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
  await writeFile(join(dir,'CitizenFX-a.log'),'Game finished loading!\nONE\nfirst\n');logs.bind(7,'ONE');await logs.poll();
  await appendFile(join(dir,'CitizenFX-a.log'),('x'.repeat(1023)+'\n').repeat(4200));
  for(let i=0;i<10;i++){const file=await open(join(dir,'CitizenFX-filler'+i+'.log'),'w');try{await file.truncate(4194304);}finally{await file.close();}}
  await writeFile(join(dir,'CitizenFX-z.log'),'Game finished loading!\nTWO\nsecond\n');logs.bind(8,'TWO');
  for(let i=0;i<15&&!store.query({side:'client',clientId:8,contains:'second'}).lines.length;i++){now+=6000;await logs.poll();}
  assert.ok(['available','partial'].includes(logs.coverage(7).state));
  assert.equal(store.query({side:'client',clientId:8,contains:'second'}).lines.length,1);
  assert.equal(store.query({side:'client',clientId:7,contains:'first'}).lines.length,1);
 }finally{logs.stop();await rm(dir,{recursive:true,force:true});}
});

test('a local bridge delivers the current client log with resource attribution and deduplication',async()=>{
 const {ClientLogs}=await import('../http-mcp/src/logs/client-files.ts');const {LogStore}=await import('../http-mcp/src/logs/store.ts');
 const store=new LogStore(),logs=new ClientLogs([],store);
 try{
  logs.bind(7,'CURRENT-MARKER');
  const line='[  1] [fxdk_b3258_Gam] MainThrd/ [exnui] hello';
  const end=200+Buffer.byteLength(line+'\n');
  assert.deepEqual(logs.ingest('CURRENT-MARKER','CitizenFX_current.log',200,end,[line]),{ok:true,nextOffset:end});
  assert.equal(logs.coverage(7).state,'available');
  assert.deepEqual(store.query({side:'client',clientId:7,resource:'exnui'}).lines.map(x=>x.message),['hello']);
  assert.equal(store.query({side:'client',clientId:7,resource:'exnui',includeRaw:true}).lines[0].raw,line);
  assert.deepEqual(logs.ingest('CURRENT-MARKER','CitizenFX_current.log',200,end,[line]),{ok:true,nextOffset:end});
  assert.equal(store.query({side:'client',clientId:7,resource:'exnui'}).lines.length,1);
  assert.deepEqual(logs.ingest('STALE-MARKER','CitizenFX_current.log',200,end,[line]),{ok:false});
 }finally{logs.stop();}
});

test('the local bridge backfills startup after game load, before binding, across large files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'client-log-bridge-'));
 const marker='FIVEM_MCP_BIND:'+'0'.repeat(36)+':'+'1'.repeat(36)+':'+'2'.repeat(36)+':'+'a'.repeat(32);
 const line='[  1] [fxdk_b3258_Gam] MainThrd/ [exnui] bridge test';
 const startup='[  1] [fxdk_b3258_Gam] MainThrd/ [exnui] discovery:manifest_schema_invalid';
 await writeFile(join(dir,'CitizenFX_test.log'),'old\n[  1] [fxdk_b3258_Gam] MainThrd/ ^2Game finished loading!\n'+startup+'\n'+('padding\n').repeat(600000)+marker+'\n'+line+'\n');
 let received;const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({nextOffset:received.endOffset}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const child=spawn(process.execPath,['scripts/client-log-bridge.mjs','--log-dir',dir,'--url',`http://127.0.0.1:${port}/mcp/client-logs`],{cwd:process.cwd(),stdio:'ignore'});
 try{
  for(let i=0;i<30&&!received;i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(received,'bridge did not deliver a batch');
  assert.equal(received.marker,marker);
  assert.equal(received.lines[0],startup);
  assert.ok(received.lines.length<=100);
  assert.equal(received.endOffset-received.startOffset,Buffer.byteLength(received.lines.map(line=>line+'\n').join('')));
 }finally{child.kill();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
