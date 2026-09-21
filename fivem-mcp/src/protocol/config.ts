import { z } from "zod";

/**
 * Local configuration contract (unified-artifact RFC §4). The entry accepts
 * exactly one --config <absolute-path> — the no-argument default-config
 * entry arrives with credential initialization in a later slice — and
 * connection addresses cannot be overridden through tool parameters. The
 * three data paths may be Windows absolute (drive letter or UNC) or
 * relative; relative values always resolve against the config file's own
 * directory, never the process working directory. Schema validation and
 * defaulting happen here; real-path normalization and junction/symlink and
 * ownership checks happen at load time (src/shared/config.ts).
 */

/**
 * Windows data path: a drive-letter or UNC absolute path, or a relative
 * path that resolves against the config directory. Control and
 * wildcard/reserved characters are rejected. Drive-relative ("C:work") and
 * root-relative ("/data", "\data") forms are rejected because they would
 * resolve against a drive root or the working directory instead of the
 * config directory. Verbatim (`\\?\`) and NT device (`\\.\`) paths remain
 * out of scope — the `?` wildcard exclusion drops the former, the
 * server-segment lookahead drops the latter — and runtime real-path
 * normalization handles junction/symlink resolution.
 */
const WindowsDataPathPattern =
  /^(?:[A-Za-z]:[\\/][^<>:"|?*\x00-\x1f]*|\\\\(?!\.[\\/])[^\\/:*?"<>\x00-\x1f]+[\\/][^<>:"|?*\x00-\x1f]+|(?![A-Za-z]:)[^\\/<>:"|?*\x00-\x1f][^<>:"|?*\x00-\x1f]*)(?![\s\S])/;

const WindowsDataPathSchema = z.string().regex(
  WindowsDataPathPattern,
  "expected a Windows absolute path (drive letter or UNC) or a relative path resolved against the config directory",
);

export const BrokerConfigSchema = z.strictObject({
  /** The broker host is fixed to loopback (unified-artifact RFC §4). */
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(43189),
});

export const McpConfigSchema = z.strictObject({
  version: z.literal(1),
  broker: BrokerConfigSchema,
  /**
   * Data paths (unified-artifact RFC §4): relative values resolve against
   * the config file's directory; these defaults keep a shipped installation
   * self-contained inside its mcp/ directory.
   */
  stateDir: WindowsDataPathSchema.default("./state"),
  credentialFile: WindowsDataPathSchema.default("./credentials.json"),
  /** null means no log source is configured; status and probes never depend on it. */
  clientLogDir: WindowsDataPathSchema.nullable().default(null),
  serverLabel: z.string().min(1),
  /** Fixed probes are opt-in and read once at process/resource start. */
  verifyEnabled: z.boolean().default(false),
});

export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
