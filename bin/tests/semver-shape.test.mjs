/**
 * bin/tests/semver-shape.test.mjs — unit coverage for isValidSemverShape()
 * in bin/forgedock.mjs (forge#2195, defense-in-depth follow-up to #2180/#2192).
 *
 * bin/forgedock.mjs is a top-level CLI script (no module.exports, and
 * importing it directly would execute the whole command router), so the
 * router-level tests in router.test.mjs exercise it end-to-end via
 * spawnSync. isValidSemverShape() gates a value that ultimately comes from
 * fetchLatestVersion() (a live npm registry HTTP call with no injection
 * seam — see the router.test.mjs file-level comments), so testing the
 * length-cap behavior through the full CLI path is impractical without a
 * network dependency.
 *
 * Instead, this file extracts the isValidSemverShape() function body
 * directly from the source text and evaluates it in isolation via
 * `new Function`, so the exact production regex/guard logic is under test
 * with no CLI invocation, no subprocess, and no network access.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs"),
  "utf-8",
);

// Extract exactly the isValidSemverShape function declaration (non-greedy up
// to the closing brace on its own line, terminating the function body).
const FN_MATCH = CLI_SOURCE.match(
  /function isValidSemverShape\(version\) \{[\s\S]*?\n\}\n/,
);
assert.ok(
  FN_MATCH,
  "isValidSemverShape() not found in bin/forgedock.mjs — source extraction pattern is stale",
);

// eslint-disable-next-line no-new-func
const isValidSemverShape = new Function(
  `${FN_MATCH[0]}\nreturn isValidSemverShape;`,
)();

describe("isValidSemverShape() — length cap (forge#2195)", () => {
  it("accepts ordinary semver strings", () => {
    assert.equal(isValidSemverShape("1.2.3"), true);
    assert.equal(isValidSemverShape("1.2.3-beta.1"), true);
    assert.equal(isValidSemverShape("10.20.30+build.5"), true);
  });

  it("rejects non-string input", () => {
    assert.equal(isValidSemverShape(undefined), false);
    assert.equal(isValidSemverShape(null), false);
    assert.equal(isValidSemverShape(123), false);
  });

  it("rejects shape-invalid strings", () => {
    assert.equal(isValidSemverShape("1.2"), false);
    assert.equal(isValidSemverShape("v1.2.3"), false);
    assert.equal(isValidSemverShape("1.2.3; rm -rf /"), false);
  });

  it("rejects a pathologically long numeric segment that would otherwise match the shape regex", () => {
    // Character-class-valid (digits only) but far longer than any real
    // semver string — the regex alone (unbounded `\d+`) would match this;
    // the explicit length cap must reject it.
    const longNumeric = `${"1".repeat(500)}.2.3`;
    assert.equal(isValidSemverShape(longNumeric), false);
  });

  it("rejects a pathologically long pre-release suffix that would otherwise match the shape regex", () => {
    const longSuffix = `1.2.3-${"a".repeat(1000)}`;
    assert.equal(isValidSemverShape(longSuffix), false);
  });

  it("accepts a version string right at the boundary and rejects one just past it", () => {
    // 100 is the cap. Build a shape-valid string of exactly 100 chars via a
    // long prerelease suffix, and one of 101 chars.
    const prefix = "1.2.3-"; // 6 chars
    const atCap = prefix + "a".repeat(100 - prefix.length); // exactly 100 chars total
    const overCap = prefix + "a".repeat(101 - prefix.length); // exactly 101 chars total
    assert.equal(atCap.length, 100);
    assert.equal(overCap.length, 101);
    assert.equal(isValidSemverShape(atCap), true);
    assert.equal(isValidSemverShape(overCap), false);
  });
});
