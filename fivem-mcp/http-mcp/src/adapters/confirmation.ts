import {createHash,randomUUID} from 'node:crypto';
import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
export interface ConfirmationContext {server:Server;requestId:string|number;signal:AbortSignal}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export class Confirmations {
  private pending=new Map<string,{sessionId:string;abort:AbortController}>();
  async approve(sessionId:string,request:unknown,epoch:string,context:ConfirmationContext,valid:()=>boolean):Promise<void> {
    const capability=context.server.getClientCapabilities()?.elicitation;
    if(!capability||(!('form' in capability)&&Object.keys(capability).length!==0))throw new Error('CONFIRMATION_UNSUPPORTED');
    if(this.pending.size>=8||[...this.pending.values()].filter(p=>p.sessionId===sessionId).length>=2)throw new Error('CONFIRMATION_LIMIT');
    const identity=canonical({request,epoch,sessionId,rpcId:context.requestId});
    const hash=createHash('sha256').update(identity).digest('hex');
    const params={mode:'form' as const,message:'Approve this database operation? '+JSON.stringify({request,target:{dependencyEpoch:epoch}}),requestedSchema:{type:'object' as const,properties:{approve:{type:'boolean' as const,default:false}},required:['approve']}};
    if(Buffer.byteLength(JSON.stringify(params),'utf8')>32768)throw new Error('CONFIRMATION_TOO_LARGE');
    const id=randomUUID(),abort=new AbortController(),deadline=performance.now()+120000;
    const cancel=()=>abort.abort();context.signal.addEventListener('abort',cancel,{once:true});
    this.pending.set(id,{sessionId,abort});
    try {
      if(context.signal.aborted||!valid())throw new Error('CONFIRMATION_CANCELLED');
      const reply=await context.server.elicitInput(params,{relatedRequestId:context.requestId,timeout:120000,signal:abort.signal});
      if(performance.now()>deadline)throw new Error('CONFIRMATION_EXPIRED');
      if(abort.signal.aborted||!valid()||createHash('sha256').update(canonical({request,epoch,sessionId,rpcId:context.requestId})).digest('hex')!==hash)throw new Error('CONFIRMATION_CANCELLED');
      if(reply.action!=='accept'||reply.content?.approve!==true)throw new Error('CONFIRMATION_DECLINED');
    } catch(e){
      if(abort.signal.aborted)throw new Error('CONFIRMATION_CANCELLED');
      if(performance.now()>=deadline)throw new Error('CONFIRMATION_EXPIRED');
      throw e;
    }finally{this.pending.delete(id);context.signal.removeEventListener('abort',cancel);}
  }
  close(sessionId?:string){for(const [id,p] of this.pending)if(sessionId===undefined||p.sessionId===sessionId){p.abort.abort();this.pending.delete(id);}}
}
