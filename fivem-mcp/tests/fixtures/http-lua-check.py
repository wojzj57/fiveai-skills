"""Execute the shipped HTTP Lua server in Lua 5.4; not FiveM host acceptance."""
import json
from pathlib import Path
from lupa.lua54 import LuaRuntime, lua_type
lua=LuaRuntime(unpack_returned_tuples=True)
handlers={};results=[];sequence=0

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
g.GetCurrentResourceName=lambda:'test'
g.AddEventHandler=lambda name,fn:handlers.__setitem__(name,fn)
g.TriggerEvent=lambda name,text:results.append(json.loads(text))
g.Citizen=lua.table_from({'CreateThread':lambda fn:fn(),'Await':lambda value:value})
g.json=lua.table_from({'decode':lambda text,pos=1,null=None:to_lua(json.loads(text),null),'encode':lambda value:json.dumps(to_python(value),ensure_ascii=False)})
lua.execute((Path(__file__).resolve().parents[2]/'http-mcp/lua/server.lua').read_text(encoding='utf-8'))
def run(code,args=None):
    global sequence
    sequence+=1
    frame={'v':1,'type':'execute','binding':{'side':'server','resourceEpoch':'test'},'taskId':'test:'+str(sequence),'payload':{'kind':'lua','code':code,'args':args or {},'timeoutMs':10000,'planHash':str(sequence)}}
    handlers['test:mcp:v1:local:execute'](json.dumps(frame))
    assert len(results)==sequence
    return results[-1]['payload']
assert run('return 42,nil')['result']['values']==[42,{'$mcp':'nil'}]
assert run('return Citizen.Await(42)')['result']['values']==[42]
assert run('return args.x',{'x':None})['result']['values']==[None]
assert run('return { ["$mcp"]="nil" }')['result']['values']==[{'$mcp':'object','entries':[['$mcp','nil']]}]
assert run('return 9223372036854775807')['result']['values']==[{'$mcp':'integer','value':'9223372036854775807'}]
assert run('x=5;return x')['result']['values']==[5]
assert run('return x')['result']['values']==[{'$mcp':'nil'}]
for code,expected,execution in [('return )','COMPILE_FAILED','not_dispatched'),('error("failure")','EXECUTION_FAILED','ended'),('return function() end','RESULT_UNSUPPORTED','ended'),('local x={};x.x=x;return x','RESULT_UNSUPPORTED','ended'),('return setmetatable({},{})','RESULT_UNSUPPORTED','ended'),('return string.rep("x",300000)','RESULT_TOO_LARGE','ended')]:
    result=run(code);assert result['error']['code']==expected,result;assert result['execution']==execution
print('PASS: shipped HTTP Lua server, 13 cases; FiveM native/coroutine acceptance NOT_EXECUTED')

lua.execute((Path(__file__).resolve().parents[2]/'http-mcp/lua/adapters.lua').read_text(encoding='utf-8'))
lua.execute('''
local versions={es_extended='1.15.2',['qb-core']='1.3.0',ox_lib='3.39.0',ox_target='1.18.1'}
function GetResourceState(name) return versions[name] and 'started' or 'missing' end
function GetResourceMetadata(name) return versions[name] end
local esxPlayer={source=7,name='fixture',license='private',inventory={'private'},job={name='test',label='Test',grade=0,secret='private'},accounts={{name='cash',label='Cash',money=4,secret='private'}}}
esxPlayer.getMoney=function()return 4 end
esxPlayer.getJob=function()return esxPlayer.job end
esxPlayer.getAccount=function()return esxPlayer.accounts[1] end
esxPlayer.addMoney=function(amount)return amount==1 end
esxPlayer.removeMoney=function()return false end
esxPlayer.setJob=function()return nil end
local esx={GetPlayerFromId=function(id)assert(id==7);return esxPlayer end,GetPlayerData=function()return esxPlayer end,ShowNotification=function()return false end}
local qbPlayer={PlayerData={source=7,name='fixture',citizenid='test',license='private',money={cash=5,bad=math.huge},job={grade={name='zero',level=0,secret=true}}}}
qbPlayer.Functions={GetMoney=function()return 5 end,AddMoney=function()return false end,RemoveMoney=function()return true end,SetJob=function()return true end,SetJobDuty=function()return nil end}
local qb={Functions={GetPlayer=function(id)assert(id==7);return qbPlayer end,GetPlayers=function()return {7} end,GetPlayerData=function()return qbPlayer.PlayerData end,Notify=function()return false end}}
exports={es_extended={getSharedObject=function()return esx end},['qb-core']={GetCoreObject=function()return qb end},ox_lib={isTextUIOpen=function(self)assert(self==exports.ox_lib);return false,'text' end},ox_target={isActive=function()return false end}}
local function call(tool,side,scope,method,args,library)return FiveAiAdapter({tool=tool,side=side,scope=scope,method=method,args=args or {},library=library,playerId=7})end
local p=call('esx','server','framework','GetPlayerFromId',{7});assert(p.license==nil and p.inventory==nil and p.job.secret==nil and p.accounts[1].secret==nil)
assert(call('esx','server','player','getMoney')==4)
assert(call('esx','server','player','getJob').name=='test')
assert(call('esx','server','player','getAccount',{'cash'}).money==4)
assert(call('esx','server','player','addMoney',{1})==true)
assert(call('esx','server','player','removeMoney',{1})==false)
assert(call('esx','server','player','setJob',{'test',0})==nil)
assert(call('esx','client','framework','GetPlayerData').source==7)
assert(call('esx','client','framework','ShowNotification',{'test'})==false)
p=call('qbcore','server','framework','Functions.GetPlayer',{7});assert(p.license==nil and p.money.bad==nil and p.job.grade.secret==nil)
assert(call('qbcore','server','framework','Functions.GetPlayers')[1]==7)
assert(call('qbcore','server','player','Functions.GetMoney',{'cash'})==5)
assert(call('qbcore','server','player','Functions.AddMoney',{'cash',1})==false)
assert(call('qbcore','server','player','Functions.RemoveMoney',{'cash',1})==true)
assert(call('qbcore','server','player','Functions.SetJob',{'test',0})==true)
assert(call('qbcore','server','player','Functions.SetJobDuty',{true})==nil)
assert(call('qbcore','client','framework','Functions.GetPlayerData').source==7)
assert(call('qbcore','client','framework','Functions.Notify',{'test'})==false)
local state,text=call('ox','client',nil,'isTextUIOpen',{},'ox_lib');assert(state==false and text=='text')
assert(call('ox','client',nil,'isActive',{},'ox_target')==false)
local ok,reason=pcall(call,'ox','client',nil,'notify',{},'ox_lib');assert(not ok and FiveAiAdapterFailure(reason)=='METHOD_UNSUPPORTED')
''')
print('PASS: pinned adapter dispatch/projection and false/multiple values in Lua stubs; actual frameworks NOT_EXECUTED')

rejected=run('return FiveAiAdapter(args)',{'tool':'ox','side':'client','library':'ox_lib','method':'notify','args':[]})
assert rejected['execution']=='not_dispatched' and rejected['error']['code']=='METHOD_UNSUPPORTED',rejected
