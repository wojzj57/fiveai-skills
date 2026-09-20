-- FiveAI P0 host-feasibility experiment (migration design section 5, stage P0).
-- This resource is a throwaway probe, not a delivery artifact: it is absent
-- from the whitelist in scripts/build-unified.mjs and must never be shipped.
-- Server-only on purpose - P0 does not touch the game client.
fx_version 'cerulean'
game 'gta5'
node_version '22'

author 'FiveAI'
description 'FiveAI P0 host-feasibility probe: in-resource MCP Streamable HTTP'
version '0.0.1'

server_scripts { 'dist/server.js' }
