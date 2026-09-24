import {createHash} from 'node:crypto';
import {lookup} from 'node:dns';
import {get} from 'node:https';
import offline from '../../data/reference.json' with {type:'json'};
const urls=[
 'https://runtime.fivem.net/doc/natives.json','https://runtime.fivem.net/doc/natives_cfx.json',
 'https://docs.fivem.net/docs/scripting-reference/events/',
 'https://docs.fivem.net/docs/scripting-manual/runtimes/javascript/',
 'https://docs.fivem.net/docs/scripting-manual/working-with-events/listening-for-events/',
 'https://docs.fivem.net/docs/scripting-manual/introduction/introduction-to-resources/',
] as const;
interface Item {name:string;category:string;side:string;summary:string;sourceUrl:string;revision:string;contentHash:string;source:string;fetchedAt?:string;signature?:string}
interface Query {query:string;category?:string;side?:string;limit?:number}
interface ResponseData {text:string;etag?:string}
type Fetcher=(url:string,signal:AbortSignal)=>Promise<ResponseData>;
function publicIPv4(address:string):boolean {const n=address.split('.').map(Number);return n.length===4&&n[0]!==0&&n[0]!==10&&n[0]!==127&&n[0]!<224&&!(n[0]===169&&n[1]===254)&&!(n[0]===172&&n[1]!>=16&&n[1]!<=31)&&!(n[0]===192&&n[1]===168)&&!(n[0]===100&&n[1]!>=64&&n[1]!<=127);}
function fetchBounded(url:string,signal:AbortSignal,redirects=0):Promise<ResponseData>{
 if(!(urls as readonly string[]).includes(url))return Promise.reject(new Error('URL not allowed'));
 return new Promise((resolve,reject)=>{
  const req=get(url,{signal,headers:{'accept-encoding':'identity'},lookup:(hostname,options,callback)=>{
   lookup(hostname,{family:4},(err,address,family)=>{
    if(err||!publicIPv4(address)){callback(err??new Error('Non-public address'),'',4);return;}
    if(options.all)(callback as unknown as (error:Error|null,addresses:{address:string;family:number}[])=>void)(null,[{address,family}]);else callback(null,address,family);
   });
  }},res=>{
   if(res.statusCode&&[301,302,303,307,308].includes(res.statusCode)){
    res.resume();const next=res.headers.location?new URL(res.headers.location,url).href:'';
    if(redirects>=1){reject(new Error('Redirect limit'));return;}
    void fetchBounded(next,signal,redirects+1).then(resolve,reject);return;
   }
   if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.resume();reject(new Error('Source unavailable'));return;}
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024){res.destroy(new Error('Source exceeds 4MiB'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>resolve({text:Buffer.concat(chunks).toString('utf8'),etag:res.headers.etag}));
  });req.on('error',reject);
 });
}
export class ReferenceSearch {
 private enabled:boolean;private fetcher:Fetcher;private active=0;
 private stopped=false;private controllers=new Set<AbortController>();
 private cache=new Map<string,{expires:number;data:ResponseData;bytes:number}>();
 constructor(enabled:boolean,fetcher:Fetcher=fetchBounded){this.enabled=enabled;this.fetcher=fetcher;}
 stop(){this.stopped=true;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.cache.clear();}
 async search(args:Query){
  if(this.stopped)throw new Error('REFERENCE_UNAVAILABLE');
  const query=args.query.trim().toUpperCase(),limit=args.limit??5;
  if(!query)throw new Error('Reference query must be nonempty after trimming');
  const match=(items:Item[])=>items.filter(i=>(!args.category||args.category==='all'||i.category===args.category)&&(!args.side||args.side==='all'||i.side===args.side||i.side==='shared')).map(i=>({i,rank:i.name.toUpperCase()===query?0:i.name.toUpperCase().startsWith(query)?1:(i.name+' '+i.summary).toUpperCase().includes(query)?2:3})).filter(x=>x.rank<3).sort((a,b)=>a.rank-b.rank||a.i.name.localeCompare(b.i.name)||a.i.sourceUrl.localeCompare(b.i.sourceUrl)).map(x=>x.i);
  let found=match(offline);if(found.length||!this.enabled)return {items:found.slice(0,limit),searchedOnline:false,truncated:found.length>limit,warnings:[]};
  if(this.active>=2)throw new Error('REFERENCE_UNAVAILABLE');this.active++;
  const abort=new AbortController();this.controllers.add(abort);const timer=setTimeout(()=>abort.abort(),5000);let bytes=0;
  const warnings:string[]=[],items:Item[]=[];
  try{
   const selected=urls.filter((_,i)=>!args.category||args.category==='all'||args.category==='native'&&i<2||args.category==='event'&&i===2||args.category==='guide'&&i>=3);
   for(const url of selected){
    try{
     if(abort.signal.aborted)throw new Error('deadline');
     let data=this.cache.get(url);if(data&&data.expires<Date.now()){this.cache.delete(url);data=undefined;}
     const response=data?.data??await this.fetcher(url,abort.signal);
     const size=Buffer.byteLength(response.text);bytes+=size;if(size>4*1024*1024||bytes>8*1024*1024)throw new Error('response budget');
     if(!data){this.cache.set(url,{expires:Date.now()+60000,data:response,bytes:size});while([...this.cache.values()].reduce((n,v)=>n+v.bytes,0)>8*1024*1024)this.cache.delete(this.cache.keys().next().value!);}
     const hash=createHash('sha256').update(response.text).digest('hex');const common={sourceUrl:url,revision:(response.etag??hash).slice(0,128),contentHash:hash,source:'online',fetchedAt:new Date().toISOString()};
     if(url.endsWith('.json')){
      const namespaces=JSON.parse(response.text) as Record<string,Record<string,{name?:string;description?:string;apiset?:string;api_set?:string;params?:{name:string;type:string}[];results?:string}>>;
      for(const ns of Object.values(namespaces))for(const [nativeHash,n] of Object.entries(ns)){
       const side=n.apiset??n.api_set??(url.includes('_cfx')?'shared':'client');
       items.push({...common,name:(n.name??nativeHash).slice(0,256),category:'native',side:['server','client','shared'].includes(side)?side:'shared',summary:(nativeHash.toUpperCase()+' '+(n.description??'')).slice(0,8192)});
      }
     }else{
      const main=/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i.exec(response.text)?.[1]??'';
      const text=main.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const name=/<title[^>]*>(.*?)<\/title>/i.exec(response.text)?.[1]??url;
      if(text.toUpperCase().includes(query))items.push({...common,name:name.slice(0,256),category:url.includes('reference/events')?'event':'guide',side:'shared',summary:text.slice(Math.max(0,text.toUpperCase().indexOf(query)-100),Math.max(0,text.toUpperCase().indexOf(query)-100)+8192)});
     }
    }catch{warnings.push('Unavailable source: '+url);}
   }
   found=match(items);if(!found.length&&warnings.length)throw new Error('REFERENCE_UNAVAILABLE');
   return {items:found.slice(0,limit),searchedOnline:true,truncated:found.length>limit,warnings};
  }finally{clearTimeout(timer);abort.abort();this.controllers.delete(abort);this.active--;}
 }
}
