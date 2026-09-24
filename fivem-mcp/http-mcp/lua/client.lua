local resource = GetCurrentResourceName()
local prefix = resource .. ':mcp:v1:'
local localPrefix = prefix .. 'local:'
local SERVER_SOURCE = 65535
local MAX_FRAME_BYTES = 393216
local MAX_TERMINALS = 32
local MAX_TERMINAL_BYTES = 8 * 1024 * 1024
local MAX_REJECTION_BYTES = 8 * 1024
local ACKED_RETENTION_MS = 5 * 60 * 1000
local RESEND_MS = 2000

local null = {}
local stopped = false
local binding = nil
local highWater = '0'
local active = {}
local unacked = {}
local unackedOrder = {}
local unackedBytes = 0
local acked = {}
local ackedOrder = {}
local ackedBytes = 0
local rejection = nil

local function sameBinding(left, right)
    return type(left) == 'table' and type(right) == 'table'
        and left.resourceEpoch == right.resourceEpoch
        and left.clientId == right.clientId
        and left.connectionId == right.connectionId
        and left.clientEpoch == right.clientEpoch
end

local function sequenceOf(taskId)
    if not binding or type(taskId) ~= 'string' then return nil end
    local prefixValue = binding.resourceEpoch .. ':'
    if taskId:sub(1, #prefixValue) ~= prefixValue then return nil end
    local sequence = taskId:sub(#prefixValue + 1)
    if not sequence:match('^[1-9][0-9]*$') then return nil end
    return sequence
end

local function greaterSequence(left, right)
    if #left ~= #right then return #left > #right end
    return left > right
end

local function decode(raw, expectedType, requireBinding)
    if stopped or type(raw) ~= 'string' or #raw > MAX_FRAME_BYTES then return nil end
    local ok, message = pcall(json.decode, raw, 1, null)
    if not ok or type(message) ~= 'table' or message.v ~= 1 or message.type ~= expectedType then return nil end
    if requireBinding and not sameBinding(binding, message.binding) then return nil end
    return message
end

local function errorCode(message)
    local text = tostring(message)
    for _, code in ipairs({'DEPENDENCY_MISSING', 'DEPENDENCY_VERSION_UNSUPPORTED', 'METHOD_UNSUPPORTED'}) do
        if text:find(code, 1, true) then return code end
    end
    if text:find('RESULT_TOO_LARGE', 1, true) then return 'RESULT_TOO_LARGE' end
    if text:find('RESULT_UNSUPPORTED', 1, true) then return 'RESULT_UNSUPPORTED' end
    return 'EXECUTION_FAILED'
end

local function errorPayload(message, execution, code)
    local phase = execution == 'ended' and 'dispatched' or 'preparing'
    return json.encode({
        execution = execution,
        error = {
            code = code or errorCode(message),
            message = tostring(message):sub(1, 4096),
            phase = phase,
            retryable = false,
            execution = execution,
        },
    })
end

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
            if kind ~= 'vector2' then parts[#parts + 1] = encode(value.z, depth + 1) end
            if kind == 'vector4' then parts[#parts + 1] = encode(value.w, depth + 1) end
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
            for index = 1, size do parts[index] = encode(rawget(value, index), depth + 1) end
            result = '[' .. table.concat(parts, ',') .. ']'
        elseif object and rawget(value, '$mcp') == nil then
            for key, item in next, value do
                parts[#parts + 1] = count(json.encode(key)) .. ':' .. encode(item, depth + 1)
            end
            result = '{' .. table.concat(parts, ',') .. '}'
        else
            for key, item in next, value do
                local keyType = type(key)
                if keyType ~= 'string' and keyType ~= 'boolean' and keyType ~= 'number' then error('RESULT_UNSUPPORTED') end
                if keyType == 'number' and (key ~= key or key == math.huge or key == -math.huge) then error('RESULT_UNSUPPORTED') end
                parts[#parts + 1] = '[' .. encode(key, depth + 1) .. ',' .. encode(item, depth + 1) .. ']'
            end
            result = '{"$mcp":' .. json.encode(object and 'object' or 'table') .. ',"entries":[' .. table.concat(parts, ',') .. ']}'
        end
        seen[value] = nil
        return result
    end
    local result = {}
    for index = 1, values.n do result[index] = encode(values[index], 0) end
    local text = '{"kind":"values","values":[' .. table.concat(result, ',') .. ']}'
    if #text > 262144 then error('RESULT_TOO_LARGE') end
    return text
end

local function makeTerminal(taskId, planHash, payload)
    local raw = '{"v":1,"type":"terminal","binding":' .. json.encode(binding)
        .. ',"taskId":' .. json.encode(taskId) .. ',"payload":' .. payload .. '}'
    return {taskId = taskId, planHash = planHash, payload = payload, raw = raw, bytes = #raw, lastSentAt = -math.huge}
end

local function sendTerminal(record)
    TriggerServerEvent(prefix .. 'terminal', record.raw)
    record.lastSentAt = GetGameTimer()
end

local function removeFromOrder(order, taskId)
    for index, value in ipairs(order) do
        if value == taskId then table.remove(order, index); return end
    end
end

local function trimAcked()
    local now = GetGameTimer()
    while #ackedOrder > 0 do
        local taskId = ackedOrder[1]
        local record = acked[taskId]
        if record and #ackedOrder <= MAX_TERMINALS and ackedBytes <= MAX_TERMINAL_BYTES
            and now - record.ackedAt <= ACKED_RETENTION_MS then break end
        table.remove(ackedOrder, 1)
        if record then ackedBytes = ackedBytes - record.bytes; acked[taskId] = nil end
    end
end

local function refuse(taskId, planHash, sequence, code, message)
    if greaterSequence(sequence, highWater) then highWater = sequence end
    if rejection then sendTerminal(rejection); return end
    local record = makeTerminal(taskId, planHash, errorPayload(message, 'not_dispatched', code))
    if record.bytes > MAX_REJECTION_BYTES then return end
    rejection = record
    sendTerminal(record)
end

AddEventHandler(localPrefix .. 'clientBind', function(raw)
    local message = decode(raw, 'bind', false)
    if not message or type(message.binding) ~= 'table'
        or type(message.payload) ~= 'table' or type(message.payload.logMarker) ~= 'string'
        or not message.payload.logMarker:match('^[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]$') then return end
    local newBinding = not sameBinding(binding, message.binding)
    if binding and newBinding then
        highWater, active, unacked, unackedOrder, unackedBytes = '0', {}, {}, {}, 0
        acked, ackedOrder, ackedBytes, rejection = {}, {}, 0, nil
    end
    binding = message.binding
    if newBinding then
        print('FIVEM_MCP_BIND:' .. tostring(binding.resourceEpoch) .. ':' .. tostring(binding.connectionId) .. ':' .. tostring(binding.clientEpoch) .. ':' .. message.payload.logMarker)
    end
    TriggerEvent(localPrefix .. 'clientLuaReady', json.encode({binding = binding}))
end)

RegisterNetEvent(prefix .. 'execute', function(raw)
    local eventSource = source
    if eventSource ~= SERVER_SOURCE then return end
    local message = decode(raw, 'execute', true)
    if not message or type(message.taskId) ~= 'string' or type(message.payload) ~= 'table'
        or message.payload.kind ~= 'lua' or type(message.payload.code) ~= 'string'
        or type(message.payload.planHash) ~= 'string' or not message.payload.planHash:match('^[a-f0-9]+$')
        or #message.payload.planHash ~= 64 then return end
    local taskId, planHash = message.taskId, message.payload.planHash
    local sequence = sequenceOf(taskId)
    if not sequence then return end
    local record = unacked[taskId] or acked[taskId] or (rejection and rejection.taskId == taskId and rejection or nil)
    if record then
        if record.planHash == planHash then sendTerminal(record)
        else refuse(taskId, planHash, sequence, 'EXECUTION_FAILED', 'Conflicting plan hash') end
        return
    end
    if active[taskId] then
        if active[taskId] ~= planHash then refuse(taskId, planHash, sequence, 'EXECUTION_FAILED', 'Conflicting plan hash') end
        return
    end
    if rejection then sendTerminal(rejection); return end
    if not greaterSequence(sequence, highWater) then
        refuse(taskId, planHash, sequence, 'EXECUTION_FAILED', 'Execute sequence is not newer than the accepted high-water mark')
        return
    end
    local activeCount=0;for _ in pairs(active) do activeCount=activeCount+1 end
    if #unackedOrder+activeCount >= MAX_TERMINALS or unackedBytes+(activeCount+1)*393216 > MAX_TERMINAL_BYTES then
        refuse(taskId, planHash, sequence, 'EXECUTOR_FULL', 'Terminal cache is full')
        return
    end
    highWater = sequence
    active[taskId] = planHash
    Citizen.CreateThread(function()
        local env = setmetatable({JSON_NULL = null}, {__index = _G})
        local fn, syntax = load('local args = ...\n' .. message.payload.code, '@mcp-client-snippet.lua', 't', env)
        local payload
        if not fn then
            payload = errorPayload(syntax, 'not_dispatched', 'COMPILE_FAILED')
        else
            local success, values = xpcall(function() return table.pack(fn(message.payload.args)) end, function(value) return value end)
            if not success then
                local refusal=type(FiveAiAdapterFailure)=='function' and FiveAiAdapterFailure(values)
                payload=errorPayload(refusal or values,refusal and 'not_dispatched' or 'ended',refusal or errorCode(values))
            else
                local encoded, result = pcall(encodeValues, values)
                if encoded then payload = '{"execution":"ended","result":' .. result .. '}'
                else payload = errorPayload(result, 'ended', errorCode(result)) end
            end
        end
        active[taskId] = nil
        if stopped or not binding or not sameBinding(binding, message.binding) then return end
        local terminal = makeTerminal(taskId, planHash, payload)
        if #unackedOrder >= MAX_TERMINALS or unackedBytes + terminal.bytes > MAX_TERMINAL_BYTES then
            rejection=makeTerminal(taskId,planHash,errorPayload('Terminal cache reservation exceeded','ended','EXECUTOR_FULL'))
            sendTerminal(rejection)
            return
        end
        unacked[taskId] = terminal
        unackedOrder[#unackedOrder + 1] = taskId
        unackedBytes = unackedBytes + terminal.bytes
        sendTerminal(terminal)
    end)
end)

RegisterNetEvent(prefix .. 'terminalAck', function(raw)
    local eventSource = source
    if eventSource ~= SERVER_SOURCE then return end
    local message = decode(raw, 'terminalAck', true)
    if not message or type(message.taskId) ~= 'string' or type(message.payload) ~= 'table' or next(message.payload) ~= nil then return end
    if rejection and rejection.taskId == message.taskId then rejection = nil; return end
    local record = unacked[message.taskId]
    if not record then return end
    unacked[message.taskId] = nil
    removeFromOrder(unackedOrder, message.taskId)
    unackedBytes = unackedBytes - record.bytes
    record.ackedAt = GetGameTimer()
    acked[message.taskId] = record
    ackedOrder[#ackedOrder + 1] = message.taskId
    ackedBytes = ackedBytes + record.bytes
    trimAcked()
end)

RegisterNetEvent(prefix .. 'probe', function(raw)
    local eventSource = source
    if eventSource ~= SERVER_SOURCE then return end
    local message = decode(raw, 'probe', true)
    if not message or type(message.taskId) ~= 'string' or type(message.payload) ~= 'table' or next(message.payload) ~= nil then return end
    local record = unacked[message.taskId] or acked[message.taskId]
        or (rejection and rejection.taskId == message.taskId and rejection or nil)
    local payload = record and ('{"known":true,"terminal":' .. record.payload .. '}') or '{"known":false}'
    local result = '{"v":1,"type":"probeResult","binding":' .. json.encode(binding)
        .. ',"taskId":' .. json.encode(message.taskId) .. ',"payload":' .. payload .. '}'
    TriggerServerEvent(prefix .. 'probeResult', result)
end)

local function maintain()
    if stopped then return end
    local now = GetGameTimer()
    for _, taskId in ipairs(unackedOrder) do
        local record = unacked[taskId]
        if record and now - record.lastSentAt >= RESEND_MS then sendTerminal(record) end
    end
    if rejection and now - rejection.lastSentAt >= RESEND_MS then sendTerminal(rejection) end
    trimAcked()
    SetTimeout(250, maintain)
end
SetTimeout(250, maintain)

AddEventHandler('onClientResourceStop', function(name)
    if name ~= resource then return end
    stopped, binding = true, nil
    active, unacked, unackedOrder, acked, ackedOrder, rejection = {}, {}, {}, {}, {}, nil
end)
