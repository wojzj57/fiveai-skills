import test from 'node:test';
import assert from 'node:assert/strict';
import {Confirmations} from '../http-mcp/src/adapters/confirmation.ts';

test('SQL approval requires a supported form and exact acceptance on the original request',async()=>{
 const confirmations=new Confirmations(),signal=new AbortController().signal;
 const request={method:'update',args:['UPDATE example SET flag = ?', [true]]};
 let sent;
 const server={getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:async(params,options)=>{sent={params,options};return {action:'accept',content:{approve:true}};}};
 await confirmations.approve('session',request,'epoch',{server,requestId:42,signal},()=>true);
 assert.equal(sent.options.relatedRequestId,42);
 assert.equal(sent.params.requestedSchema.properties.approve.default,false);
 assert.ok(sent.params.message.includes(JSON.stringify(request)));
 server.elicitInput=async()=>({action:'accept',content:{approve:false}});
 await assert.rejects(confirmations.approve('session',request,'epoch',{server,requestId:43,signal},()=>true),/CONFIRMATION_DECLINED/);
 server.getClientCapabilities=()=>({});
 await assert.rejects(confirmations.approve('session',request,'epoch',{server,requestId:44,signal},()=>true),/CONFIRMATION_UNSUPPORTED/);
});

test('approval rejects changed targets, disconnected streams and overfull session limits',async()=>{
 const confirmations=new Confirmations(),controller=new AbortController();let valid=true,reply;
 const server={getClientCapabilities:()=>({elicitation:{form:{}}}),elicitInput:(_p,options)=>new Promise((resolve,reject)=>{reply=resolve;options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})};
 const context={server,requestId:1,signal:controller.signal};
 const pending=confirmations.approve('s',{},'epoch',context,()=>valid);
 valid=false;reply({action:'accept',content:{approve:true}});
 await assert.rejects(pending,/CONFIRMATION_CANCELLED/);valid=true;
 const a=confirmations.approve('s',{},'epoch',context,()=>valid);
 const b=confirmations.approve('s',{},'epoch',{...context,requestId:2},()=>valid);
 await assert.rejects(confirmations.approve('s',{},'epoch',{...context,requestId:3},()=>valid),/CONFIRMATION_LIMIT/);
 const assertions=[assert.rejects(a,/CONFIRMATION_CANCELLED/),assert.rejects(b,/CONFIRMATION_CANCELLED/)];
 controller.abort();await Promise.all(assertions);
});
