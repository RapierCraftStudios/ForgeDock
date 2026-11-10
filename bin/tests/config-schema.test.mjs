import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateForgeYaml, scanKeys, TOP_LEVEL } from "../config-schema.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = 'project:\n  owner: "o"\n  repo: "r"\npaths:\n  root: "/x"\nbranches:\n  default: "main"\n';
const codes = (t, o) => validateForgeYaml(t, o).map((f) => `${f.code}:${f.key}`);

describe("validateForgeYaml (#5315)", () => {
  it("accepts a clean config", () => {
    assert.deepEqual(validateForgeYaml(BASE + "verification:\n  ci_local:\n    mode: blocking\n    extra_commands:\n      - \"make lint\"\n"), []);
  });
  it("flags an unknown top-level key, naming it", () => {
    const f = validateForgeYaml(BASE + "verifcation:\n  x: 1\n");
    assert.equal(f.length, 1);
    assert.equal(f[0].level, "error");
    assert.match(f[0].message, /verifcation/);
  });
  it("flags an unknown ci_local child (a typo'd extra_commands would be silent otherwise)", () => {
    assert.deepEqual(codes(BASE + "verification:\n  ci_local:\n    extra_command:\n      - x\n"), ["unknown-key:verification.ci_local.extra_command"]);
  });
  it("flags a key the active path ignores, and not on the path that reads it", () => {
    const t = BASE + "engine:\n  path: full\nverify:\n  mode: ci\n";
    assert.deepEqual(codes(t), ["ignored-on-path:verify"]);
    assert.deepEqual(codes(t, { path: "core" }), []);
    assert.deepEqual(codes(BASE + "verify:\n  mode: ci\n"), []);
  });
  it("flags wrong types", () => {
    const t = BASE + "verification:\n  ci_local:\n    extra_commands: make lint\n    max_parallel: many\n    mode: sometimes\n";
    assert.deepEqual(codes(t).sort(), ["wrong-type:verification.ci_local.extra_commands", "wrong-type:verification.ci_local.max_parallel", "wrong-type:verification.ci_local.mode"]);
    assert.deepEqual(codes(BASE + "engine:\n  path: sideways\n"), ["wrong-type:engine.path"]);
  });
  it("warns on a deprecated alias", () => {
    const f = validateForgeYaml(BASE + "pipeline:\n  token_budget_per_batch: 5\n");
    assert.deepEqual(f.map((x) => x.level), ["warn"]);
    assert.match(f[0].message, /orchestration\.cascade\.token_budget/);
  });
  it("ignores comments, block scalars and list items", () => {
    const t = BASE + "# note\nreview:\n  context: |\n    bogus: not a key\n  other: 1\n";
    assert.deepEqual(validateForgeYaml(t), []);
    assert.equal(scanKeys(t).has("review.bogus"), false);
  });
  it("registry covers every top-level section documented in docs/CONFIG.md", () => {
    const docs = readFileSync(join(root, "docs/CONFIG.md"), "utf8");
    const missing = new Set();
    for (const h of docs.matchAll(/^## (.+)$/gm)) {
      if (!/\((REQUIRED|OPTIONAL)\)/.test(h[1])) continue;
      for (const m of h[1].matchAll(/`([a-z_]+)(?:\.[a-z_.]+)?`/g)) if (!TOP_LEVEL.includes(m[1])) missing.add(m[1]);
    }
    assert.deepEqual([...missing], [], `documented sections missing from TOP_LEVEL: ${[...missing].join(", ")}`);
  });
});
