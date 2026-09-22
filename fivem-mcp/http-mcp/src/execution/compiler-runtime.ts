import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Compilation } from '../compiler.ts';
interface CompilerModule { initialize():{version:string;warmupMs:number}; compile(input:{code:string}):Compilation }
export class CompilerRuntime {
  state: 'starting' | 'ready' | 'faulted' = 'starting';
  reason: string | null = null;
  private module: CompilerModule | null = null;
  private filename: string | null = null;
  private release: (()=>void) | null = null;
  private budgetExceededCount=0;
  private clock: ()=>number;
  private report: (data:Record<string,unknown>)=>void;
  constructor(clock:()=>number = ()=>performance.now(), report:(data:Record<string,unknown>)=>void = ()=>{}) {this.clock=clock;this.report=report;}
  initialize(resourcePath: string): void {
    const start=this.clock();
    try {
      this.filename=join(resourcePath,'dist','compiler-runtime.cjs');
      const require=createRequire(this.filename);
      // Only our owned module is invalidated; dependencies are bundled within it.
      delete require.cache[this.filename];
      this.release=()=>{if(this.filename) delete require.cache[this.filename];};
      this.module=require(this.filename) as CompilerModule;
      const result=this.module.initialize();
      const elapsedMs=this.clock()-start;
      if(result.version!=='5.9.3') throw new Error('Unsupported compiler version');
      if(elapsedMs>5000) throw new Error('Compiler initialization exceeded 5000ms');
      this.state='ready';this.reason=null;
      this.report({version:result.version,coldStartMs:elapsedMs,warmupMs:result.warmupMs});
    } catch(error) {this.fault(String(error));}
  }
  compile(code:string):Compilation {
    if(this.state!=='ready'||!this.module) throw new Error('COMPILER_UNAVAILABLE');
    const start=this.clock();
    let result:Compilation;
    try {result=this.module.compile({code});}
    catch(error) {this.fault(String(error));throw new Error('COMPILER_UNAVAILABLE');}
    const elapsedMs=this.clock()-start;
    if(elapsedMs>5000)this.budgetExceededCount++;
    this.report({version:'5.9.3',budgetExceededCount:this.budgetExceededCount,elapsedMs,codeBytes:Buffer.byteLength(code,'utf8'),budgetExceeded:elapsedMs>5000});
    if(elapsedMs>5000) {this.fault('Preparation exceeded 5000ms');throw new Error('PREPARATION_TIMEOUT');}
    if(result.diagnostics.length) throw new Error('COMPILE_FAILED: '+result.diagnostics.slice(0,8).map(d=>`${d.line}:${d.column} ${d.message}`).join('; ').slice(0,2048));
    return result;
  }
  status() {return {state:this.state,version:'5.9.3' as const,reason:this.reason};}
  fault(reason:string) {this.state='faulted';this.reason=reason.slice(0,1024)||'Compiler fault';}
  stop() {this.module=null;this.release?.();this.release=null;}
}
