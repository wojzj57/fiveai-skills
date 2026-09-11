import type { ToolName } from "../protocol/tool-names.ts";

/**
 * Tool registration contract for the first implementation step.
 *
 * The full tool surface is exactly ten tools (RFC §4); this slice registers
 * only `status` — the one tool that is genuinely servable from broker-level
 * state without the FIFO, executors, or bridge dispatch. The remaining tools
 * are registered as their subsystems land in later steps. The screenshot
 * contract is never registered (RFC §12/§14): an unregistered tool must
 * surface as a protocol-level unknown-tool result, not as a failing tool.
 */

export const REGISTERED_TOOLS = ["status"] as const satisfies readonly ToolName[];

export type RegisteredTool = (typeof REGISTERED_TOOLS)[number];

/** Whether a tool name is registered in the current build. */
export function isToolRegistered(tool: ToolName): tool is RegisteredTool {
  return (REGISTERED_TOOLS as readonly string[]).includes(tool);
}
