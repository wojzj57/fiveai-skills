import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createRequire} from 'node:module';
test('every awaited continuation resumes on a host tick',async()=>{
 const {runOnHost}=await import('../http-mcp/src/execution/javascript.ts');
 const dir=await mkdtemp(join(tmpdir(),'async-host-'));let inHost=false,calls=0;
 const host={run:async fn=>{inHost=true;try{calls++;return fn();}finally{inHost=false;}}};
 try{const path=join(dir,'compiler.cjs');await build({entryPoints:['http-mcp/src/compiler.ts'],outfile:path,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});const compiler=createRequire(import.meta.url)(path);
 for(const code of [
  'await Promise.resolve(); return args.native();',
  'for await(const n of [Promise.resolve(1)]) { await Promise.resolve(n); } return args.native();',
  'const call=async()=>{await Promise.resolve();return args.native();};return await call();',
  'async function* values(){await Promise.resolve();yield args.native();} for await(const n of values())return n;',
  'class Base { read(){return args.native();} } class Child extends Base { async read(){await Promise.resolve();return super.read();} } return await new Child().read();',
 ]){
  const result=compiler.compile({code});assert.deepEqual(result.diagnostics,[]);
  assert.equal(await runOnHost(result.hostJavascript,{native:()=>{assert.equal(inHost,true);return 42;}},host),42);assert.ok(calls>=2);
 }
 const {mappedError}=await import('../http-mcp/src/execution/javascript.ts');
 const failure=compiler.compile({code:'await Promise.resolve();\nthrow new Error("mapped");'});
 try{await runOnHost(failure.hostJavascript,{},host);assert.fail('expected error');}catch(error){assert.match(mappedError(error,failure.hostSourceMap).stack,/snippet.ts:2:/);}

 }finally{await rm(dir,{recursive:true,force:true});}
});
