/**
 * Build identity shared by every process of this package (RFC §4.3: the
 * handshake compatibility condition includes a matching build ID). The
 * constants are generated at build time from the repository's explicit
 * build inputs (scripts/build-identity.mjs) and embedded in
 * src/generated/build-identity.ts, so a shipped artifact never depends on
 * a runtime package.json read; a mismatch closes the connection with
 * BUILD_MISMATCH instead of attempting mixed-version operation.
 */

export { PACKAGE_VERSION, BUILD_ID } from "./generated/build-identity.ts";
