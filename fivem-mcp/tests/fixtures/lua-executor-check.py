"""Run the actual resource executor in Lua 5.4; this is not FiveM acceptance.

Requires an existing Python installation with lupa (lua54 backend).
"""
import json
from pathlib import Path
from lupa.lua54 import LuaRuntime, lua_type

lua = LuaRuntime(unpack_returned_tuples=True)
assert lua.eval('_VERSION') == 'Lua 5.4'
handlers, results, waits = {}, [], []

def to_lua(value):
    if isinstance(value, dict):
        return lua.table_from({key: to_lua(item) for key, item in value.items()})
    if isinstance(value, list):
        return lua.table_from([to_lua(item) for item in value])
    return value

def to_python(value):
    if lua_type(value) != 'table':
        return value
    keys = list(value.keys())
    # FiveM scheduler configures rapidjson empty_table_as_array=true.
    if not keys or all(isinstance(k, int) for k in keys) and sorted(keys) == list(range(1, len(keys) + 1)):
        return [to_python(value[k]) for k in range(1, len(keys) + 1)]
    return {k: to_python(value[k]) for k in keys}

g = lua.globals()
g.GetCurrentResourceName = lambda: 'fivem-plugin'
g.AddEventHandler = lambda name, fn: handlers.__setitem__(name, fn)
g.TriggerEvent = lambda name, call_id, text: results.append(json.loads(text))
g.Citizen = lua.table_from({'CreateThread': lambda fn: fn(), 'Wait': lambda ms: waits.append(ms)})
g.json = lua.table_from({'decode': lambda text: to_lua(json.loads(text)), 'encode': lambda value: json.dumps(to_python(value), ensure_ascii=False)})
package_root = Path(__file__).resolve().parents[2]
lua.execute((package_root / 'src/lua/executor.lua').read_text(encoding='utf-8'))
execute = handlers['fivem-plugin:local:executeLua']

def run(code, args=None):
    before = len(results)
    execute('local-call', code, json.dumps(args or {'kind': 'object', 'entries': []}), 'fixture-task')
    assert len(results) == before + 1
    return results[-1]

outcome = run('Citizen.Wait(50); return "ok", nil, 7, nil')
assert waits == [50]
assert outcome['result']['returns'] == [{'kind': 'string', 'value': 'ok'}, {'kind': 'nil'}, {'kind': 'number', 'value': 7}, {'kind': 'nil'}]
assert run('return 9223372036854775807')['result']['returns'][0] == {'kind': 'int64', 'value': '9223372036854775807'}
assert run('return args', {'kind': 'array', 'value': []})['result']['returns'][0] == {'kind': 'array', 'value': []}
assert run('return args', {'kind': 'object', 'entries': []})['result']['returns'][0] == {'kind': 'object', 'entries': []}
assert run('return args', {'kind': 'null'})['result']['returns'][0] == {'kind': 'null'}
for code, expected, completed in [
    ('error("expected")', 'EXECUTION_ERROR', True),
    ('return function() end', 'RESULT_UNSERIALIZABLE', True),
    ('local x={}; x.x=x; return x', 'RESULT_UNSERIALIZABLE', True),
    ('return string.rep("x", 300000)', 'RESULT_TOO_LARGE', True),
    ('return )', 'COMPILATION_ERROR', False),
]:
    outcome = run(code)
    assert outcome['state'] == 'failed', outcome
    assert outcome['error']['code'] == expected, outcome
    assert outcome['evidence'] == {'executionCompleted': completed, 'noRemoteExecution': not completed}
print('PASS: Lua 5.4 executor, 10 cases; FiveM coroutine/native/vector acceptance NOT_EXECUTED')
