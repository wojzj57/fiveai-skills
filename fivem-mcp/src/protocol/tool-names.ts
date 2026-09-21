import { z } from "zod";

/**
 * Public MCP tool names (RFC §4 table, §6.1). Exactly ten tools; the
 * screenshot contract is deliberately NOT a tool (RFC §12/§14).
 */

export const TOOL_NAMES = [
  "status",
  "queue",
  "execute_lua",
  "execute_ts",
  "resource",
  "logs",
  "esx",
  "qbcore",
  "ox",
  "reference",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const ToolNameSchema = z.enum(TOOL_NAMES);

/**
 * Tools served over the entry↔broker control channel (RFC §5.1 message
 * table: status、queue、日志及资料). These are broker-local reads/controls
 * that stay responsive while the execution FIFO is paused.
 *
 * `resource` rides this channel for list/status reads only (RFC §11, review
 * F4): the action-level restriction is enforced by ControlRequestSchema and
 * BridgeReadRequestSchema; start/stop/restart mutations still enter the FIFO
 * through task.submit.
 */
export const CONTROL_TOOLS = [
  "status",
  "queue",
  "logs",
  "reference",
  "resource",
] as const satisfies readonly ToolName[];

export type ControlTool = (typeof CONTROL_TOOLS)[number];

export const ControlToolSchema = z.enum(CONTROL_TOOLS);

/**
 * Tools dispatched through task.submit into the global FIFO (RFC §7.1:
 * executions, framework calls, and resource mutations).
 */
export const FIFO_TOOLS = [
  "execute_lua",
  "execute_ts",
  "resource",
  "esx",
  "qbcore",
  "ox",
] as const satisfies readonly ToolName[];

export type FifoTool = (typeof FIFO_TOOLS)[number];

export const FifoToolSchema = z.enum(FIFO_TOOLS);
