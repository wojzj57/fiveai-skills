/**
 * Simulated FiveM server runtime for the P0 host-feasibility experiment.
 *
 * This is an OFFLINE harness. RFC §2 and §10 are explicit that a resource
 * passing ordinary Node tests is not evidence that FXServer accepts it, so
 * nothing here is host acceptance — the real run stays NOT_EXECUTED until
 * someone starts FxDK/FXServer and records the console lines.
 *
 * What the shim does buy is a reproducible check of the parts that do not
 * need a host:
 *
 *   - natives are installed on `globalThis` and every *execution* native
 *     throws when it is called off the host tick, so a regression in the
 *     resource's host-tick discipline fails the suite instead of silently
 *     working under Node;
 *   - `setTick` handlers are driven by a real timer loop, so the resource
 *     observes the same one-callback-per-frame shape it will see in FXServer;
 *   - `FIVEAI_P0 …` console lines are captured and parsed into evidence, so a
 *     test asserts on the same structured output a host operator would read.
 *
 * Only one host may be active per process: the FiveM globals are process-wide.
 */

import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

let activeHost = null;

function parseEvidence(lines) {
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^FIVEAI_P0 (\S+) (\{.*\})$/.exec(lines[index]);
    if (match === null) continue;
    entries.push({ index, tag: match[1], payload: JSON.parse(match[2]) });
  }
  return entries;
}

/**
 * Start a simulated host and load the built experiment bundle into it.
 *
 * @param {object} options
 * @param {string} options.bundlePath absolute path to the built resource bundle
 * @param {string} [options.resourceName] value `GetCurrentResourceName` returns
 * @param {Record<string, string>} [options.env] extra process env for the bundle
 */
export function createFiveMHost({ bundlePath, resourceName = "p0-http", env = {} } = {}) {
  if (activeHost !== null) {
    throw new Error("only one simulated FiveM host may be active per process");
  }

  const workDir = mkdtempSync(join(tmpdir(), "fiveai-p0-host-"));
  const modulePath = join(workDir, "server.cjs");
  copyFileSync(bundlePath, modulePath);

  const lines = [];
  const violations = [];
  let tickHandlers = [];
  let stopHandlers = [];
  let commands = new Map();
  let inTick = false;
  let tickTimer = null;

  const savedConsole = { log: console.log, error: console.error, warn: console.warn };
  const savedEnv = new Map(Object.entries(env).map(([key]) => [key, process.env[key]]));
  const savedGlobals = new Map();

  function record(text) {
    lines.push(text);
  }

  function installGlobal(name, value) {
    if (!savedGlobals.has(name)) {
      savedGlobals.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined);
    }
    globalThis[name] = value;
  }

  function tickOnly(name, implementation) {
    return (...args) => {
      if (!inTick) {
        violations.push(`${name} called outside the host tick`);
        throw new Error(`FiveM native ${name} was called outside the host tick`);
      }
      return implementation(...args);
    };
  }

  function installGlobals() {
    installGlobal("GetCurrentResourceName", () => resourceName);
    installGlobal("setTick", (handler) => {
      tickHandlers.push(handler);
    });
    installGlobal("on", (eventName, handler) => {
      if (eventName === "onResourceStop") stopHandlers.push(handler);
    });
    installGlobal("RegisterCommand", (name, handler) => {
      commands.set(name, handler);
    });
    // The execution natives the probe reads. `GetCurrentResourceName`,
    // `setTick`, `on` and `RegisterCommand` above are registration and identity
    // natives, which the shipped resource also calls at module scope.
    installGlobal("GetResourceState", tickOnly("GetResourceState", () => "started"));
    installGlobal("GetNumResources", tickOnly("GetNumResources", () => 3));
    installGlobal("GetGameTimer", tickOnly("GetGameTimer", () => Date.now() - startedAt));
  }

  function clearGlobals() {
    for (const [name, value] of savedGlobals) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
    savedGlobals.clear();
  }

  function tickOnce() {
    inTick = true;
    try {
      for (const handler of [...tickHandlers]) handler();
    } finally {
      inTick = false;
    }
  }

  function startTicking() {
    if (tickTimer !== null) return;
    const loop = () => {
      tickTimer = setTimeout(loop, 2);
      tickOnce();
    };
    tickTimer = setTimeout(loop, 2);
  }

  function pauseTicking() {
    if (tickTimer === null) return;
    clearTimeout(tickTimer);
    tickTimer = null;
  }

  /** Load (or reload) the bundle. Per-load host state is reset first. */
  function loadBundle() {
    tickHandlers = [];
    stopHandlers = [];
    commands = new Map();
    delete require.cache[require.resolve(modulePath)];
    require(modulePath);
  }

  function evidence(from = 0) {
    return parseEvidence(lines).filter((entry) => entry.index >= from);
  }

  async function waitForLine(tag, { from = 0, timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = evidence(from).find((entry) => entry.tag === tag);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for FIVEAI_P0 ${tag}\n` +
            `captured lines:\n${lines.join("\n")}`,
        );
      }
      await delay(20);
    }
  }

  const startedAt = Date.now();

  const host = {
    get lines() {
      return [...lines];
    },
    get violations() {
      return [...violations];
    },
    /** Console line index; pass to waitForLine({ from }) to scope a restart. */
    cursor() {
      return lines.length;
    },
    /** True while the last lifecycle line was `ready`, i.e. the resource is up. */
    isRunning() {
      const lifecycle = evidence().filter((entry) => entry.tag === "ready" || entry.tag === "stop");
      const last = lifecycle[lifecycle.length - 1];
      return last !== undefined && last.tag === "ready";
    },
    evidence,
    waitForLine,
    get commandNames() {
      return [...commands.keys()];
    },
    invokeCommand(name, source = 0, args = []) {
      const handler = commands.get(name);
      if (handler === undefined) throw new Error(`no such console command: ${name}`);
      handler(source, args, args.join(" "));
    },
    /** `onResourceStop` is dispatched the way the host does: synchronously. */
    dispatchResourceStop(name = resourceName) {
      for (const handler of [...stopHandlers]) handler(name);
    },
    /** Load the bundle again without waiting for it to become ready. */
    reload() {
      const from = host.cursor();
      loadBundle();
      return from;
    },
    async restart() {
      const from = host.reload();
      await host.waitForLine("ready", { from });
      return from;
    },
    dispose() {
      pauseTicking();
      clearGlobals();
      Object.assign(console, savedConsole);
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      activeHost = null;
      rmSync(workDir, { recursive: true, force: true });
    },
  };

  console.log = (...args) => record(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  console.error = (...args) => record(`[console.error] ${args.map(String).join(" ")}`);
  console.warn = (...args) => record(`[console.warn] ${args.map(String).join(" ")}`);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  installGlobals();

  activeHost = host;
  try {
    startTicking();
    loadBundle();
  } catch (error) {
    host.dispose();
    throw error;
  }

  return host;
}
