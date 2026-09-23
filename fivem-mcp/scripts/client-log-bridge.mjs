#!/usr/bin/env node
// Local-only companion for FiveM client logs. The FXServer resource cannot read FiveM.app/logs.
import {open,readdir,stat} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {gameLoadOffset} from './client-log-history.mjs';

const args=process.argv.slice(2);
let logDir=null,url='http://127.0.0.1:30130/mcp/client-logs';
for(let i=0;i<args.length;i++){
  if(args[i]==='--log-dir'&&args[i+1])logDir=resolve(args[++i]);
  else if(args[i]==='--url'&&args[i+1])url=args[++i];
  else throw new Error('Usage: client-log-bridge --log-dir <FiveM logs directory> [--url http://127.0.0.1:30130/mcp/client-logs]');
}
if(!logDir)throw new Error('--log-dir is required');
const endpoint=new URL(url);
if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.pathname.endsWith('/mcp/client-logs'))throw new Error('Bridge endpoint must be the local MCP client-log path');

const markerPattern=/FIVEM_MCP_BIND:[0-9a-f-]+:[0-9a-f-]+:[0-9a-f-]+:[0-9a-f]{32}/g;
let active=null,lastHeartbeat=0,running=true,lastError='',lastErrorAt=0;
process.on('SIGINT',()=>{running=false;});process.on('SIGTERM',()=>{running=false;});
async function newestLog(){
  const entries=(await readdir(logDir,{withFileTypes:true})).filter(e=>e.isFile()&&/^CitizenFX.*\.log$/i.test(e.name));
  const found=await Promise.all(entries.map(async e=>({name:e.name,stats:await stat(join(logDir,e.name))})));
  found.sort((a,b)=>b.stats.mtimeMs-a.stats.mtimeMs);
  return found[0]??null;
}
async function currentMarker(path,size,scanFrom=Math.max(0,size-4*1024*1024)){
  const start=Math.max(scanFrom,size-4*1024*1024),length=size-start;
  const handle=await open(path,'r');let bytes;
  try{bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,start);bytes=bytes.subarray(0,read.bytesRead);}finally{await handle.close();}
  let match,last;
  while((match=markerPattern.exec(bytes.toString('utf8')))!==null)last=match[0];
  if(!last)return null;
  const index=bytes.lastIndexOf(Buffer.from(last));
  const end=bytes.indexOf(10,index+Buffer.byteLength(last));
  if(end<0)return null;
  const offset=await gameLoadOffset(path,start+end+1);
  return offset===null?null:{marker:last,offset};
}
async function readLines(path,cursor,size){
  const length=Math.min(size-cursor,48*1024);
  if(length<=0)return {lines:[],end:cursor};
  const handle=await open(path,'r');let bytes;
  try{bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,cursor);bytes=bytes.subarray(0,read.bytesRead);}finally{await handle.close();}
  const lines=[];let from=0;
  for(let i=0;i<bytes.length&&lines.length<100;i++)if(bytes[i]===10){
    const line=bytes.subarray(from,i).toString('utf8');
    if(Buffer.byteLength(line)>16_384)throw new Error('Client log line exceeds 16KiB');
    lines.push(line);from=i+1;
  }
  if(from===0&&bytes.length===48*1024)throw new Error('Client log line exceeds the bridge read limit');
  return {lines,end:cursor+from};
}
async function post(batch){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(batch),signal:AbortSignal.timeout(4000)});
  if(response.status===409)return null;
  if(!response.ok)throw new Error(`Bridge HTTP ${response.status}`);
  const value=await response.json();
  if(!Number.isSafeInteger(value.nextOffset)||value.nextOffset<0)throw new Error('Invalid bridge acknowledgement');
  return value.nextOffset;
}
async function poll(){
  const file=await newestLog();if(!file)return;
  const path=join(logDir,file.name);
  if(!active||active.fileId!==file.name||file.stats.size<active.cursor){
    const found=await currentMarker(path,file.stats.size);if(!found){active=null;return;}
    active={fileId:basename(file.name),marker:found.marker,cursor:found.offset,scannedSize:file.stats.size};
  }
  if(file.stats.size>active.scannedSize){
    const latest=await currentMarker(path,file.stats.size,Math.max(0,active.scannedSize-200));
    active.scannedSize=file.stats.size;
    if(latest&&latest.marker!==active.marker)active={fileId:file.name,marker:latest.marker,cursor:latest.offset,scannedSize:file.stats.size};
  }
  const {lines,end}=await readLines(path,active.cursor,file.stats.size);
  if(lines.length===0&&Date.now()-lastHeartbeat<2000)return;
  const acknowledged=await post({marker:active.marker,fileId:active.fileId,startOffset:active.cursor,endOffset:end,lines});
  if(acknowledged===null){active=null;return;}
  active.cursor=acknowledged;lastHeartbeat=Date.now();
}
console.log(`FiveAI client log bridge watching ${logDir}; endpoint ${endpoint.origin}${endpoint.pathname}`);
while(running){
  try{await poll();lastError='';}catch(error){const message=error instanceof Error?error.message:String(error);if(message!==lastError||Date.now()-lastErrorAt>10_000){console.error('FiveAI client log bridge:',message);lastError=message;lastErrorAt=Date.now();}}
  if(running)await new Promise(resolve=>setTimeout(resolve,500));
}
