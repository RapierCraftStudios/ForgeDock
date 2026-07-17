import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyInputPattern, shouldReResolve, foldNewMatches } from "./resolve.mjs";

describe("classifyInputPattern — literal sets", () => {
  it("classifies bare issue numbers as literal", () => {
    assert.deepEqual(classifyInputPattern("1 2 3"), {
      kind: "literal",
      pattern: "literal-numbers",
      args: ["1", "2", "3"],
    });
  });

  it("classifies #-prefixed issue numbers as literal", () => {
    const r = classifyInputPattern("#1 #2 #3");
    assert.equal(r.kind, "literal");
    assert.equal(r.pattern, "literal-numbers");
  });

  it("classifies repo-prefixed literal numbers as literal", () => {
    const r = classifyInputPattern("#123 mcp:5 n8n:12");
    assert.equal(r.kind, "literal");
    assert.equal(r.pattern, "literal-numbers");
  });

  it("classifies a single bare number as literal", () => {
    const r = classifyInputPattern("42");
    assert.equal(r.kind, "literal");
  });
});

describe("classifyInputPattern — query patterns", () => {
  it("classifies milestone <slug> as a query", () => {
    const r = classifyInputPattern("milestone modular-pipeline-architecture");
    assert.equal(r.kind, "query");
    assert.equal(r.pattern, "milestone");
    assert.deepEqual(r.args, ["modular-pipeline-architecture"]);
  });

  it("classifies next <N> as a query", () => {
    const r = classifyInputPattern("next 5");
    assert.equal(r.kind, "query");
    assert.equal(r.pattern, "next-n");
  });

  it("classifies next <N> all-repos as a query", () => {
    const r = classifyInputPattern("next 5 all-repos");
    assert.equal(r.kind, "query");
    assert.equal(r.pattern, "next-n-all-repos");
  });

  it("classifies fast-lane / fast as a query", () => {
    assert.equal(classifyInputPattern("fast-lane").pattern, "fast-lane");
    assert.equal(classifyInputPattern("fast").pattern, "fast-lane");
    assert.equal(classifyInputPattern("fast-lane").kind, "query");
  });

  it("classifies priority:P0 / priority:P1 as a query (both label schemas, forge#2232)", () => {
    assert.equal(classifyInputPattern("priority:P0").pattern, "priority");
    assert.equal(classifyInputPattern("priority:P1").kind, "query");
    assert.equal(classifyInputPattern("mcp:priority:P2").pattern, "priority");
  });

  it("classifies repo-scoped queries as a query", () => {
    assert.equal(classifyInputPattern("mcp:fast").pattern, "repo-scoped");
    assert.equal(classifyInputPattern("n8n:next 3").pattern, "repo-scoped");
  });

  it("classifies cascade/review-findings/findings as a query", () => {
    assert.equal(classifyInputPattern("cascade").pattern, "cascade");
    assert.equal(classifyInputPattern("review-findings").pattern, "cascade");
    assert.equal(classifyInputPattern("findings --include-deferred").pattern, "cascade");
  });

  it("classifies a bare slug as a query", () => {
    const r = classifyInputPattern("some-milestone-slug");
    assert.equal(r.kind, "query");
    assert.equal(r.pattern, "bare-slug");
  });

  it("classifies empty/unrecognized input as an unknown query, never literal", () => {
    assert.equal(classifyInputPattern("").kind, "query");
    assert.equal(classifyInputPattern("").pattern, "unknown");
  });
});

describe("shouldReResolve", () => {
  it("never re-resolves a literal set, regardless of config", () => {
    const classified = { kind: "literal", pattern: "literal-numbers", args: ["1"] };
    const r = shouldReResolve(classified, { enabled: true, maxRounds: 100 }, 0);
    assert.equal(r.reResolve, false);
    assert.match(r.reason, /never re-resolve/);
  });

  it("re-resolves a query pattern by default (no config)", () => {
    const classified = { kind: "query", pattern: "priority", args: [] };
    const r = shouldReResolve(classified);
    assert.equal(r.reResolve, true);
  });

  it("respects an explicit off switch (boolean false)", () => {
    const classified = { kind: "query", pattern: "fast-lane", args: [] };
    const r = shouldReResolve(classified, { enabled: false });
    assert.equal(r.reResolve, false);
    assert.match(r.reason, /off/);
  });

  it("respects an explicit off switch (string 'off', case-insensitive)", () => {
    const classified = { kind: "query", pattern: "fast-lane", args: [] };
    assert.equal(shouldReResolve(classified, { enabled: "off" }).reResolve, false);
    assert.equal(shouldReResolve(classified, { enabled: "OFF" }).reResolve, false);
  });

  it("bounds termination via maxRounds", () => {
    const classified = { kind: "query", pattern: "milestone", args: [] };
    assert.equal(shouldReResolve(classified, { maxRounds: 3 }, 2).reResolve, true);
    const atLimit = shouldReResolve(classified, { maxRounds: 3 }, 3);
    assert.equal(atLimit.reResolve, false);
    assert.match(atLimit.reason, /max_rounds/);
  });
});

describe("foldNewMatches", () => {
  it("returns issues not already in the processed registry", () => {
    const r = foldNewMatches([10, 11, 12], [10, 11]);
    assert.deepEqual(r.newMatches, [12]);
    assert.deepEqual(r.alreadyProcessed, [10, 11]);
  });

  it("is idempotent — re-running with an updated registry returns nothing new", () => {
    const first = foldNewMatches([10, 11, 12], [10, 11]);
    assert.deepEqual(first.newMatches, [12]);
    const registryAfterFold = new Set([10, 11, ...first.newMatches]);
    const second = foldNewMatches([10, 11, 12], registryAfterFold);
    assert.deepEqual(second.newMatches, []);
    assert.deepEqual(second.alreadyProcessed, [10, 11, 12]);
  });

  it("de-dupes duplicate numbers within the same re-resolution result", () => {
    const r = foldNewMatches([5, 5, 6], []);
    assert.deepEqual(r.newMatches, [5, 6]);
  });

  it("handles an empty re-resolution result", () => {
    const r = foldNewMatches([], [1, 2, 3]);
    assert.deepEqual(r.newMatches, []);
    assert.deepEqual(r.alreadyProcessed, []);
  });
});
