-- Only local events are registered. Network peers cannot request server Lua.
local resource = GetCurrentResourceName()
local prefix = resource .. ':mcp:v1:local:'
local null = {}
local stopped = false
local terminals = {}
local active = {}

local function encodeValues(values)
    local seen, nodes, bytes = {}, 0, 0
    local function count(text)
        bytes = bytes + #text
        if bytes > 262144 then error('RESULT_TOO_LARGE') end
        return text
    end
    local function encode(value, depth)
        nodes = nodes + 1
        if nodes > 10000 or depth > 32 then error('RESULT_TOO_LARGE') end
        if value == null then return 'null' end
        local kind = type(value)
        if kind == 'nil' then return '{"$mcp":"nil"}' end
        if kind == 'boolean' then return tostring(value) end
        if kind == 'string' then return count(json.encode(value)) end
        if kind == 'number' then
            if value ~= value then return '{"$mcp":"number","value":"NaN"}' end
            if value == math.huge then return '{"$mcp":"number","value":"Infinity"}' end
            if value == -math.huge then return '{"$mcp":"number","value":"-Infinity"}' end
            if math.type(value) == 'integer' and (value > 9007199254740991 or value < -9007199254740991) then
                return '{"$mcp":"integer","value":' .. json.encode(tostring(value)) .. '}'
            end
            return tostring(value)
        end
        if kind == 'vector2' or kind == 'vector3' or kind == 'vector4' then
            local parts = {encode(value.x, depth + 1), encode(value.y, depth + 1)}
            if kind ~= 'vector2' then parts[#parts+1] = encode(value.z, depth+1) end
            if kind == 'vector4' then parts[#parts+1] = encode(value.w, depth+1) end
            return '{"$mcp":"vector","values":[' .. table.concat(parts, ',') .. ']}'
        end
        if kind ~= 'table' or getmetatable(value) ~= nil or seen[value] then error('RESULT_UNSUPPORTED') end
        seen[value] = true
        local size, max, array, object = 0, 0, true, true
        for key in next, value do
            size = size + 1
            if size > 1024 then error('RESULT_TOO_LARGE') end
            if type(key) ~= 'number' or key < 1 or key % 1 ~= 0 then array = false else max = math.max(max, key) end
            if type(key) ~= 'string' then object = false end
        end
        local parts, result = {}, nil
        if size > 0 and array and max == size then
            for i=1,size do parts[i] = encode(rawget(value,i), depth+1) end
            result = '[' .. table.concat(parts, ',') .. ']'
        elseif object and rawget(value,'$mcp') == nil then
            for key,item in next,value do parts[#parts+1] = count(json.encode(key)) .. ':' .. encode(item,depth+1) end
            result = '{' .. table.concat(parts, ',') .. '}'
        else
            for key,item in next,value do
                local kt = type(key)
                if kt ~= 'string' and kt ~= 'boolean' and kt ~= 'number' then error('RESULT_UNSUPPORTED') end
                if kt == 'number' and (key ~= key or key == math.huge or key == -math.huge) then error('RESULT_UNSUPPORTED') end
                parts[#parts+1] = '[' .. encode(key,depth+1) .. ',' .. encode(item,depth+1) .. ']'
            end
            result = '{"$mcp":' .. json.encode(object and 'object' or 'table') .. ',"entries":[' .. table.concat(parts, ',') .. ']}'
        end
        seen[value] = nil
        return result
    end
    local result = {}
    for i=1,values.n do result[i] = encode(values[i],0) end
    local text = '{"kind":"values","values":[' .. table.concat(result, ',') .. ']}'
    if #text > 262144 then error('RESULT_TOO_LARGE') end
    return text
end

local function failed(message, execution, code)
    message=tostring(message):gsub('mcp%-snippet.lua:(%d+)',function(line)return 'snippet.lua:'..math.max(1,tonumber(line)-1) end)
    return json.encode({execution=execution,error={code=code,message=tostring(message):sub(1,4096),phase=execution=='ended' and 'dispatched' or 'preparing',retryable=false,execution=execution}})
end
AddEventHandler(prefix .. 'execute', function(raw)
    if stopped or type(raw) ~= 'string' or #raw > 393216 then return end
    local ok, message = pcall(json.decode,raw,1,null)
    if not ok or type(message) ~= 'table' or message.v ~= 1 or message.type ~= 'execute' then return end
    local id, plan = message.taskId, message.payload
    if type(id) ~= 'string' or type(plan) ~= 'table' or type(plan.code) ~= 'string' then return end
    if terminals[id] then TriggerEvent(prefix .. 'terminal', terminals[id]);return end
    if active[id] then return end
    active[id] = true
    Citizen.CreateThread(function()
        local env = setmetatable({JSON_NULL=null},{__index=_G})
        local fn, syntax = load('local args = ...\n' .. plan.code,'@mcp-snippet.lua','t',env)
        local payload
        if not fn then payload = failed(syntax,'not_dispatched','COMPILE_FAILED')
        else
            local success, values = xpcall(function() return table.pack(fn(plan.args)) end,function(e) return e end)
            if not success then
                local refusal=type(FiveAiAdapterFailure)=='function' and FiveAiAdapterFailure(values)
                payload=failed(refusal or values,refusal and 'not_dispatched' or 'ended',refusal or 'EXECUTION_FAILED')
            else
                local encoded, result = pcall(encodeValues,values)
                if encoded then payload = '{"execution":"ended","result":' .. result .. '}'
                else payload = failed(result,'ended',tostring(result):find('RESULT_TOO_LARGE',1,true) and 'RESULT_TOO_LARGE' or 'RESULT_UNSUPPORTED') end
            end
        end
        local terminal = '{"v":1,"type":"terminal","binding":' .. json.encode(message.binding) .. ',"taskId":' .. json.encode(id) .. ',"payload":' .. payload .. '}'
        active[id] = nil
        if not stopped then terminals[id] = terminal;TriggerEvent(prefix .. 'terminal', terminal) end
    end)
end)
AddEventHandler(prefix .. 'terminalAck',function(id) terminals[id]=nil end)
AddEventHandler(prefix .. 'probe',function(id) if terminals[id] then TriggerEvent(prefix .. 'terminal',terminals[id]) end end)
AddEventHandler('onResourceStop',function(name) if name==resource then stopped=true;terminals={};active={} end end)
