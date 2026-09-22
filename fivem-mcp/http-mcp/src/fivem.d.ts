/**
 * Ambient declarations for the FiveM server-side Node runtime surface that the
 * HTTP MCP experiment calls.
 *
 * Only the globals this resource actually uses are declared. Everything else
 * is deliberately left undeclared so a typo fails `pnpm typecheck:http` instead
 * of silently binding to an untyped global. `console` is intentionally absent:
 * `@types/node` already declares it, and redeclaring it would collide.
 *
 * The registration and identity natives below are called at module scope,
 * exactly as the shipped `server/main.js` already does. Execution natives that
 * read live host state are deliberately NOT listed here — the experiment
 * reaches them only through its host-tick queue, and the offline shim enforces
 * the same rule.
 *
 * This file must stay free of top-level imports and exports so it remains a
 * global script rather than becoming an isolated module.
 */

declare function GetCurrentResourceName(): string;
declare function GetResourceState(resourceName: string): string;
declare function GetNumResources(): number;
declare function GetGameTimer(): number;
/**
 * Absolute filesystem path of a resource (RFC §8.1). It is an execution native
 * over live host state, so it is only ever called from the host tick — the
 * resource directory is resolved that way.
 */
declare function GetResourcePath(resourceName: string): string;
declare function LoadResourceFile(resourceName: string, fileName: string): string | null;
declare function emit(eventName: string, ...args: unknown[]): void;
declare function RegisterConsoleListener(handler: (channel: string, message: string) => void): void;
declare function GetResourceByFindIndex(index: number): string;
declare function StartResource(name: string): boolean;
declare function StopResource(name: string): boolean;
declare function GetResourceMetadata(name: string, key: string, index: number): string | null;

/** Registers a per-frame host-thread callback; the only place natives may run. */
declare function setTick(handler: () => void): void;

/** Subscribes to a lifecycle event such as `onResourceStop`. */
declare function on(eventName: string, handler: (...args: unknown[]) => void): void;

/** Declares a console command; `restricted` limits it to the server console. */
declare function RegisterCommand(
  commandName: string,
  handler: (source: number, args: string[], rawCommand: string) => void,
  restricted?: boolean,
): void;

declare function onNet(event:string,handler:(...args:unknown[])=>void):void;
declare function emitNet(event:string,clientId:number,...args:unknown[]):void;

declare function GetPlayerName(id:string):string|null;
