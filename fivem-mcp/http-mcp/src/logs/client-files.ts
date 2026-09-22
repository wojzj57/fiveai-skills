import {open,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import type {LogStore} from './store.ts';
interface Source {marker:string;state:string;reason:string|null;path?:string;identity?:string;offset:number;markerOffset?:number;decoder:StringDecoder;pending:string;gap:boolean;checkedAt:number}
export class ClientLogs {
  private sources=new Map<number,Source>();private dirs:string[];private store:LogStore;private stopped=false;private polling=false;private scanCursor=0;private fileCursor=0;private clock:()=>number;
  constructor(dirs:string[],store:LogStore,clock:()=>number=()=>performance.now()){this.dirs=dirs;this.store=store;this.clock=clock;}
  bind(id:number,marker:string){this.store.clearClient(id);this.sources.set(id,{marker,state:this.dirs.length?'unlocated':'unconfigured',reason:null,offset:0,decoder:new StringDecoder('utf8'),pending:'',gap:false,checkedAt:0});}
  unbind(id:number){this.store.clearClient(id);const s=this.sources.get(id);if(s){s.path=undefined;s.state='unavailable';s.reason='Binding lost';s.gap=true;}}
  coverage(id:number){const s=this.sources.get(id);return {...this.store.coverage('client',id,s?.state??'unconfigured',s?.reason??null),gap:s?.gap??false};}
  async poll(){
    if(this.stopped||this.polling)return;this.polling=true;
    let scanBudget=32*1024*1024;const fileStart=this.fileCursor++;
    try{
      // Serial file IO stays below the maximum concurrency of two.
      const entries=[...this.sources];const ordered=entries.slice(this.scanCursor).concat(entries.slice(0,this.scanCursor));this.scanCursor=entries.length?(this.scanCursor+1)%entries.length:0;
      for(const [id,s] of ordered){
        if(this.stopped)break;if(s.state==='unconfigured'||s.reason==='Binding lost')continue;
        try{
          if(!s.path||this.clock()-s.checkedAt>5000){
            let incomplete=false;
            const hits:{path:string;identity:string;offset:number;markerOffset:number}[]=[];
            if(s.path&&s.markerOffset!==undefined){
              try{const stat=await lstat(s.path);if(stat.isFile()&&!stat.isSymbolicLink()&&String(stat.dev)+':'+String(stat.ino)===s.identity&&stat.size>=s.offset){
                const handle=await open(s.path,'r'),marker=Buffer.alloc(Buffer.byteLength(s.marker));try{await handle.read(marker,0,marker.length,s.markerOffset);}finally{await handle.close();}
                if(marker.toString('utf8')===s.marker)hits.push({path:s.path,identity:s.identity!,offset:s.offset,markerOffset:s.markerOffset});
              }}catch{/* Candidate enumeration records a current coverage gap below. */}
            }
            for(const dir of this.dirs){
              const entries=await readdir(dir,{withFileTypes:true});
              const files=entries.filter(e=>e.isFile()&&/^CitizenFX.*\.log$/i.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
              if(files.length>32){s.gap=true;incomplete=true;}
              const startIndex=files.length?fileStart%files.length:0;
              for(const file of files.slice(startIndex).concat(files.slice(0,startIndex)).slice(0,32)){
                const path=join(dir,file.name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())continue;
                const identity=String(stat.dev)+':'+String(stat.ino);
                if(hits.some(hit=>hit.path===path))continue;
                const length=Math.min(stat.size,4*1024*1024,scanBudget);if(length<=0){if(stat.size>0){s.gap=true;incomplete=true;}continue;}
                scanBudget-=length;const start=stat.size-length;
                const handle=await open(path,'r');const bytes=Buffer.alloc(length);
                let read=0;try{read=(await handle.read(bytes,0,length,start)).bytesRead;}finally{await handle.close();}
                const marker=Buffer.from(s.marker),index=bytes.subarray(0,read).lastIndexOf(marker);
                if(index>=0){const end=bytes.indexOf(10,index+marker.length);if(end>=0)hits.push({path,identity,offset:start+end+1,markerOffset:start+index});}
              }
            }
            if(this.sources.get(id)!==s)continue;
            if(hits.length!==1){s.path=undefined;s.state=hits.length?'ambiguous':'unlocated';s.reason=hits.length?'Multiple files contain the current binding marker':'No current binding marker';continue;}
            if(incomplete){s.gap=true;s.state='partial';s.reason='Directory scan exceeded coverage budget';}else{s.state='available';s.reason=null;}
            s.checkedAt=this.clock();
            if(s.path!==hits[0]!.path||s.identity!==hits[0]!.identity){Object.assign(s,hits[0]);s.decoder=new StringDecoder('utf8');s.pending='';}
          }
          const stat=await lstat(s.path!);
          if(!stat.isFile()||stat.isSymbolicLink()||String(stat.dev)+':'+String(stat.ino)!==s.identity||stat.size<s.offset){s.path=undefined;s.gap=true;s.state='partial';s.reason='File rotated or truncated';continue;}
          const length=Math.min(256*1024,stat.size-s.offset);if(length<=0)continue;
          const handle=await open(s.path!,'r');const buffer=Buffer.alloc(length);let count=0;
          try{count=(await handle.read(buffer,0,length,s.offset)).bytesRead;}finally{await handle.close();}
          if(this.stopped||this.sources.get(id)!==s)continue;
          s.offset+=count;s.pending+=s.decoder.write(buffer.subarray(0,count));
          const lines=s.pending.split('\n');s.pending=lines.pop()??'';
          for(const line of lines){const clean=line.replace(/\r$/,'');const match=/^\[\s*(script:[^\]]+)\]\s*(.*)$/.exec(clean);this.store.append(match?.[1]??'client',match?.[2]??clean,id);}
          if(Buffer.byteLength(s.pending)>16384){this.store.append('client',s.pending,id);s.pending='';s.gap=true;s.state='partial';}
        }catch(e){s.path=undefined;s.state='unavailable';s.reason=String((e as NodeJS.ErrnoException).code??e).slice(0,1024);s.gap=true;}
      }
    }finally{this.polling=false;}
  }
  stop(){this.stopped=true;this.sources.clear();}
}
