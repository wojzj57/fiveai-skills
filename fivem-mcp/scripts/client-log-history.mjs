import {open} from 'node:fs/promises';

// Search the whole current file backwards with bounded memory. The load boundary
// can be much older than the binding marker's discovery window.
export async function gameLoadOffset(path, before) {
  const handle=await open(path,'r');
  const needle=Buffer.from('Game finished loading!');
  let end=before,overlap=Buffer.alloc(0);
  try {
    while(end>0){
      const start=Math.max(0,end-256*1024),chunk=Buffer.alloc(end-start);
      const {bytesRead}=await handle.read(chunk,0,chunk.length,start);
      const bytes=Buffer.concat([chunk.subarray(0,bytesRead),overlap]);
      let index=bytes.lastIndexOf(needle);
      while(index>=0){
        const lineStart=bytes.lastIndexOf(10,index)+1,lineEnd=bytes.indexOf(10,index);
        if((lineStart>0||start===0)&&lineEnd>=0){
          const line=bytes.subarray(lineStart,lineEnd).toString('utf8').replace(/\x1b\[[0-9;]*m/g,'').replace(/\^[0-9]/g,'').trim();
          if(/^(?:\[\s*\d+\]\s+\[[^\]]+\]\s+[^/]*\/\s*)?(?:\[\s*gta-core-five\s*\]\s*)?Game finished loading!$/.test(line))return start+lineEnd+1;
        }
        index=index===0?-1:bytes.lastIndexOf(needle,index-1);
      }
      overlap=bytes.subarray(0,1024);end=start;
    }
    return null;
  } finally {await handle.close();}
}
