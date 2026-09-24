/**
 * Disabled screenshot contract (RFC §12, §14). Types and constants ONLY:
 * no handler, no route, no capture backend, no image writing, no native
 * dependency, and no enable switch. A future implementation requires its
 * own review; tools/list must exclude screenshot in this version.
 */

export const SCREENSHOT_IMPLEMENTED = false as const;
export const SCREENSHOT_ENABLED = false as const;

/** Default delay before capture when the tool is ever implemented. */
export const SCREENSHOT_DEFAULT_DELAY_MS = 0;

export interface ScreenshotRequest {
  clientId: number;
  delayMs?: number;
}

export interface ScreenshotResult {
  /** Absolute local path of the saved PNG. */
  path: string;
  width: number;
  height: number;
  clientId: number;
}
