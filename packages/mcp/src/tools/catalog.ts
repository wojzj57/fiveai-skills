import { TOOL_NAMES, type ToolName } from "../protocol/tool-names.ts";

/**
 * The single public source for MCP discovery metadata.  Input schemas stay
 * in schemas.ts because both the entry and broker independently validate
 * them; callers must not infer availability from this catalog.
 */
export interface ToolCatalogEntry {
  readonly name: ToolName;
  readonly description: string;
}

const descriptions: Record<ToolName, string> = {
  status: "Report the broker, bridge, client, queue, recovery, and capability state.",
  queue: "Inspect, cancel an un-dispatched task, or safely reconcile a retained task.",
  execute_lua: "Run a bounded Lua function body on the selected FiveM server or client through the global FIFO.",
  execute_ts: "Compile and run a bounded TypeScript function body on the selected FiveM server or client through the global FIFO.",
  resource: "Read a resource state, or serially start, stop, or restart one named resource.",
  logs: "Query bounded, filtered server and client diagnostic log records.",
  esx: "Call an allowlisted ESX framework or player method through the global FIFO.",
  qbcore: "Call an allowlisted QBCore framework or player method through the global FIFO.",
  ox: "Call an allowlisted ox_lib, ox_target, or confirmed oxmysql method through the global FIFO.",
  reference: "Search bundled FiveM native, event, and guide reference material.",
};

export const TOOL_CATALOG: Readonly<Record<ToolName, ToolCatalogEntry>> =
  Object.fromEntries(TOOL_NAMES.map((name) => [name, { name, description: descriptions[name] }])) as Record<ToolName, ToolCatalogEntry>;
