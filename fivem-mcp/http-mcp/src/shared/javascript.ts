export interface JavaScriptHost {run<T>(fn:()=>T):Promise<T>}

/** Trusted developer code. Native access after await must use mcp.host(). */
export function runOnHost(expression:string,args:unknown,host:JavaScriptHost):Promise<unknown> {
  const create=new Function(`return ${expression};\n//# sourceURL=mcp-snippet.js`) as ()=>(args:unknown,mcp:{host:JavaScriptHost['run']})=>unknown;
  const mcp=Object.freeze({host:<T>(fn:()=>T)=>{
    if(typeof fn!=='function')return Promise.reject(new TypeError('mcp.host expects a callback'));
    return host.run(fn);
  }});
  return host.run(()=>create()(args,mcp));
}
