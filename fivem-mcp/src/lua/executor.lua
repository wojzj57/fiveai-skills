local resource = GetCurrentResourceName()
local null = {}
local shapes = setmetatable({}, { __mode = 'k' })

local function decode(node)
    if node.kind == 'null' then return null end
    if node.kind == 'array' then
        local value = {}
        shapes[value] = 'array'
        for i, child in ipairs(node.value) do value[i] = decode(child) end
        return value
    end
    if node.kind == 'object' then
        local value = {}
        shapes[value] = 'object'
        for _, entry in ipairs(node.entries) do value[entry.key] = decode(entry.value) end
        return value
    end
    if node.kind == 'string' or node.kind == 'number' or node.kind == 'boolean' then return node.value end
    error('unsupported argument kind')
end

local function encodeReturns(values)
    local ancestors, count = {}, 1
    local function visit(value, path, depth)
        count = count + 1
        if count > 10000 or depth > 32 then error('RESULT_TOO_LARGE at ' .. path) end
        if value == null then return { kind = 'null' } end
        local kind = type(value)
        if kind == 'nil' then return { kind = 'nil' } end
        if kind == 'boolean' then return { kind = kind, value = value } end
        if kind == 'string' then
            if #value > 262144 then error('RESULT_TOO_LARGE at ' .. path) end
            return { kind = kind, value = value }
        end
        if kind == 'number' then
            if value ~= value then return { kind = 'specialNumber', value = 'NaN' } end
            if value == math.huge or value == -math.huge then return { kind = 'specialNumber', value = value > 0 and 'Infinity' or '-Infinity' } end
            if math.type(value) == 'integer' and (value > 9007199254740991 or value < -9007199254740991) then return { kind = 'int64', value = tostring(value) } end
            return { kind = 'number', value = value }
        end
        if kind == 'vector2' or kind == 'vector3' or kind == 'vector4' then
            local dimension = tonumber(kind:sub(-1))
            local components = { value.x, value.y }
            if dimension >= 3 then components[3] = value.z end
            if dimension == 4 then components[4] = value.w end
            return { kind = 'vector', dimension = dimension, components = components }
        end
        if kind ~= 'table' or ancestors[value] then error('RESULT_UNSERIALIZABLE at ' .. path) end
        ancestors[value] = true
        local size, highest, array = 0, 0, true
        for key in next, value do
            size = size + 1
            if size + count > 10000 then error('RESULT_TOO_LARGE at ' .. path) end
            if type(key) ~= 'number' or key % 1 ~= 0 or key < 1 then array = false else highest = math.max(highest, key) end
        end
        array = array and highest == size and (size > 0 or shapes[value] == 'array')
        local result
        if array then
            local list = {}
            for i = 1, size do list[i] = visit(rawget(value, i), path .. '[' .. i .. ']', depth + 1) end
            result = { kind = 'array', value = list }
        else
            local entries, object = {}, true
            for key in next, value do if type(key) ~= 'string' then object = false end end
            for key, item in next, value do
                entries[#entries + 1] = { key = object and key or visit(key, path .. '.key', depth + 1), value = visit(item, path .. '.value', depth + 1) }
            end
            result = { kind = object and 'object' or 'map', entries = entries }
        end
        ancestors[value] = nil
        return result
    end
    local returns = {}
    for i = 1, values.n do returns[i] = visit(values[i], '$[' .. i .. ']', 0) end
    return { language = 'lua', returns = returns }
end

local function failure(code, message, completed)
    return { state = 'failed', error = { code = code, message = tostring(message):sub(1, 4096) }, evidence = { executionCompleted = completed, noRemoteExecution = not completed } }
end

-- Deliberately local only: clients cannot request execution on the server.
AddEventHandler(resource .. ':local:executeLua', function(id, code, argsText, taskId)
    if type(id) ~= 'string' or type(code) ~= 'string' or #code > 65536 or type(argsText) ~= 'string' or #argsText > 262144 then return end
    Citizen.CreateThread(function()
        local environment = setmetatable({ JSON_NULL = null }, { __index = _G })
        local fn, compilation = load('local args = ...\n' .. code, '@fiveai/' .. tostring(taskId) .. '.lua', 't', environment)
        local outcome
        if not fn then outcome = failure('COMPILATION_ERROR', compilation, false)
        else
            local decoded, args = pcall(function() return decode(json.decode(argsText)) end)
            if not decoded then outcome = failure('INVALID_ARGUMENT', args, false)
            else
                local ok, values = xpcall(function() return table.pack(fn(args)) end, debug.traceback)
                if not ok then outcome = failure('EXECUTION_ERROR', values, true)
                else
                    local encoded, result = pcall(encodeReturns, values)
                    if encoded then outcome = { state = 'succeeded', result = result }
                    else outcome = failure(tostring(result):find('RESULT_TOO_LARGE', 1, true) and 'RESULT_TOO_LARGE' or 'RESULT_UNSERIALIZABLE', result, true) end
                end
            end
        end
        local ok, text = pcall(json.encode, outcome)
        if not ok then text = json.encode(failure('RESULT_UNSERIALIZABLE', 'JSON encoding failed', true))
        elseif #text > 262144 then text = json.encode(failure('RESULT_TOO_LARGE', 'encoded result exceeds limit', true)) end
        TriggerEvent(resource .. ':local:luaResult', id, text)
    end)
end)
