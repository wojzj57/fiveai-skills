import { TOOL_NAMES, type ToolName } from "../protocol/tool-names.ts";

/**
 * The public MCP surface is deliberately fixed.  A handler may return a
 * structured availability error when its target is absent, but discovery
 * must never hide a supported tool just because FiveM is disconnected.
 * Screenshot support remains an explicitly disabled, unregistered contract.
 */

export const REGISTERED_TOOLS = TOOL_NAMES;

export type RegisteredTool = (typeof REGISTERED_TOOLS)[number];

/** Whether a tool name is registered in the current build. */
export function isToolRegistered(tool: ToolName): tool is RegisteredTool {
  return (REGISTERED_TOOLS as readonly string[]).includes(tool);
}
