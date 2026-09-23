import {McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {dependencyMethods} from './adapters/dependencies.ts';
import {randomUUID,createHash} from 'node:crypto';
import {schema,bounded,validate} from './shared/schema.ts';
import {encodeValues} from './shared/wire.ts';
import type {Config} from './shared/config.ts';
import type {HostScheduler} from './execution/host.ts';
import {TaskCenter} from './tasks/task-center.ts';
import type {TaskError,TaskErrorCode,TaskExecution,TaskPhase,TaskBinding,TaskResult} from './tasks/types.ts';
import {LogStore} from './logs/store.ts';
import {ResourceController} from './execution/resources.ts';
import {Confirmations,type ConfirmationContext} from './adapters/confirmation.ts';
import {ReferenceSearch} from './reference/search.ts';
import {runOnHost,mappedError,prepareJavaScript} from './execution/javascript.ts';
import {ClientBindingManager,encodeClientExecute,type ClientExecutePayload} from './execution/client-bindings.ts';
import {ClientLogs} from './logs/client-files.ts';
import {isReadOnly} from './adapters/sql.ts';

interface RuntimeOptions {resourceName:string;resourceEpoch:string;buildId:string;resourcePath:string;config:Config;host:HostScheduler;sessionValid:(id:string)=>boolean;report:(tag:string,payload:unknown)=>void}
interface Plan {code?:string;args?:unknown;timeoutMs?:number;javascript?:string;[key:string]:unknown}
type Handler=(args:Record<string,unknown>,sessionId:string,context?:ConfirmationContext)=>Promise<ReturnType<typeof output>>;
const versions:Record<string,string>={es_extended:'1.15.2','qb-core':'1.3.0',ox_lib:'3.39.0',ox_target:'1.18.1',oxmysql:'2.14.1'};
const toolDescriptions:Record<string,string>={
  status:'Inspect server identity, ready client bindings, dependencies, log coverage and queue state.',
  queue:'Inspect a task or queue, cancel work before dispatch, or recover uncertain execution from retained evidence.',
  execute_lua:'Run a Lua function body on the server or a specified ready game client.',
  execute_js:'Run an ES2022 JavaScript async function body with args. After await, access server natives/exports inside a synchronous mcp.host(callback). No TypeScript or module imports.',
  resource:'List or inspect exact-name resources, or start, stop or restart one through the FIFO. Self stop and restart are refused.',
  logs:'Read bounded log results with explicit coverage. Client history starts after the latest Game finished loading! line, including startup before MCP binding. Server history includes the entire available host console buffer plus live output. Defaults to client logs.',
  esx:'Call supported ESX Legacy methods on the server or a ready game client.',
  qbcore:'Call supported QBCore methods on the server or a ready game client.',
  ox:'Call supported ox_lib, ox_target or oxmysql methods selected by library.',
  reference:'Search bundled FiveM reference summaries, with optional configured online fallback.',
};
type DependencySnapshot={resource:string;installed:boolean;state:string;version:string|null;expectedVersion:string};
function error(code:TaskErrorCode,message:string=code,execution:TaskExecution='not_dispatched',phase:TaskPhase='validation'):TaskError{return {code,message:message.slice(0,4096),phase,retryable:false,execution};}
function output(value:Record<string,unknown>){return {isError:value.ok===false,structuredContent:value,content:[{type:'text' as const,text:JSON.stringify(value)}]};}
export class RuntimeService {
  private registry:Record<string,{inputSchema:ReturnType<typeof schema>;outputSchema:ReturnType<typeof schema>;handler:Handler}>;
  private options:RuntimeOptions;
  private tasks:TaskCenter;
  private logs=new LogStore();
  private stopped=false;
  private resources:ResourceController;
  private reference:ReferenceSearch;
  private clients:ClientBindingManager;
  private clientLogs:ClientLogs;
  private maintenance:ReturnType<typeof setInterval>;
  private confirmations=new Confirmations();
  private dependencies:unknown[]=[];
  private players=new Map<number,string>();
  constructor(options:RuntimeOptions){
    const handlers:Record<string,Handler>={
      status:(args,id,context)=>this.handleCall('status',args,id,context),
      queue:(args,id,context)=>this.handleCall('queue',args,id,context),
      execute_lua:(args,id,context)=>this.handleCall('execute_lua',args,id,context),
      execute_js:(args,id,context)=>this.handleCall('execute_js',args,id,context),
      resource:(args,id,context)=>this.handleCall('resource',args,id,context),
      logs:(args,id,context)=>this.handleCall('logs',args,id,context),
      esx:(args,id,context)=>this.handleCall('esx',args,id,context),
      qbcore:(args,id,context)=>this.handleCall('qbcore',args,id,context),
      ox:(args,id,context)=>this.handleCall('ox',args,id,context),
      reference:(args,id,context)=>this.handleCall('reference',args,id,context),
    };
    this.registry=Object.fromEntries(Object.entries(handlers).map(([name,handler])=>[name,{inputSchema:schema(name+'Input'),outputSchema:schema(name+'Output'),handler}]));
    this.reference=new ReferenceSearch(options.config.referenceOnline);
    this.clientLogs=new ClientLogs(options.config.clientLogDirectories,this.logs);
    this.clients=new ClientBindingManager({resourceName:options.resourceName,resourceEpoch:options.resourceEpoch,
      send:(id,event,raw)=>{void options.host.run(()=>emitNet(event,id,raw)).catch(()=>{});},
      onBound:(binding,marker)=>this.clientLogs.bind(binding.clientId,`FIVEM_MCP_BIND:${binding.resourceEpoch}:${binding.connectionId}:${binding.clientEpoch}:${marker}`),
      onBindingLost:(binding,reason)=>{this.clientLogs.unbind(binding.clientId);const active=this.tasks?.overview().active;if(active?.target.binding.side==='client'&&JSON.stringify(active.target.binding)===JSON.stringify(binding))this.tasks.settle(active.taskId,{identity:binding,execution:'unknown',error:error('EXECUTION_UNKNOWN',reason,'unknown','dispatched')});},
      onTerminal:message=>{const payload=message.type==='terminal'?message.payload:message.payload.known?message.payload.terminal:null;if(!payload)return false;const result=this.tasks.settle(message.taskId,{identity:message.binding,...payload});return result.accepted||result.reason==='duplicate';},
    });
    this.maintenance=setInterval(()=>{this.clients.sweep();void this.clientLogs.poll();},200);this.maintenance.unref();
    this.options=options;
    this.resources=new ResourceController(options.resourceName,options.host,{names:()=>Array.from({length:GetNumResources()},(_,i)=>GetResourceByFindIndex(i)),state:GetResourceState,start:StartResource,stop:StopResource});
    this.tasks=new TaskCenter({
      resourceEpoch:options.resourceEpoch,
      sessionValid:options.sessionValid,
      yieldControl:()=>new Promise(resolve=>setImmediate(resolve)),
      validateCommit:({task,prepared})=>{
        if(!options.sessionValid(String((prepared as Plan)._sessionId)))return error('SESSION_ENDED');
        if(task.target.playerId!==undefined&&this.players.get(task.target.playerId)!==task.target.playerConnectionId)return error('TARGET_CHANGED');
        if(task.target.binding.side==='client'&&JSON.stringify(this.clients.resolveTarget(task.target.binding.clientId))!==JSON.stringify(task.target.binding))return error('TARGET_CHANGED');
        return task.target.resource&&this.resources.epoch(task.target.resource)!==task.target.dependencyEpoch?error('TARGET_CHANGED'):true;
      },
      recover:context=>{if(context.task.target.binding.side==='client')this.clients.probe(context.task.target.binding,context.taskId);else void options.host.run(()=>emit(options.resourceName+':mcp:v1:local:probe',context.taskId)).catch(()=>{});return new Promise(resolve=>context.signal.addEventListener('abort',()=>resolve(null),{once:true}));},
      prepare:async context=>{
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(context.signal.aborted)return {ok:false as const,error:error('TASK_CANCELLED')};
        const plan=context.payload as Plan;
        if(!options.sessionValid(String(plan._sessionId)))return {ok:false as const,error:error('SESSION_ENDED')};
        if(context.task.target.playerId!==undefined&&this.players.get(context.task.target.playerId)!==context.task.target.playerConnectionId)return {ok:false as const,error:error('TARGET_CHANGED')};
        if(context.task.target.binding.side==='client'&&JSON.stringify(this.clients.resolveTarget(context.task.target.binding.clientId))!==JSON.stringify(context.task.target.binding))return {ok:false as const,error:error('TARGET_CHANGED')};
        try {
          const prepared=context.task.tool==='execute_js'?{...plan,...prepareJavaScript(plan.code!)}:plan;
          if(context.task.target.binding.side==='client')encodeClientExecute(context.task.target.binding,context.taskId,this.clientPayload(context.task.tool,prepared,context.taskId));
          return {ok:true as const,value:prepared};
        }catch(e){const message=String(e);const code:TaskErrorCode=message.includes('PREPARATION_TIMEOUT')?'PREPARATION_TIMEOUT':message.includes('COMPILE_FAILED')?'COMPILE_FAILED':message.includes('INPUT_TOO_LARGE')?'INPUT_TOO_LARGE':message.includes('RESULT_TOO_LARGE')?'RESULT_TOO_LARGE':message.includes('JAVASCRIPT_INVALID')?'JAVASCRIPT_INVALID':'INTERNAL_ERROR';return {ok:false as const,error:error(code,message,'not_dispatched','preparing')};}
      },
      dispatch:async context=>{
        const plan=context.prepared as Plan;
        await options.host.run(()=>{
          if(this.stopped||!context.dispatchCommitted())return;
          const task=context.task;
          if(task.target.binding.side==='client'){
            if(!this.clients.sendExecute(task.target.binding,task.taskId,this.clientPayload(task.tool,plan,task.taskId)))this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'not_dispatched',error:error('TARGET_CHANGED')});
            return;
          }
          if(task.tool==='resource'){
            void this.resources.change(String(plan.action),String(plan.name)).then(result=>this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',result}),e=>this.tasks.settle(task.taskId,{identity:task.target.binding,execution:e.execution??'unknown',error:error(e.execution==='unknown'||!e.execution?'EXECUTION_UNKNOWN':'RESOURCE_OPERATION_FAILED',String(e),e.execution??'unknown',e.execution==='not_dispatched'?'waiting_host':'dispatched')}));
            return;
          }
          if(task.tool==='ox'&&plan.library==='oxmysql'){
            const api=(globalThis as unknown as {exports:Record<string,Record<string,(...args:unknown[])=>unknown>>}).exports['oxmysql'];
            const fn=api?.[String(plan.method)+'_async'];
            if(!fn){this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'not_dispatched',error:error('METHOD_UNSUPPORTED')});return;}
            Promise.resolve(fn.apply(api,plan.args as unknown[])).then(value=>{
              try{this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',result:encodeValues([value])});}
              catch(e){this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',error:error('RESULT_UNSUPPORTED',String(e),'ended','dispatched')});}
            },e=>this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',error:error('EXECUTION_FAILED',String(e),'ended','dispatched')}));
            return;
          }
          if(task.tool==='execute_lua'||['esx','qbcore','ox'].includes(task.tool)){
            const adapter=task.tool!=='execute_lua';
            emit(options.resourceName+':mcp:v1:local:execute',JSON.stringify({v:1,type:'execute',binding:task.target.binding,taskId:task.taskId,payload:{kind:'lua',code:adapter?'return FiveAiAdapter(args)':plan.code,args:adapter?{side:plan.side,scope:plan.scope,library:plan.library,method:plan.method,playerId:plan.playerId,args:plan.args,tool:task.tool}:plan.args??{},timeoutMs:plan.timeoutMs??10000,planHash:createHash('sha256').update(JSON.stringify(plan)).digest('hex')}}));
            return;
          }
          try {
            runOnHost(String(plan.javascript),plan.args??{},options.host).then(value=>{
              try {this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',result:encodeValues([value])});}
              catch(e){this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',error:error(String(e).includes('RESULT_TOO_LARGE')?'RESULT_TOO_LARGE':'RESULT_UNSUPPORTED',String(e),'ended','dispatched')});}
            },e=>this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',error:{...error('EXECUTION_FAILED',String(e),'ended','dispatched'),...mappedError(e)}}));
          }catch(e){this.tasks.settle(task.taskId,{identity:task.target.binding,execution:'ended',error:error('EXECUTION_FAILED',String(e),'ended','dispatched')});}
        },true);
      },
    });
  }
  private clientPayload(tool:string,plan:Plan,taskId:string):ClientExecutePayload {
    const adapter=['esx','qbcore','ox'].includes(tool);
    const {_sessionId,...publicPlan}=plan;
    return {kind:tool==='execute_js'?'js':'lua',code:tool==='execute_js'?String(plan.javascript):adapter?'return FiveAiAdapter(args)':String(plan.code),args:adapter?{...publicPlan,tool}:plan.args??{},timeoutMs:plan.timeoutMs??10000,planHash:createHash('sha256').update(JSON.stringify({taskId,plan:publicPlan})).digest('hex')};
  }
  registerHost(){
    for(const type of ['hello','heartbeat','terminal','probeResult'])onNet(this.options.resourceName+':mcp:v1:'+type,(raw:unknown)=>{const source=Number((globalThis as unknown as {source:unknown}).source);if(typeof raw==='string')this.clients.receive(source,type,raw);});
    on('playerJoining',()=>this.players.set(Number((globalThis as unknown as {source:unknown}).source),randomUUID()));
    on('playerDropped',()=>{const id=Number((globalThis as unknown as {source:unknown}).source);this.players.delete(id);this.clients.drop(id);});
    const changed=(name:unknown)=>{if(typeof name==='string'){this.resources.observe(name);if(!this.stopped)void this.options.host.run(()=>this.refreshDependencies()).catch(()=>{});const active=this.tasks.overview().active;if(active?.target.resource===name&&active.tool!=='resource'&&active.execution==='unknown')this.tasks.settle(active.taskId,{identity:active.target.binding,execution:'unknown',error:error('EXECUTION_UNKNOWN','Dependency changed during execution','unknown','dispatched')});}};
    on('onResourceStart',changed);on('onResourceStop',changed);this.refreshDependencies();
    // registerHost runs synchronously on Host Tick: snapshot first, then attach
    // the listener without an await, so the same history is not replayed twice.
    try{
      if(typeof GetConsoleBuffer!=='function')throw new Error('GetConsoleBuffer is unavailable');
      for(const line of GetConsoleBuffer().split(/\r?\n/))if(line)this.logs.append('server',line);
    }catch{this.logs.serverHistoryReason='Server console history unavailable; collecting live output only';}
    if(typeof RegisterConsoleListener==='function'){
      this.logs.available=true;
      RegisterConsoleListener((channel,message)=>{if(!this.stopped)this.logs.append(channel,message);});
    }
    on(this.options.resourceName+':mcp:v1:local:terminal',raw=>{
      if(this.stopped||typeof raw!=='string'||Buffer.byteLength(raw)>384*1024)return;
      try{
        const message=JSON.parse(raw) as {taskId:string;binding:TaskBinding;payload:{execution:'ended'|'not_dispatched';result?:TaskResult;error?:TaskError}};
        const frame=message as unknown as Record<string,unknown>;
        if(frame.v!==1||frame.type!=='terminal'||Object.keys(frame).some(k=>!['v','type','binding','taskId','payload'].includes(k))||typeof message.taskId!=='string'||message.binding?.side!=='server'||message.binding.resourceEpoch!==this.options.resourceEpoch||Object.keys(message.binding).some(k=>!['side','resourceEpoch'].includes(k)))return;
        if(!message.payload||Object.keys(message.payload).some(k=>!['execution','result','error'].includes(k)))return;
        const settled=this.tasks.settle(message.taskId,{identity:message.binding,...message.payload});
        if(settled.accepted||settled.reason==='duplicate')void this.options.host.run(()=>emit(this.options.resourceName+':mcp:v1:local:terminalAck',message.taskId)).catch(()=>{});
      }catch{ /* Malformed local terminals cannot settle a task. */ }
    });
  }
  private async discovery(){
    const dependencies=await this.options.host.run(()=>{
      const installed=new Set(Array.from({length:GetNumResources()},(_,i)=>GetResourceByFindIndex(i)));
      return Object.entries(versions).map(([resource,expectedVersion]):DependencySnapshot=>({resource,installed:installed.has(resource),state:installed.has(resource)?GetResourceState(resource):'missing',version:installed.has(resource)?GetResourceMetadata(resource,'version',0)||null:null,expectedVersion}));
    });
    return {dependencies,clients:this.clients.snapshots(),serverLogs:this.logs.coverage()};
  }
  private registered(name:string,installed:ReadonlySet<string>){
    if(!Object.hasOwn(this.registry,name))return false;
    const required=name==='esx'?['es_extended']:name==='qbcore'?['qb-core']:name==='ox'?['ox_lib','ox_target','oxmysql']:[];
    return required.length===0||required.some(resource=>installed.has(resource));
  }
  async hasTool(name:string){
    if(!Object.hasOwn(this.registry,name))return false;
    if(!['esx','qbcore','ox'].includes(name))return true;
    const installed=await this.options.host.run(()=>new Set(Array.from({length:GetNumResources()},(_,i)=>GetResourceByFindIndex(i))));
    return this.registered(name,installed);
  }
  async tools(){
    const snapshot=await this.discovery();
    const installed=new Set(snapshot.dependencies.filter(d=>d.installed).map(d=>d.resource));
    const dependency=(resource:string)=>snapshot.dependencies.find(d=>d.resource===resource)!;
    const state=(d:DependencySnapshot)=>d.state!=='started'?`unavailable: ${d.resource} is ${d.state}`:d.version!==d.expectedVersion?`unavailable: ${d.resource} version ${d.version??'unknown'}; requires ${d.expectedVersion}`:'available';
    const ready=snapshot.clients.filter(c=>c.ready);
    const clientNote=ready.length?'':'Client execution unavailable: no ready client binding.';
    const coverage=ready.map(c=>this.clientLogs.coverage(c.clientId));
    const logNote=[!ready.length?'Client logs unavailable: no ready client binding.':'',ready.length>1?'Specify clientId to select one of multiple ready clients.':'',ready.length&&!this.options.config.clientLogDirectories.length&&coverage.every(c=>c.state==='unconfigured')?'Client logs unavailable: no client log directory or local bridge configured.':'',...coverage.filter(c=>c.state!=='available').map(c=>`Client ${c.clientId} log source ${c.state}.`),snapshot.serverLogs.state!=='available'?'Server log coverage unavailable.':''].filter(Boolean).join(' ');
    return Object.entries(this.registry).filter(([name])=>this.registered(name,installed)).map(([name,{inputSchema,outputSchema}])=>{
      let note='';
      if(name==='esx')note=`Dependency es_extended: ${state(dependency('es_extended'))}.`;
      if(name==='qbcore')note=`Dependency qb-core: ${state(dependency('qb-core'))}.`;
      if(name==='ox')note=['ox_lib','ox_target','oxmysql'].filter(resource=>dependency(resource).installed).map(resource=>`${resource}: ${state(dependency(resource))}.`).join(' ');
      if(name==='execute_lua'||name==='execute_js')note=clientNote;
      if(name==='logs')note=logNote;
      return {name,description:[toolDescriptions[name],note].filter(Boolean).join(' '),inputSchema,outputSchema};
    });
  }
  call(name:string,args:Record<string,unknown>,sessionId:string,context?:ConfirmationContext){return this.registry[name]!.handler(args,sessionId,context);}
  private refreshDependencies(){this.dependencies=Object.entries(versions).map(([resource,expectedVersion])=>{const state=GetResourceState(resource),version=GetResourceMetadata(resource,'version',0)||null;return {resource,version,expectedVersion,epoch:state==='started'?String(this.resources.epoch(resource)):null,state:state==='missing'?'missing':state!=='started'?'stopped':version!==expectedVersion?'version_mismatch':'detected',methods:dependencyMethods(resource,state==='started'&&version===expectedVersion,this.clients.snapshots().some(client=>client.ready))};});}
  status(){return {service:'fivem-mcp',resourceName:this.options.resourceName,resourceEpoch:this.options.resourceEpoch,buildId:this.options.buildId,runtime:{node:process.version,platform:process.platform,artifact:null},listener:{host:'127.0.0.1',port:this.options.config.port,path:'/mcp'},javascript:{mode:'native' as const,syntax:'ES2022' as const,hostAccess:'explicit' as const},clients:this.clients.snapshots(),dependencies:this.dependencies,logs:[this.logs.coverage(),...this.clients.snapshots().map(c=>this.clientLogs.coverage(c.clientId))],queue:this.tasks.overview()};}
  ingestClientLogs(marker:string,fileId:string,startOffset:number,endOffset:number,lines:string[]){
    const ready=new Set(this.clients.snapshots().filter(client=>client.ready).map(client=>client.clientId));
    return this.clientLogs.ingest(marker,fileId,startOffset,endOffset,lines,ready);
  }
  private async handleCall(name:string,args:Record<string,unknown>,sessionId:string,context?:ConfirmationContext){
    if(['esx','qbcore','ox'].includes(name)&&!(await this.hasTool(name)))throw new McpError(ErrorCode.InvalidParams,`unknown tool: ${name}`);
    if(name==='reference'){try{return output({ok:true,data:await this.reference.search(args as unknown as {query:string})});}catch{return output({ok:false,error:error('REFERENCE_UNAVAILABLE','Reference sources unavailable','not_applicable','read')});}}
    if(name==='status'){try{await this.options.host.run(()=>this.refreshDependencies());}catch{return output({ok:false,error:error('HOST_UNAVAILABLE','Dependency status could not be refreshed','not_applicable','read')});}const data=this.status();if(args.clientId!==undefined)data.clients=data.clients.filter(c=>c.clientId===args.clientId);return output({ok:true,data});}
    if(name==='queue'){
      const id=args.taskId as string|undefined;
      if(args.action==='status'){
        if(!id)return output({ok:true,data:{kind:'overview',overview:this.tasks.overview()}});
        const task=this.tasks.get(id);return task?output({ok:true,data:{kind:'task',task}}):output({ok:false,error:error('TASK_NOT_FOUND')});
      }
      const result=args.action==='cancel'?this.tasks.cancel(id!):await this.tasks.recover(id!);
      return result.ok?output({ok:true,data:{kind:args.action==='recover'?'recovery':'task',task:result.task,...(args.action==='recover'?{paused:this.tasks.overview().paused}:{})}}):output(result as unknown as Record<string,unknown>);
    }
    if(name==='logs'){
      const side=String(args.side??'client');
      const clients=this.clients.snapshots().filter(c=>c.ready);let clientId=args.clientId as number|undefined;
      if(side!=='server'){
        if(clientId===undefined&&clients.length>1)throw new McpError(ErrorCode.InvalidParams,'clientId is required when multiple clients are connected');
        if(clientId===undefined&&clients.length===1)clientId=clients[0]!.clientId;
        if(clientId!==undefined&&!clients.some(c=>c.clientId===clientId)||clientId===undefined)return output({ok:false,error:error('TARGET_UNAVAILABLE','Client is not connected','not_applicable','read')});
      }
      const coverage=[...(side!=='client'?[this.logs.coverage()]:[]),...(side!=='server'&&clientId!==undefined?[this.clientLogs.coverage(clientId)]:[])];
      if(side==='client'&&!coverage.some(c=>['available','partial'].includes(c.state)))return output({ok:false,error:error('LOG_SOURCE_UNAVAILABLE','Client log source unavailable','not_applicable','read')});
      return output({ok:true,data:{...this.logs.query({...args,side:clientId===undefined?'server':side as 'all'|'client'|'server',clientId}),coverage}});
    }
    if(name==='resource'){
      try {
        if(args.action==='list'||args.action==='status')return output({ok:true,data:await this.options.host.run(()=>this.resources.read(args.name as string|undefined))});
        await this.options.host.run(()=>this.resources.check(String(args.action),String(args.name)));
      }catch(e){const code=String(e).split(': ').at(-1) as TaskErrorCode;return output({ok:false,error:error(code)});}
    }
    let playerId:number|undefined,playerConnectionId:string|undefined;
    let dependency:string|undefined;
    let dependencyEpoch:string|undefined;
    if(['esx','qbcore','ox'].includes(name)){
      dependency=name==='esx'?'es_extended':name==='qbcore'?'qb-core':String(args.library);
      try{
        await this.options.host.run(()=>{if(GetResourceState(dependency!)!=='started')throw new Error('DEPENDENCY_MISSING');if(GetResourceMetadata(dependency!,'version',0)!==versions[dependency!])throw new Error('DEPENDENCY_VERSION_UNSUPPORTED');});
        dependencyEpoch=String(this.resources.epoch(dependency));
        if(args.side==='server'&&(args.scope==='player'||['GetPlayerFromId','Functions.GetPlayer'].includes(String(args.method)))){
          playerId=Number(args.scope==='player'?args.playerId:(args.args as unknown[])[0]);
          await this.options.host.run(()=>{if(!GetPlayerName(String(playerId)))throw new Error('TARGET_UNAVAILABLE');if(!this.players.has(playerId!))this.players.set(playerId!,randomUUID());playerConnectionId=this.players.get(playerId!);});
        }
        if(dependency==='oxmysql'&&!isReadOnly(String(args.method),String((args.args as unknown[])[0]))){
          if(!context)throw new Error('CONFIRMATION_UNSUPPORTED');
          await this.confirmations.approve(sessionId,args,dependencyEpoch,context,()=>this.options.sessionValid(sessionId)&&String(this.resources.epoch(dependency!))===dependencyEpoch);
        }
      }catch(e){const candidate=String(e).split(': ').at(-1)!;const code=(['TARGET_UNAVAILABLE','DEPENDENCY_MISSING','DEPENDENCY_VERSION_UNSUPPORTED','CONFIRMATION_UNSUPPORTED','CONFIRMATION_LIMIT','CONFIRMATION_TOO_LARGE','CONFIRMATION_EXPIRED','CONFIRMATION_CANCELLED','CONFIRMATION_DECLINED'].includes(candidate)?candidate:'INTERNAL_ERROR') as TaskErrorCode;return output({ok:false,error:error(code)});}
    }
    const binding:TaskBinding|null=args.side==='client'?this.clients.resolveTarget(Number(args.clientId)):{side:'server',resourceEpoch:this.options.resourceEpoch};
    if(!binding)return output({ok:false,error:error('TARGET_UNAVAILABLE','No ready client binding')});
    try {bounded(args.args??{});if(Buffer.byteLength(String(args.code),'utf8')>65536)throw new Error('INPUT_TOO_LARGE');}
    catch(e){return output({ok:false,error:error(String(e).includes('INPUT_TOO_COMPLEX')?'INPUT_TOO_COMPLEX':'INPUT_TOO_LARGE')});}
    const accepted=this.tasks.submit({sessionId,tool:name as 'execute_js'|'execute_lua'|'resource'|'esx'|'qbcore'|'ox',target:{binding,...(playerId===undefined?{}:{playerId,playerConnectionId}),...(dependency?{resource:dependency,dependencyEpoch}:name==='resource'?{resource:String(args.name),dependencyEpoch:String(this.resources.epoch(String(args.name)))}:{})},payload:{...args,_sessionId:sessionId,args:args.args??(['esx','qbcore','ox'].includes(name)?[]:{}),timeoutMs:args.timeoutMs??10000},timeoutMs:args.timeoutMs as number|undefined});
    if(!accepted.ok)return output(accepted as unknown as Record<string,unknown>);
    const until=performance.now()+1000;
    let task=accepted.task;
    while(!this.stopped&&performance.now()<until&&(task.state==='queued'||task.state==='running')){await new Promise(resolve=>setTimeout(resolve,10));task=this.tasks.get(task.taskId)??task;}
    return ['failed','cancelled','unknown'].includes(task.state)?output({ok:false,error:task.error,task}):output({ok:true,data:task});
  }
  sessionClosed(id:string){this.confirmations.close(id);this.tasks.sessionClosed(id);}
  async stop(){this.stopped=true;clearInterval(this.maintenance);this.clients.stop();this.clientLogs.stop();this.reference.stop();this.confirmations.close();this.resources.stop();this.logs.stop();await this.tasks.stop();}
}
