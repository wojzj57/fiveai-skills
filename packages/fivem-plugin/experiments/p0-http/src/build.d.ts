/**
 * Build-time constant injected by `scripts/build-p0-experiment.mjs` through
 * esbuild's `define`. It exists only so a host log line can be tied back to
 * the exact bundle that produced it; the delivered artifact uses the
 * repository build identity instead.
 */

declare const __P0_BUILD__: string;
