import test from 'node:test';import assert from 'node:assert/strict';
import {dependencyMethods} from '../http-mcp/src/adapters/dependencies.ts';
test('method detection follows the pinned core and player layers',()=>{
 const old=globalThis.exports;
 try{
  const esxPlayer=Object.fromEntries(['getMoney','getJob','getAccount','addMoney','removeMoney','setJob'].map(name=>[name,()=>false]));
  const qbPlayer={Functions:Object.fromEntries(['GetMoney','AddMoney','RemoveMoney','SetJob','SetJobDuty'].map(name=>[name,()=>false]))};
  globalThis.exports={es_extended:{getSharedObject:()=>({GetPlayers:()=>[7],GetPlayerFromId:()=>esxPlayer})},'qb-core':{GetCoreObject:()=>({Functions:{GetPlayers:()=>[7],GetPlayer:()=>qbPlayer}})}};
  for(const resource of ['es_extended','qb-core']){
   const detected=dependencyMethods(resource,true,true);
   assert.ok(detected.length>0);assert.ok(detected.every(method=>method.available));
   assert.ok(dependencyMethods(resource,false,true).every(method=>!method.available));
  }
 }finally{globalThis.exports=old;}
});
