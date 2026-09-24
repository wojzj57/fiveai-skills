import test from 'node:test';import assert from 'node:assert/strict';
import {RuntimeService} from '../http-mcp/src/runtime-service.ts';
import {validate} from '../http-mcp/src/shared/schema.ts';
test('host congestion returns the status error envelope instead of a JSON-RPC exception',async()=>{
 const names=['GetResourceState','StartResource','StopResource'];const previous=new Map(names.map(name=>[name,globalThis[name]]));
 for(const name of names)globalThis[name]=()=>{};
 const service=new RuntimeService({resourceName:'fixture',resourceEpoch:'00000000-0000-4000-8000-000000000001',buildId:'a'.repeat(64),resourcePath:'unused',config:{port:30130,clientLogDirectories:[],referenceOnline:false},host:{run:async()=>{throw new Error('HOST_UNAVAILABLE');}},sessionValid:()=>true,report:()=>{}});
 try{
  const result=await service.call('status',{},'session');
  assert.equal(result.structuredContent.error.code,'HOST_UNAVAILABLE');assert.equal(validate('statusOutput',result.structuredContent),true);
 }finally{await service.stop();for(const [name,value]of previous){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}}
});
