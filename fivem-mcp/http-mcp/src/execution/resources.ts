import {randomUUID} from 'node:crypto';
interface Host {run<T>(fn:()=>T):Promise<T>}
interface Natives {names():string[];state(name:string):string;start(name:string):boolean;stop(name:string):boolean}
export class ResourceFailure extends Error {readonly execution:'unknown'|'ended'|'not_dispatched';constructor(message:string,execution:'unknown'|'ended'|'not_dispatched'){super(message);this.execution=execution;}}
export class ResourceController {
  private self:string;private host:Host;private native:Natives;
  private epochs=new Map<string,string>();
  private generations=new Map<string,number>();
  private stopped=false;
  constructor(self:string,host:Host,native:Natives){this.self=self;this.host=host;this.native=native;}
  observe(name:string){this.epochs.set(name,randomUUID());this.generations.set(name,(this.generations.get(name)??0)+1);}
  epoch(name:string){if(!this.epochs.has(name))this.epochs.set(name,randomUUID());return this.epochs.get(name)!;}
  check(action:string,name:string){
    if(name===this.self&&(action==='stop'||action==='restart'))throw new Error('SELF_RESOURCE_PROTECTED');
    if(!this.native.names().includes(name))throw new Error('RESOURCE_NOT_FOUND');
    const state=this.native.state(name);
    if((action==='start'||action==='stop'||action==='restart')&&['starting','stopping'].includes(state))throw new Error('RESOURCE_BUSY');
    return state;
  }
  read(name?:string){
    const names=this.native.names();if(name&&!names.includes(name))throw new Error('RESOURCE_NOT_FOUND');
    const resources=(name?[name]:names).map(name=>({name,state:this.native.state(name),epoch:String(this.epoch(name))}));
    if(resources.length>8192||Buffer.byteLength(JSON.stringify(resources))>262144)throw new Error('RESULT_TOO_LARGE');
    return {resources};
  }
  async change(action:string,name:string){
    let issued=false;
    try {
    const before=await this.host.run(()=>this.check(action,name));
    const stages:{action:string;before:string;after:string;ok:boolean}[]=[];
    const deadline=performance.now()+30000;
    let current=before;
    const actions=action==='restart'?(before==='started'?['stop','start']:['start']):[action];
    for(const step of actions){
      if(performance.now()>deadline)throw new ResourceFailure('RESOURCE_OPERATION_FAILED: deadline before next stage','ended');
      const desired=step==='start'?'started':'stopped';
      const stageBefore=current;
      const epoch=this.epoch(name),generation=this.generations.get(name)??0;
      if(current!==desired){
        const accepted=await this.host.run(()=>{
          if(this.epoch(name)!==epoch)throw new Error('EXECUTION_UNKNOWN');
          issued=true;
          return step==='start'?this.native.start(name):this.native.stop(name);
        });
        if(!accepted)throw new ResourceFailure('RESOURCE_OPERATION_FAILED','ended');
        while(!this.stopped){
          current=await this.host.run(()=>this.native.state(name));
          if((this.generations.get(name)??0)>generation+1)throw new Error('EXECUTION_UNKNOWN');
          if(current===desired)break;
          // Keep observing the dispatched operation: late terminal evidence can recover unknown.
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(this.stopped)throw new Error('EXECUTION_UNKNOWN');
      }
      stages.push({action:step,before:stageBefore,after:current,ok:true});
    }
    return {kind:'resource' as const,change:{name,before,after:current,stages}};
    }catch(error){if(error instanceof ResourceFailure)throw error;throw new ResourceFailure(String(error),issued?'unknown':'not_dispatched');}
  }
  stop(){this.stopped=true;}
}
