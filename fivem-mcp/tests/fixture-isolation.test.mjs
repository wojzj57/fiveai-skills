/**
 * Fixture isolation regression.
 *
 * `createUnifiedFixture` is what lets the package suite build and run inside a
 * throwaway workspace. Its predecessor test was removed together with the
 * retired unified pack chain, which left the helper's own guarantees — the
 * fixture is separate from the repository, generated trees are not copied, and
 * disposing it leaves the source tree untouched — with no dedicated coverage.
 * This restores that coverage without reviving the retired chain.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createUnifiedFixture } from "./helpers/unified-fixture.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
/** One tracked source file, hashed before and after to prove nothing was written. */
const sentinel = join("fivem-mcp", "http-mcp", "src", "server.ts");

function digest(relative) {
  return createHash("sha256").update(readFileSync(join(sourceRoot, relative))).digest("hex");
}

test("a fixture is a separate copy that never writes into the repository", () => {
  const before = digest(sentinel);
  const fixture = createUnifiedFixture(sourceRoot, { install: false });
  try {
    assert.notEqual(fixture.root, sourceRoot, "the fixture must not be the repository itself");
    assert.equal(
      fixture.root.startsWith(sourceRoot),
      false,
      "the fixture must live outside the repository tree",
    );
    // The inputs the build and the identity hash need are present...
    assert.equal(existsSync(join(fixture.root, "fivem-mcp", "package.json")), true);
    assert.equal(existsSync(join(fixture.root, "pnpm-workspace.yaml")), true);
    // ...while generated trees are not copied, so they cannot be mistaken for
    // fixture output or dragged in from the developer's machine.
    for (const generated of ["node_modules", join("fivem-mcp", "artificials")]) {
      assert.equal(
        existsSync(join(fixture.root, generated)),
        false,
        `generated tree copied into the fixture: ${generated}`,
      );
    }
    assert.equal(digest(sentinel), before, "creating a fixture must not modify the repository");
  } finally {
    fixture.dispose();
  }
  assert.equal(existsSync(fixture.root), false, "dispose must remove the fixture directory");
  assert.equal(digest(sentinel), before, "disposing a fixture must not modify the repository");
});
