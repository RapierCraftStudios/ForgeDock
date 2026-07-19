/**
 * bin/tests/same-path-or-under.test.mjs — unit coverage for samePathOrUnder()
 * in bin/forgedock.mjs (forge#2668).
 *
 * bin/forgedock.mjs is a top-level CLI script (importing it executes the
 * command router), so — following the semver-shape.test.mjs precedent — the
 * exact production function is extracted from the source text and evaluated
 * in isolation via `new Function`. `sep` (normally imported from node:path)
 * is injected per scenario so both POSIX and Windows separators are covered
 * regardless of the host running the tests. `process.platform` is overridden
 * per test via Object.defineProperty and restored afterward, since the
 * function's case-insensitivity gate reads it directly.
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

const FN_MATCH = CLI_SOURCE.match(
  /function samePathOrUnder\(child, parent\) \{[\s\S]*?\n\}\n/,
);
assert.ok(
  FN_MATCH,
  "samePathOrUnder() not found in bin/forgedock.mjs — source extraction pattern is stale",
);

/** Build the extracted function with an injected `sep`. */
function makeFn(sep) {
  // eslint-disable-next-line no-new-func
  return new Function("sep", `${FN_MATCH[0]}\nreturn samePathOrUnder;`)(sep);
}

const REAL_PLATFORM = process.platform;
function withPlatform(platform, fn) {
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
  }
}

describe("samePathOrUnder() — case-insensitive platforms (forge#2668)", () => {
  it("matches equal paths that differ only in casing on win32", () => {
    const samePathOrUnder = makeFn("\\");
    withPlatform("win32", () => {
      assert.equal(
        samePathOrUnder("C:\\Users\\Dev\\forgedock", "c:\\users\\dev\\forgedock"),
        true,
      );
    });
  });

  it("matches child under parent with differing casing on win32", () => {
    const samePathOrUnder = makeFn("\\");
    withPlatform("win32", () => {
      assert.equal(
        samePathOrUnder("c:\\Users\\Dev\\ForgeDock\\bin", "C:\\users\\dev\\forgedock"),
        true,
      );
    });
  });

  it("matches equal paths that differ only in casing on darwin", () => {
    const samePathOrUnder = makeFn("/");
    withPlatform("darwin", () => {
      assert.equal(
        samePathOrUnder("/Users/Dev/ForgeDock", "/users/dev/forgedock"),
        true,
      );
    });
  });

  it("still rejects sibling prefix paths on win32 (sep boundary)", () => {
    const samePathOrUnder = makeFn("\\");
    withPlatform("win32", () => {
      assert.equal(
        samePathOrUnder("C:\\repo-other", "C:\\repo"),
        false,
      );
    });
  });
});

describe("samePathOrUnder() — case-sensitive platforms unchanged", () => {
  it("keeps case-sensitive equality on linux", () => {
    const samePathOrUnder = makeFn("/");
    withPlatform("linux", () => {
      assert.equal(samePathOrUnder("/home/dev/Forge", "/home/dev/forge"), false);
      assert.equal(samePathOrUnder("/home/dev/forge", "/home/dev/forge"), true);
    });
  });

  it("keeps case-sensitive containment on linux", () => {
    const samePathOrUnder = makeFn("/");
    withPlatform("linux", () => {
      assert.equal(
        samePathOrUnder("/home/dev/Forge/bin", "/home/dev/forge"),
        false,
      );
      assert.equal(
        samePathOrUnder("/home/dev/forge/bin", "/home/dev/forge"),
        true,
      );
    });
  });

  it("rejects sibling prefix paths on linux (sep boundary)", () => {
    const samePathOrUnder = makeFn("/");
    withPlatform("linux", () => {
      assert.equal(samePathOrUnder("/foo-bar", "/foo"), false);
    });
  });
});
