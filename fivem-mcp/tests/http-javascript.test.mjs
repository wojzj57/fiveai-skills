import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('bundled JS executes with no filesystem grant for resource files or a compiler',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mcp-js-permission-'));
  try{
    const outfile=join(dir,'javascript.cjs');
    await build({entryPoints:['http-mcp/src/execution/javascript.ts'],outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
    const script=`
      const assert=require('node:assert/strict');
      assert.throws(()=>require('node:fs').readFileSync('dist/compiler-runtime.cjs'),{code:'ERR_ACCESS_DENIED'});
      const {prepareJavaScript,runOnHost}=require(process.argv[1]);
      const plan=prepareJavaScript('await Promise.resolve(); return await mcp.host(() => 42);');
      runOnHost(plan.javascript,{}, {run:async fn=>fn()}).then(value=>assert.equal(value,42)).catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const result=spawnSync(process.execPath,['--experimental-permission','--allow-fs-read='+outfile,'-e',script,outfile],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('native JS accepts async function bodies and rejects TS and module syntax before execution',async()=>{
  const {prepareJavaScript,runOnHost}=await import('../http-mcp/src/execution/javascript.ts');
  const host={run:async fn=>fn()};
  const plan=prepareJavaScript('const n = await Promise.resolve(args.n); return n+1;');
  assert.equal(await runOnHost(plan.javascript,{n:41},host),42);
  for(const code of ['const n: number = 1; return n;','import x from "x";','export const a=1;','return import("x");','return require("x");','return requ\\u0069re("x");','return );','function f(){ await 1; }','}); throw new Error("escape"); (function(){']){
    assert.throws(()=>prepareJavaScript(code),/JAVASCRIPT_INVALID/);
  }
  assert.throws(()=>prepareJavaScript('中'.repeat(22000)),/INPUT_TOO_LARGE/);
});

test('JS starts on Host Tick and explicit host callbacks resume after await',async()=>{
  const {prepareJavaScript,runOnHost,mappedError}=await import('../http-mcp/src/execution/javascript.ts');
  let inHost=false,calls=0;
  const host={run:async fn=>{inHost=true;calls++;try{return fn();}finally{inHost=false;}}};
  const plan=prepareJavaScript('args.native(); await Promise.resolve(); return await mcp.host(() => args.native());');
  assert.equal(await runOnHost(plan.javascript,{native:()=>{assert.equal(inHost,true);return 42;}},host),42);
  assert.equal(calls,2);
  const failure=prepareJavaScript('await Promise.resolve();\nthrow new Error("mapped");');
  await assert.rejects(runOnHost(failure.javascript,{},host),error=>{
    assert.match(mappedError(error).stack,/snippet.js:2:/);return true;
  });
});
