-- FiveAI local Streamable HTTP MCP resource.
fx_version 'cerulean'
game 'gta5'
node_version '22'

author 'FiveAI'
description 'FiveAI local Streamable HTTP MCP server'
version '0.0.1'

shared_script 'lua/adapters.lua'

server_scripts { 'lua/server.lua', 'dist/server.js' }

client_scripts { 'lua/client.lua', 'dist/client.js' }
