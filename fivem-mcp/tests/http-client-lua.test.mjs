import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("Lua client authenticates server source and probe never replays execution", () => {
  const work = mkdtempSync(join(tmpdir(), "fiveai-client-lua-"));
  const script = join(work, "check.py");
  const luaPath = resolve("http-mcp/lua/client.lua");
  writeFileSync(script, String.raw`
import json, sys
from pathlib import Path
from lupa.lua54 import LuaRuntime, lua_type

lua=LuaRuntime(unpack_returned_tuples=True)
network={}; local_handlers={}; sent=[]; intervals=[]; executions=[]; printed=[]
def to_lua(value,null=None):
    if value is None:return null
    if isinstance(value,dict):return lua.table_from({k:to_lua(v,null) for k,v in value.items()})
    if isinstance(value,list):return lua.table_from([to_lua(v,null) for v in value])
    return value
def to_python(value):
    if lua_type(value)!='table':return value
    keys=list(value.keys())
    if keys and all(isinstance(k,int) for k in keys):return [to_python(value[i]) for i in range(1,len(keys)+1)]
    return {k:to_python(value[k]) for k in keys}
g=lua.globals()
g.source=0
g.GetCurrentResourceName=lambda:'renamed-resource'
g.GetGameTimer=lambda:0
g.RegisterNetEvent=lambda name,fn:network.__setitem__(name,fn)
g.AddEventHandler=lambda name,fn:local_handlers.__setitem__(name,fn)
g.TriggerServerEvent=lambda name,raw:sent.append((name,json.loads(raw)))
g.TriggerEvent=lambda name,*args: None
g.print=lambda line:printed.append(line)
g.SetTimeout=lambda ms,fn:intervals.append(fn)
g.Citizen=lua.table_from({'CreateThread':lambda fn:fn(),'Await':lambda value:value})
g.json=lua.table_from({'decode':lambda text,pos=1,null=None:to_lua(json.loads(text),null),'encode':lambda value:json.dumps(to_python(value),ensure_ascii=False,separators=(',',':'))})
lua.execute(Path(sys.argv[1]).read_text(encoding='utf-8'))
assert len(intervals)==1
intervals.pop(0)()
assert len(intervals)==1

epoch='00000000-0000-4000-8000-000000000001'
binding={'resourceEpoch':epoch,'clientId':7,'connectionId':'00000000-0000-4000-8000-000000000003','clientEpoch':'00000000-0000-4000-8000-000000000002'}
bind={'v':1,'type':'bind','binding':binding,'payload':{'logMarker':'b'*32}}
local_handlers['renamed-resource:mcp:v1:local:clientBind'](json.dumps(bind))
assert printed==['FIVEM_MCP_BIND:'+epoch+':'+binding['connectionId']+':'+binding['clientEpoch']+':'+'b'*32],printed
local_handlers['renamed-resource:mcp:v1:local:clientBind'](json.dumps(bind))
assert len(printed)==1,printed
frame={'v':1,'type':'execute','binding':binding,'taskId':epoch+':1','payload':{'kind':'lua','code':'executions=(executions or 0)+1; return 42,nil','args':{},'timeoutMs':1000,'planHash':'a'*64}}

g.source=1
network['renamed-resource:mcp:v1:execute'](json.dumps(frame))
assert sent==[],sent
g.source=65535
network['renamed-resource:mcp:v1:execute'](json.dumps(frame))
assert sent[-1][1]['payload']['result']['values']==[42,{'$mcp':'nil'}],sent
network['renamed-resource:mcp:v1:execute'](json.dumps(frame))
assert len([x for x in sent if x[1]['type']=='terminal'])==2

probe={'v':1,'type':'probe','binding':binding,'taskId':epoch+':1','payload':{}}
network['renamed-resource:mcp:v1:probe'](json.dumps(probe))
assert sent[-1][1]['type']=='probeResult'
assert sent[-1][1]['payload']['known'] is True
assert sent[-1][1]['payload']['terminal']['result']['values']==[42,{'$mcp':'nil'}]

bad=dict(frame);bad['taskId']=epoch+':2';bad['payload']=dict(frame['payload']);bad['payload']['code']='error("DEPENDENCY_MISSING: ox_lib")'
network['renamed-resource:mcp:v1:execute'](json.dumps(bad))
assert sent[-1][1]['payload']['error']['code']=='DEPENDENCY_MISSING',sent[-1]
g.RecordExecution=lambda:executions.append(1)
rejected=False
for sequence in range(3,36):
    frame['taskId']=epoch+':'+str(sequence)
    frame['payload']['code']='RecordExecution();return string.rep("x",262000)'
    before=len(executions)
    network['renamed-resource:mcp:v1:execute'](json.dumps(frame))
    payload=sent[-1][1]['payload']
    if payload.get('error',{}).get('code')=='EXECUTOR_FULL':
        assert payload['execution']=='not_dispatched',payload
        assert len(executions)==before
        rejected=True
        break
assert rejected
local_handlers['onClientResourceStop']('renamed-resource')
intervals.pop(0)()
assert len(intervals)==0
print('PASS: Lua client source=65535 contract, dedupe, probe and adapter error mapping; actual FiveM host NOT_EXECUTED')
`, "utf8");
  try {
    const result = spawnSync("py", ["-3.11", script, luaPath], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /actual FiveM host NOT_EXECUTED/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
