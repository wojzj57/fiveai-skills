import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import {unzipSync} from 'fflate';import {createHash} from 'node:crypto';
test('pack creates a single-root ZIP with verified hashes and preserves operator config',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'mcp-pack-')),out=join(temp,'renamed resource');
 const build=(...args)=>spawnSync(process.execPath,['scripts/build-http-mcp.mjs','--out',out,...args],{encoding:'utf8'});
 try{
  const a=build('--pack');assert.equal(a.status,0,a.stderr);const entries=unzipSync(await readFile(out+'.zip'));
  assert.ok(entries['fivem-mcp/hashes.json']);const hashes=JSON.parse(Buffer.from(entries['fivem-mcp/hashes.json']).toString());
  for(const [path,hash]of Object.entries(hashes))assert.equal(createHash('sha256').update(entries['fivem-mcp/'+path]).digest('hex'),hash,path);
  await writeFile(join(out,'config/config.json'),'{"port":30131}');assert.equal(build().status,0);assert.equal(await readFile(join(out,'config/config.json'),'utf8'),'{"port":30131}');
  await writeFile(join(out,'unknown.txt'),'keep me');const refused=build();assert.notEqual(refused.status,0);assert.equal(await readFile(join(out,'unknown.txt'),'utf8'),'keep me');
 }finally{await rm(temp,{recursive:true,force:true});}
});
