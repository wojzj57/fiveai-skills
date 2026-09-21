/**
 * Broker process entry (RFC §4.2). Spawned hidden and detached by the first
 * entry of a config when no broker holds the lifetime pipe; it may also be
 * started directly for tests and diagnostics. Diagnostics go to stderr
 * only — the broker speaks no protocol on stdio.
 */

import { Broker, BrokerStartupError } from "./server.ts";
import { loadRuntimeConfig } from "../cli/config.ts";

const EXIT_USAGE = 2;
const EXIT_PORT_IN_USE = 3;
const EXIT_INSTANCE_CONFLICT = 4;

function parseConfigPath(argv: string[]): string | null {
  const index = argv.indexOf("--config");
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

async function main(): Promise<number> {
  const configPath = parseConfigPath(process.argv.slice(2));
  if (configPath === null) {
    process.stderr.write("usage: node broker.mjs --config <absolute-config-path>\n");
    return EXIT_USAGE;
  }
  let loaded;
  try {
    loaded = loadRuntimeConfig(configPath);
  } catch (error) {
    process.stderr.write(`fiveai-mcp broker: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  const broker = new Broker(loaded);
  try {
    await broker.start();
  } catch (error) {
    if (error instanceof BrokerStartupError) {
      process.stderr.write(`fiveai-mcp broker: ${error.condition}: ${error.message}\n`);
      return error.condition === "PORT_IN_USE" ? EXIT_PORT_IN_USE : EXIT_INSTANCE_CONFLICT;
    }
    process.stderr.write(`fiveai-mcp broker: startup failed: ${(error as Error).message}\n`);
    return 1;
  }

  let signalCount = 0;
  const onSignal = () => {
    signalCount += 1;
    if (signalCount > 1) {
      process.exit(0);
    }
    void broker.shutdown("signal");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  await broker.waitUntilShutdown();
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`fiveai-mcp broker: unexpected failure: ${(error as Error).stack ?? error}\n`);
    process.exit(1);
  });
