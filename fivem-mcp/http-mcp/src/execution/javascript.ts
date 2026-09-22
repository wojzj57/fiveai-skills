import {parse} from 'acorn';
export {runOnHost} from '../shared/javascript.ts';

/** Parse JavaScript only. No transpilation, module loading or user-code execution. */
export function prepareJavaScript(code:string):{javascript:string} {
  if(Buffer.byteLength(code,'utf8')>65536)throw new Error('INPUT_TOO_LARGE');
  try {
    const tree=parse(code,{ecmaVersion:2022,sourceType:'script',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true});
    const pending:unknown[]=[tree];
    while(pending.length){
      const value=pending.pop();
      if(!value||typeof value!=='object')continue;
      const node=value as Record<string,unknown>;
      if(node.type==='ImportExpression'||node.type==='ImportDeclaration'||String(node.type).startsWith('Export'))throw new Error('Module import/export is not allowed');
      if(node.type==='CallExpression'&&node.callee&&typeof node.callee==='object'&&(node.callee as {type?:string;name?:string}).type==='Identifier'&&(node.callee as {name?:string}).name==='require')throw new Error('require is not allowed');
      for(const child of Object.values(node))if(child&&typeof child==='object')pending.push(...(Array.isArray(child)?child:[child]));
    }
    const javascript=`(async function(args,mcp) {\n${code}\n})`;
    new Function(`return ${javascript};`);
    return {javascript};
  }catch(error){throw new Error('JAVASCRIPT_INVALID: '+String(error).slice(0,2048));}
}

export function mappedError(value:unknown):{message:string;stack?:string} {
  const message=value instanceof Error?value.message:String(value);
  const stack=value instanceof Error?value.stack:undefined;
  const frames=stack?[...stack.matchAll(/mcp-snippet\.js:(\d+):(\d+)/g)].map(match=>`    at snippet.js:${Math.max(1,Number(match[1])-3)}:${match[2]}`):[];
  return {message:message.slice(0,4096),...(frames.length?{stack:(message+'\n'+frames.join('\n')).slice(0,8192)}:{})};
}
