export interface LogLine {sequence:string;collectedAt:string;side:'server'|'client';resource:string|null;channel:string;message:string;forwarded:boolean;truncated:boolean;clientId?:number;raw?:string}
export interface LogQuery {side?:'server'|'client'|'all';clientId?:number;resource?:string;prefix?:string;contains?:string;limit?:number;includeRaw?:boolean}
export class LogStore {
  available=false;
  private lines:LogLine[]=[];
  private sizes:number[]=[];
  private bytes=0;
  private sequence=0n;
  private dropped=0;
  append(channel:string,raw:string,clientId?:number):void {
    const original=Buffer.from(raw,'utf8');
    const truncated=original.length>16384;
    raw=original.subarray(0,16384).toString('utf8');
    const resource=/^script:([^\s:]+)$/.exec(channel)?.[1]??null;
    const line:LogLine={sequence:String(++this.sequence),collectedAt:new Date().toISOString(),side:clientId===undefined?'server':'client',resource,channel:channel.slice(0,256),message:raw.replace(/\x1b\[[0-9;]*m/g,'').replace(/\^[0-9]/g,''),raw,forwarded:/^forwarded:/.test(channel),truncated,...(clientId===undefined?{}:{clientId})};
    const size=Buffer.byteLength(JSON.stringify(line),'utf8');
    this.lines.push(line);this.sizes.push(size);this.bytes+=size;
    while(this.lines.length>10000||this.bytes>16*1024*1024){this.lines.shift();this.bytes-=this.sizes.shift()!;this.dropped++;}
  }
  coverage(side:'server'|'client'='server',clientId?:number,state?:string,reason:string|null=null) {
    const lines=this.lines.filter(l=>l.side===side&&(side==='server'||l.clientId===clientId));
    return {side,state:state??(this.available?'available':'unavailable'),reason:reason??(this.available?null:'RegisterConsoleListener is unavailable'),retainedLines:lines.length,dropped:this.dropped,gap:this.dropped>0,from:lines[0]?.collectedAt??null,to:lines.at(-1)?.collectedAt??null,...(clientId===undefined?{}:{clientId})};
  }
  query(args:LogQuery) {
    const matched=this.lines.filter(l=>(!args.side||args.side==='all'||l.side===args.side)&&(l.side==='server'||args.clientId===undefined||l.clientId===args.clientId)&&(!args.resource||l.resource===args.resource)&&(!args.prefix||l.channel.startsWith(args.prefix))&&(!args.contains||l.message.includes(args.contains)));
    const selected=matched.slice(-(args.limit??100)).map(({raw,...line})=>({...line,...(args.includeRaw?{raw}:{})}));
    let bytes=0;const lines:LogLine[]=[];
    for(let i=selected.length-1;i>=0;i--){const line=selected[i]!;bytes+=Buffer.byteLength(JSON.stringify(line),'utf8');if(bytes>250000)break;lines.unshift(line);}
    return {lines,coverage:[this.coverage()],truncated:lines.length<matched.length};
  }
  clearClient(id:number) {
    for(let i=this.lines.length-1;i>=0;i--)if(this.lines[i]!.clientId===id){this.bytes-=this.sizes[i]!;this.lines.splice(i,1);this.sizes.splice(i,1);}
  }
  stop() {this.lines=[];this.sizes=[];this.bytes=0;}
}
