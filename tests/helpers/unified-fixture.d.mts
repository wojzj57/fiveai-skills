/**
 * Type declarations for tests/helpers/unified-fixture.mjs (consumed by
 * packages/mcp TypeScript tests; the implementation stays plain .mjs).
 */

export declare function createUnifiedFixture(
  sourceRoot: string,
  options?: { install?: boolean },
): {
  root: string;
  installDir: string;
  zipPath: string;
  dispose(): void;
};
