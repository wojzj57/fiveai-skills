import {SourceMap} from 'node:module';
interface Host {run<T>(fn:()=>T):Promise<T>}
export function runOnHost(expression:string,args:unknown,host:Host):Promise<unknown> {
  function resume(iterator:Generator<unknown,unknown,unknown>):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      const step=(method:'next'|'throw',value?:unknown)=>{
        void host.run(()=>iterator[method](value)).then(state=>{
          if(state.done){resolve(state.value);return;}
          Promise.resolve(state.value).then(result=>step('next',result),error=>step('throw',error));
        },reject);
      };
      step('next');
    });
  }
  const awaiter=(self:unknown,values:unknown,_promise:unknown,generator:Function)=>resume(generator.apply(self,values??[]));
  const asyncGenerator=(Await:Function,self:unknown,values:unknown,generator:Function)=>{
    const iterator=generator.apply(self,values??[]);
    let tail=Promise.resolve();
    const invoke=(method:'next'|'throw'|'return',value:unknown)=>{
      const run=async():Promise<IteratorResult<unknown>>=>{
        let state=await host.run(()=>iterator[method](value));
        while(state.value instanceof Await){
          try{const resolved=await state.value.v;state=await host.run(()=>iterator.next(resolved));}
          catch(error){state=await host.run(()=>iterator.throw(error));}
        }
        return state;
      };
      const result=tail.then(run,run);tail=result.then(()=>{},()=>{});return result;
    };
    return {next:(value:unknown)=>invoke('next',value),throw:(value:unknown)=>invoke('throw',value),return:(value:unknown)=>invoke('return',value),[Symbol.asyncIterator](){return this;}};
  };
  const execute=new Function('args','__fiveaiAwaiter','__fiveaiAsyncGenerator',`return (${expression})(args);\n//# sourceURL=mcp-snippet.js`);
  try{return Promise.resolve(execute(args,awaiter,asyncGenerator));}catch(error){return Promise.reject(error);}
}

export function mappedError(value:unknown,map:unknown):{message:string;stack?:string} {
  const message=value instanceof Error?value.message:String(value);
  let stack=value instanceof Error?value.stack:undefined;
  if(stack&&typeof map==='string')try{
    const sourceMap=new SourceMap(JSON.parse(map));
    stack=stack.replace(/mcp-snippet\.js:(\d+):(\d+)/g,(_all,line,column)=>{
      const entry=sourceMap.findEntry(Number(line)-4,Number(column)-1);
      if(!('originalLine' in entry))return _all;
      return 'snippet.ts:'+Math.max(1,Number(entry.originalLine))+':'+(Number(entry.originalColumn)+1);
    });
  }catch{/* Keep the generated position if a runtime supplied no mapping. */}
  if(stack)stack=message+'\n'+[...stack.matchAll(/(?:snippet\.ts|mcp-snippet\.js):\d+:\d+/g)].map(match=>'    at '+match[0]).join('\n');
  return {message:message.slice(0,4096),...(stack?{stack:Buffer.from(stack).subarray(0,8192).toString('utf8')}:{})};
}
