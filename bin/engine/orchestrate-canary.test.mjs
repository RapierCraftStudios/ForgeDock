import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const canary = join(here, "orchestrate-canary.mjs");

function runCanary(...args) {
  const result = spawnSync(process.execPath, [canary, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("orchestrate re-resolution canary CLI", () => {
  it("re-resolves a query with the documented argument contract", () => {
    assert.deepEqual(runCanary("query", "priority", "true", "unbounded", "0"), {
      reResolve: true,
      reason: 'query pattern "priority" is a standing predicate — re-resolving',
    });
  });

  it("preserves literal-set and max-round termination", () => {
    assert.equal(runCanary("literal", "literal-numbers", "true", "3", "0").reResolve, false);
    assert.equal(runCanary("query", "milestone", "true", "3", "3").reResolve, false);
  });
});
