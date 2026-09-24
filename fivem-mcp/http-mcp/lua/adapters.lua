local refusalKey={}
local function reject(code) error({[refusalKey]=true,code=code},0) end
function FiveAiAdapterFailure(value)
    if type(value)=='table' and value[refusalKey] then return value.code end
end
-- Pinned, explicit adapters. No arbitrary method path traversal.
local versions={es_extended='1.15.2',['qb-core']='1.3.0',ox_lib='3.39.0',ox_target='1.18.1',oxmysql='2.14.1'}
local function project(value,keys)
    if value==nil then return nil end
    local out={}
    for _,key in ipairs(keys) do if value[key]~=nil then out[key]=value[key] end end
    return out
end
local function job(value,esx)
    local out=project(value,esx and {'name','label','grade','grade_name','onDuty'} or {'name','label','grade','onduty','isboss'})
    if out and not esx and type(out.grade)=='table' then out.grade=project(out.grade,{'name','level'}) end
    return out
end
local function account(value) return project(value,{'name','label','money'}) end
local function money(value)
    local out={}
    for k,v in pairs(value or {}) do if type(k)=='string' and type(v)=='number' and v==v and v~=math.huge and v~=-math.huge then out[k]=v end end
    return out
end
local function player(value,esx)
    if value==nil then return nil end
    value=value.PlayerData or value
    if esx then
        local out=project(value,{'source','name'});out.job=job(value.job,true)
        if value.accounts then out.accounts={};for k,v in pairs(value.accounts) do out.accounts[k]=account(v) end end
        return out
    end
    local out=project(value,{'source','citizenid','name'});out.money=money(value.money);out.job=job(value.job,false);out.gang=job(value.gang,false);return out
end
local function invoke(object,key,args)
    local fn=object and object[key]
    if type(fn)~='function' then reject('METHOD_UNSUPPORTED') end
    return fn(table.unpack(args))
end
function FiveAiAdapter(request)
    local tool,method,args=request.tool,request.method,request.args or {}
    local resource=tool=='esx' and 'es_extended' or tool=='qbcore' and 'qb-core' or request.library
    if versions[resource]==nil then reject('METHOD_UNSUPPORTED') end
    if GetResourceState(resource)~='started' then reject('DEPENDENCY_MISSING') end
    if GetResourceMetadata(resource,'version',0)~=versions[resource] then reject('DEPENDENCY_VERSION_UNSUPPORTED') end
    if tool=='esx' then
        local core=exports.es_extended:getSharedObject()
        if request.side=='client' then
            if method=='GetPlayerData' then return player(invoke(core,method,args),true) end
            if method=='ShowNotification' then return invoke(core,method,args) end
        elseif request.scope=='framework' and method=='GetPlayerFromId' then return player(invoke(core,method,args),true)
        elseif request.scope=='player' then
            local target=invoke(core,'GetPlayerFromId',{request.playerId});if not target then reject('TARGET_UNAVAILABLE') end
            if method=='getJob' then return job(invoke(target,method,args),true) end
            if method=='getAccount' then return account(invoke(target,method,args)) end
            if method=='getMoney' or method=='addMoney' or method=='removeMoney' or method=='setJob' then return invoke(target,method,args) end
        end
    elseif tool=='qbcore' then
        local core=exports['qb-core']:GetCoreObject()
        if request.side=='client' then
            if method=='Functions.GetPlayerData' then return player(invoke(core.Functions,'GetPlayerData',args),false) end
            if method=='Functions.Notify' then return invoke(core.Functions,'Notify',args) end
        elseif request.scope=='framework' then
            if method=='Functions.GetPlayers' then return invoke(core.Functions,'GetPlayers',args) end
            if method=='Functions.GetPlayer' then return player(invoke(core.Functions,'GetPlayer',args),false) end
        elseif request.scope=='player' then
            local target=invoke(core.Functions,'GetPlayer',{request.playerId});if not target then reject('TARGET_UNAVAILABLE') end
            local allowed={['Functions.GetMoney']='GetMoney',['Functions.AddMoney']='AddMoney',['Functions.RemoveMoney']='RemoveMoney',['Functions.SetJob']='SetJob',['Functions.SetJobDuty']='SetJobDuty'}
            if allowed[method] then return invoke(target.Functions,allowed[method],args) end
        end
    elseif tool=='ox' then
        local allowed=resource=='ox_lib' and {notify=true,showTextUI=true,hideTextUI=true,isTextUIOpen=true} or resource=='ox_target' and {isActive=true,disableTargeting=true,zoneExists=true,removeZone=true} or {}
        if request.side=='client' and allowed[method] then
            local api=exports[resource]
            local fn=api[method];if type(fn)~='function' then reject('METHOD_UNSUPPORTED') end
            return fn(api,table.unpack(args))
        end
    end
    reject('METHOD_UNSUPPORTED')
end
