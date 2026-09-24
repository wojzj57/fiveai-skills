interface Exports { [resource:string]:Record<string,unknown> }
const methods:Record<string,{server:string[];client:string[]}>= {
 es_extended:{server:['GetPlayerFromId','getMoney','getJob','getAccount','addMoney','removeMoney','setJob'],client:['GetPlayerData','ShowNotification']},
 'qb-core':{server:['Functions.GetPlayers','Functions.GetPlayer','Functions.GetMoney','Functions.AddMoney','Functions.RemoveMoney','Functions.SetJob','Functions.SetJobDuty'],client:['Functions.GetPlayerData','Functions.Notify']},
 ox_lib:{server:[],client:['notify','showTextUI','hideTextUI','isTextUIOpen']},
 ox_target:{server:[],client:['isActive','disableTargeting','zoneExists','removeZone']},
 oxmysql:{server:['query','single','scalar','insert','update','transaction'],client:[]},
};
/** Called only on Host Tick. Client methods require a client runtime to inspect. */
export function dependencyMethods(resource:string,started:boolean,clientReady=false){
 const entries=methods[resource]!;
 let core:Record<string,unknown>|undefined;
 const api=(globalThis as unknown as {exports:Exports}).exports?.[resource];
 if(started&&resource==='es_extended')try{core=(api?.getSharedObject as Function)?.call(api);}catch{}
 if(started&&resource==='qb-core')try{core=(api?.GetCoreObject as Function)?.call(api);}catch{}
 const players:Record<string,unknown>[]=[];
 if(core&&started)try{
  const functions=(resource==='es_extended'?core:core.Functions) as Record<string,Function>;
  const ids=functions.GetPlayers?.()??[];
  for(const id of Object.values(ids).slice(0,64)){
   const player=(resource==='es_extended'?functions.GetPlayerFromId: functions.GetPlayer)?.(id);
   if(player)players.push(resource==='es_extended'?player:player.Functions);
  }
 }catch{}
 return (['server','client'] as const).flatMap(side=>entries[side].map(name=>{
  let available=started&&side==='client'&&clientReady;
  if(started&&side==='server')try{
   if(resource==='oxmysql')available=typeof api?.[name+'_async']==='function';
   else if(resource==='es_extended')available=typeof core?.[name]==='function'||players.some(player=>typeof player[name]==='function');
   else if(resource==='qb-core')available=typeof (core?.Functions as Record<string,unknown>|undefined)?.[name.replace('Functions.','')]==='function'||players.some(player=>typeof player[name.replace('Functions.','')]==='function');
  }catch{}
  return {name,side,available};
 }));
}
