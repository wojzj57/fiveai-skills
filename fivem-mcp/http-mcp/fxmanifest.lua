-- FiveAI local Streamable HTTP MCP resource.
-- Server-only by design: this resource does not touch the game client.
fx_version 'cerulean'
game 'gta5'
node_version '22'

author 'FiveAI'
description 'FiveAI local Streamable HTTP MCP server'
version '0.0.1'

server_scripts { 'dist/server.js' }
