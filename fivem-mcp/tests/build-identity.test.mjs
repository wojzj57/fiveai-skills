/**
 * Build identity tests (F3 remediation): the identity must be a pure
 * function of the explicit build inputs — the same source in different
 * directories (and without .git) yields one identity, a resource source
 * edit changes it, restoring the source restores it, and runtime files
 * (credentials, local config) never enter the hash. The generator embeds
 * exact string literals, skips identical rewrites, and importing it never
 * writes files; only the CLI does.
 *
 * These fixtures are hash-only (install: false): the generator reads the
 * source tree but installs nothing, so no multi-minute offline install
 * runs here. The real-artifact A/B mismatch regression lives in
 * tests/process/broker-process.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createUnifiedFixture } from "./helpers/unified-fixture.mjs";
import { getBuildIdentity, writeBuildIdentity } from "../scripts/build-identity.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const GENERATED_RELATIVE = "fivem-mcp/src/generated/build-identity.ts";

test("the same source in different directories (no .git) yields one identity", () => {
  const fixtureA = createUnifiedFixture(sourceRoot, { install: false });
  const fixtureB = createUnifiedFixture(sourceRoot, { install: false });
  try {
    const identityA = getBuildIdentity(fixtureA.root);
    const identityB = getBuildIdentity(fixtureB.root);
    assert.equal(identityA.buildId, identityB.buildId, "different directories do not change the identity");
    assert.equal(identityA.packageVersion, identityB.packageVersion);
    // The source repository — with its .git, node_modules, dist/, and
    // artifact/ trees — hashes identically to a bare copy of the inputs.
    assert.equal(getBuildIdentity(sourceRoot).buildId, identityA.buildId);
    // Identity policy: the prefixed form is fivem-mcp/<package version>/<sha256
    // hex> for the retiring desktop consumers, and `digest` carries the same
    // SHA-256 alone — the shape the runtime-debug contract's status.buildId
    // requires (`^[a-f0-9]{64}$`).
    assert.match(identityA.buildId, new RegExp(`^fivem-mcp/${identityA.packageVersion}/[0-9a-f]{64}$`));
    assert.match(identityA.digest, /^[0-9a-f]{64}$/);
    assert.equal(identityA.buildId, `fivem-mcp/${identityA.packageVersion}/${identityA.digest}`);
    assert.equal(identityA.digest, identityB.digest, "the digest is deterministic too");
  } finally {
    fixtureB.dispose();
    fixtureA.dispose();
  }
});

test("resource source edits change the build id; runtime files never do", () => {
  const fixture = createUnifiedFixture(sourceRoot, { install: false });
  try {
    const before = getBuildIdentity(fixture.root);
    const serverPath = join(fixture.root, "fivem-mcp/src/server/main.js");
    const original = readFileSync(serverPath, "utf8");
    writeFileSync(serverPath, original + "\n// build identity regression\n");
    assert.notEqual(getBuildIdentity(fixture.root).buildId, before.buildId);
    writeFileSync(serverPath, original);
    assert.equal(getBuildIdentity(fixture.root).buildId, before.buildId);

    // Runtime credentials and the local config are not build inputs.
    writeFileSync(
      join(fixture.root, "fivem-mcp/config/credentials.json"),
      JSON.stringify({ entryToken: "runtime", bridgeToken: "runtime" }),
    );
    writeFileSync(
      join(fixture.root, "fivem-mcp/config/config.example.json"),
      JSON.stringify({ version: 1, broker: { host: "127.0.0.1", port: 1 }, serverLabel: "runtime-edit" }),
    );
    assert.equal(getBuildIdentity(fixture.root).buildId, before.buildId);
  } finally {
    fixture.dispose();
  }
});

test("writeBuildIdentity embeds exact literals, skips identical rewrites, and importing never writes", async () => {
  const fixture = createUnifiedFixture(sourceRoot, { install: false });
  try {
    const generatedPath = join(fixture.root, GENERATED_RELATIVE);
    rmSync(generatedPath, { force: true });

    // Importing the generator module is side-effect free.
    const generator = await import(pathToFileURL(join(fixture.root, "fivem-mcp", "scripts", "build-identity.mjs")).href);
    assert.equal(existsSync(generatedPath), false, "importing must never write the generated module");

    const identity = generator.writeBuildIdentity(fixture.root);
    assert.equal(identity.buildId, getBuildIdentity(fixture.root).buildId);
    const expected =
      `export const PACKAGE_VERSION = ${JSON.stringify(identity.packageVersion)};\n` +
      `export const BUILD_ID = ${JSON.stringify(identity.buildId)};\n`;
    assert.equal(readFileSync(generatedPath, "utf8"), expected, "the generated module carries exactly the two literals");

    // Identical content is not rewritten: pin the mtime far in the past and
    // require it to survive a second writeBuildIdentity call.
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(generatedPath, pinned, pinned);
    generator.writeBuildIdentity(fixture.root);
    assert.ok(statSync(generatedPath).mtimeMs < Date.now() - 60_000, "identical content is not rewritten");

    // The CLI reports the identity and exits zero; a missing required input
    // fails non-zero without writing anything new.
    const cli = spawnSync(process.execPath, [join(fixture.root, "fivem-mcp", "scripts", "build-identity.mjs")], { encoding: "utf8" });
    assert.equal(cli.status, 0, `CLI stderr: ${cli.stderr}`);
    assert.match(cli.stdout, /^build-identity: fivem-mcp\//);
    assert.equal(readFileSync(generatedPath, "utf8"), expected);

    rmSync(join(fixture.root, "package-lock.json"));
    const failed = spawnSync(process.execPath, [join(fixture.root, "fivem-mcp", "scripts", "build-identity.mjs")], { encoding: "utf8" });
    assert.notEqual(failed.status, 0, "a missing required input must fail the CLI");
    assert.match(failed.stderr, /build input/);
    assert.throws(() => generator.getBuildIdentity(fixture.root), /build input/);
  } finally {
    fixture.dispose();
  }
});
