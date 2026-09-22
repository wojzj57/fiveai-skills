import { ClientProtocol } from "./protocol.ts";
import { runOnHost } from '../shared/javascript.ts';

interface ClientGlobals {
  source?: number;
  GetCurrentResourceName(): string;
  GetGameTimer(): number;
  onNet(eventName: string, handler: (raw: unknown) => void): void;
  emitNet(eventName: string, raw: string): void;
  emit(eventName: string, raw: string): void;
  on(eventName: string, handler: (...args: unknown[]) => void): void;
  setTick(handler: () => void): void;
}

function uuid(): string {
  const bytes = new Uint8Array(16);
  const cryptoValue = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto;
  if (cryptoValue?.getRandomValues) cryptoValue.getRandomValues(bytes);
  else {
    const seed = Date.now() ^ Math.floor(Math.random() * 0x7fffffff);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256) ^ (seed >>> (index % 4));
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const host = globalThis as unknown as ClientGlobals;
const resourceName = host.GetCurrentResourceName();
const prefix = `${resourceName}:mcp:v1:`;
let stopped=false;
const work: {run:()=>unknown;resolve:(value:unknown)=>void;reject:(reason:Error)=>void;started:number}[]=[];
const scheduler={run:<T>(fn:()=>T):Promise<T>=>new Promise((resolve,reject)=>{
  if(stopped||work.length>=32){reject(new Error('HOST_UNAVAILABLE'));return;}
  work.push({run:fn,resolve:resolve as (value:unknown)=>void,reject,started:host.GetGameTimer()>>>0});
})};
const protocol = new ClientProtocol({
  resourceName,
  clientEpoch: uuid(),
  clock: () => host.GetGameTimer() >>> 0,
  send: (eventName, raw) => host.emitNet(eventName, raw),
  sendLocal: (eventName, raw) => host.emit(eventName, raw),
  executeJs: async (code, args) => [await runOnHost(code,args,scheduler)],
});

for (const type of ["bind", "execute", "terminalAck", "probe"] as const) {
  host.onNet(`${prefix}${type}`, (raw) => {
    const copiedSource = Number(host.source);
    if (typeof raw === "string") protocol.receive(copiedSource, type, raw);
  });
}
host.on(`${prefix}local:clientLuaReady`, (raw) => {
  if (typeof raw === "string") protocol.luaReady(raw);
});
host.on("onClientResourceStop", (name) => {
  if (name === resourceName) {
    stopped=true;protocol.stop();
    for(const item of work.splice(0))item.reject(new Error('HOST_UNAVAILABLE'));
  }
});
host.setTick(() => {
  if(stopped)return;
  for(const item of work.splice(0,16)){
    if(((host.GetGameTimer()-item.started)>>>0)>2000){item.reject(new Error('HOST_UNAVAILABLE'));continue;}
    try{item.resolve(item.run());}catch(error){item.reject(error instanceof Error?error:new Error(String(error)));}
  }
  protocol.tick();
});
protocol.start();
