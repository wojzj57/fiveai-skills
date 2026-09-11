import { z } from "zod";

/**
 * Local configuration contract (RFC §4.1). The entry accepts exactly one
 * --config <absolute-path>; connection addresses cannot be overridden
 * through tool parameters. Paths are Windows absolute paths (drive letter
 * or UNC); normalization, junction/symlink, and real-path checks happen at
 * runtime startup, not in this schema.
 */

/**
 * Windows absolute path: drive-letter or UNC form. Control characters are
 * rejected. Verbatim (`\\?\`) and NT device (`\\.\`) paths are intentionally
 * out of scope for the first version — the `?` wildcard exclusion drops the
 * former, the server-segment lookahead drops the latter — and runtime
 * real-path normalization handles junction/symlink resolution (RFC §4.1).
 */
const WindowsAbsolutePathSchema = z
  .string()
  .min(3)
  .regex(
    /^(?:[A-Za-z]:[\\/][^<>:"|?*\x00-\x1f]*|\\\\(?!\.[\\/])[^\\/:*?"<>\x00-\x1f]+[\\/][^<>:"|?*\x00-\x1f]+)(?![\s\S])/,
    "expected a Windows absolute path (drive letter or UNC)",
  );

export const BrokerConfigSchema = z.strictObject({
  /** RFC §4.1: host is fixed to loopback in the first version. */
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(43189),
});

export const McpConfigSchema = z.strictObject({
  version: z.literal(1),
  broker: BrokerConfigSchema,
  stateDir: WindowsAbsolutePathSchema,
  credentialFile: WindowsAbsolutePathSchema,
  clientLogDir: WindowsAbsolutePathSchema,
  serverLabel: z.string().min(1),
});

export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
