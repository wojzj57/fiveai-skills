#!/usr/bin/env node
/** Build into an isolated staging tree; publish under an exclusive per-output lock. */
import {build} from 'esbuild';
import {cp,mkdir,readdir,rename,rm,readFile,writeFile,open,lstat} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve,relative,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {getBuildIdentity} from './build-identity.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),repoRoot=dirname(root.replace(/[\\/]+$/,'')),source=join(root,'http-mcp');
const DEFAULT_OUTPUT=join(root, "artificials", "fivem-mcp");
const argv=process.argv.slice(2);let artifact=DEFAULT_OUTPUT,pack=false;
for(let i=0;i<argv.length;i++){if(argv[i]==='--pack')pack=true;else if(argv[i]==='--out'&&argv[i+1]&&!argv[i+1].startsWith('--'))artifact=resolve(argv[++i]);else throw new Error('Unknown or missing argument: '+argv[i]);}
artifact=resolve(artifact);if(artifact===resolve(root)||resolve(root).startsWith(artifact+sep)||artifact===repoRoot)throw new Error('Unsafe output path');
const parent=dirname(artifact),lockPath=artifact+'.publish-lock',backup=artifact+'.backup';
const staging=join(parent,'.'+basename(artifact)+'.staging-'+randomUUID());
await mkdir(parent,{recursive:true});
let lock;
try{lock=await open(lockPath,'wx');}catch(e){
 if(e.code!=='EEXIST')throw e;
 let owner;try{owner=JSON.parse(await readFile(lockPath,'utf8'));}catch{throw new Error('Invalid publish lock; inspect '+lockPath);}
 try{process.kill(owner.pid,0);throw new Error('Publish already in progress');}catch(reason){if(reason.code!=='ESRCH')throw reason;}
 await rm(lockPath);lock=await open(lockPath,'wx');
}
await lock.writeFile(JSON.stringify({pid:process.pid,artifact,staging}));
const fixed=new Set(['fxmanifest.lua','README.md','LICENSE','NOTICE','dist/server.js','dist/client.js','dist/compiler-runtime.cjs','dist/compiler.cjs','lua/server.lua','lua/client.lua','lua/adapters.lua','hashes.json']);
async function files(dir,prefix=''){
 const out=[];
 for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=prefix+e.name;
  if(e.isSymbolicLink())throw new Error('Refusing symbolic link in artifact: '+name);
  if(e.isDirectory())out.push(...await files(join(dir,e.name),name+'/'));
  else if(e.isFile())out.push(name);else throw new Error('Unsupported artifact entry: '+name);
 }return out;
}
async function removeOwned(path){if(dirname(resolve(path))!==parent||![staging,backup].includes(path))throw new Error('Unsafe cleanup target');await rm(path,{recursive:true,force:true});}
async function verify(dir){const hashes=JSON.parse(await readFile(join(dir,'hashes.json'),'utf8'));for(const [name,expected]of Object.entries(hashes)){if(name.includes('..')||name.startsWith('/')||name.includes('\\'))throw new Error('Unsafe hash path');const actual=createHash('sha256').update(await readFile(join(dir,name))).digest('hex');if(actual!==expected)throw new Error('Artifact integrity failure: '+name);}}
try{
 if(existsSync(backup)&&!existsSync(artifact)){await verify(backup);await rename(backup,artifact);}
 if(existsSync(artifact)){
  if((await lstat(artifact)).isSymbolicLink())throw new Error('Refusing symlink output');
  let prior={};if(existsSync(join(artifact,'hashes.json')))prior=JSON.parse(await readFile(join(artifact,'hashes.json'),'utf8'));
  const unknown=(await files(artifact)).filter(f=>!fixed.has(f)&&!f.startsWith('config/')&&!Object.hasOwn(prior,f));
  if(unknown.length)throw new Error('Refusing unknown artifact files: '+unknown.join(', '));
 }
 await mkdir(join(staging,'dist'),{recursive:true});
 const identity=getBuildIdentity(repoRoot);
 const common={bundle:true,target:'node22',logLevel:'warning',metafile:true};
 const server=await build({...common,entryPoints:[join(source,'src/server.ts')],outfile:join(staging,'dist/server.js'),platform:'node',format:'cjs',define:{__HTTP_MCP_BUILD__:JSON.stringify(identity.digest)}});
 await build({...common,entryPoints:[join(source,'src/client/main.ts')],outfile:join(staging,'dist/client.js'),platform:'browser',format:'iife',target:'es2022'});
 for(const file of ['fxmanifest.lua','README.md','LICENSE','NOTICE'])await cp(join(source,file),join(staging,file));
 for(const dir of ['lua','data','config'])await cp(join(source,dir),join(staging,dir),{recursive:true});
 // Include the exact licenses of bundled npm packages, without workspace dependencies.
 const packaged=new Set();
 for(const input of Object.keys(server.metafile.inputs)){
  if(!input.includes('node_modules'))continue;let dir=dirname(resolve(input));
  while(dir!==dirname(dir)){if(existsSync(join(dir,'package.json'))){const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(manifest.name&&manifest.version)break;}dir=dirname(dir);}
  if(!existsSync(join(dir,'package.json'))||packaged.has(dir))continue;packaged.add(dir);
  const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  for(const entry of await readdir(dir)){if(!/^licen[sc]e(?:\.|$)/i.test(entry)||!(await lstat(join(dir,entry))).isFile())continue;
   const dest=join(staging,'data/licenses',(manifest.name+'@'+manifest.version).replaceAll('/','__'));await mkdir(dest,{recursive:true});await cp(join(dir,entry),join(dest,entry));
  }
 }
 const managed=await files(staging),hashes={};for(const file of managed)hashes[file]=createHash('sha256').update(await readFile(join(staging,file))).digest('hex');
 await writeFile(join(staging,'hashes.json'),JSON.stringify(hashes,null,2)+'\n');await verify(staging);
 let archive;
 if(pack){const entries={};for(const file of [...managed,'hashes.json'])entries['fivem-mcp/'+file]=new Uint8Array(await readFile(join(staging,file)));archive=zipSync(entries,{level:6});}
 if(existsSync(join(artifact,'config'))){
  await cp(join(artifact,'config'),join(staging,'config'),{recursive:true});
  // Installed config is operator-owned. The ZIP retains the clean example.
  for(const file of Object.keys(hashes))if(file.startsWith('config/'))hashes[file]=createHash('sha256').update(await readFile(join(staging,file))).digest('hex');
  await writeFile(join(staging,'hashes.json'),JSON.stringify(hashes,null,2)+'\n');
 }
 if(existsSync(backup))await removeOwned(backup);
 const previous=existsSync(artifact);if(previous)await rename(artifact,backup);
 try{
  await rename(staging,artifact);
  if(archive){const zipTemp=artifact+'.zip.'+randomUUID()+'.tmp';try{await writeFile(zipTemp,archive);await rename(zipTemp,artifact+'.zip');}finally{await rm(zipTemp,{force:true});}}
 }catch(e){
  if(existsSync(artifact))await rename(artifact,staging);
  if(previous&&existsSync(backup))await rename(backup,artifact);
  throw e;
 }
 if(existsSync(backup))await removeOwned(backup);
 console.log('FiveAI HTTP MCP resource ready: '+artifact);console.log('buildId: '+identity.digest);
}finally{if(existsSync(staging))await removeOwned(staging);await lock.close();await rm(lockPath,{force:true});}
