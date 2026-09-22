#!/usr/bin/env node
// Explicitly invoked host acceptance aid. Never starts, deploys or restarts a resource.
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if(process.argv.includes('--help')){
 console.log('node scripts/benchmark-http-mcp.mjs [http://127.0.0.1:30130/mcp]\nRuns 20 samples per class. Capture FIVEAI_MCP compiler console records for actual preparation/cold-start costs.');
 process.exit(0);
}
const url=new URL(process.argv[2]??'http://127.0.0.1:30130/mcp');
if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/mcp'||url.username||url.password)throw new Error('Expected the explicit local MCP endpoint');
const client=new Client({name:'fiveai-compiler-benchmark',version:'1.0.0'});
const transport=new StreamableHTTPClientTransport(url);
const summaries=[];
try{
 await client.connect(transport);
 const before=await client.callTool({name:'status',arguments:{}});
 if(before.structuredContent?.data?.compiler?.state!=='ready')throw new Error('Compiler must be ready before host performance acceptance');
 console.log(JSON.stringify({kind:'host',status:before.structuredContent.data}));
 const sizes=[1024,16384,65536];
 const cases=sizes.map(size=>({name:`valid-${size}`,code:'/*'+'x'.repeat(size-13)+'*/return 1;'}));
 cases.push({name:'deep-syntax-error',code:'return '+'('.repeat(128)+';'});
 for(const sample of cases){
  const elapsed=[],statusLatency=[];
  for(let index=0;index<20;index++){
   const start=performance.now();
   const execution=client.callTool({name:'execute_ts',arguments:{side:'server',code:sample.code}});
   const statusStart=performance.now();
   const control=client.callTool({name:'status',arguments:{}}).then(result=>{statusLatency.push(performance.now()-statusStart);return result;});
   const response=await execution;elapsed.push(performance.now()-start);await control;
   const value=response.structuredContent;
   let task=value?.ok?value.data:value?.task;
   const deadline=performance.now()+65000;
   while(task&&['queued','running'].includes(task.state)&&performance.now()<deadline){await delay(100);const query=await client.callTool({name:'queue',arguments:{action:'status',taskId:task.taskId}});task=query.structuredContent?.data?.task;}

   if(sample.name==='deep-syntax-error'?value?.error?.code!=='COMPILE_FAILED':!value?.ok||task?.state!=='succeeded')throw new Error('Unexpected task result: '+JSON.stringify(value));
   await delay(100);
  }
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:(sorted[9]+sorted[10])/2,maxMs:sorted.at(-1)};};
  const result={class:sample.name,codeBytes:Buffer.byteLength(sample.code),samples:20,call:stats(elapsed),concurrentStatus:stats(statusLatency)};
  summaries.push(result);console.log(JSON.stringify(result));
 }
 console.log(JSON.stringify({kind:'complete',buildId:before.structuredContent.data.buildId,summaries,note:'Call latency is not preparation cost. Use matching compiler console records for that measurement.'}));
}finally{await transport.terminateSession().catch(()=>{});await client.close();}
