import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCoupled, coupledFailures } from "./coupled.mjs";
import { parseVerify } from "./verify.mjs";
import { planPrecheck } from "./precheck.mjs";
import { parseTestMap } from "./testmap.mjs";
import { precheck } from "./conformance.mjs";

const rules = parseCoupled({
  "infra/ssh-guard/bootstrap-body.sh": "infra/ssh-guard/launcher.sh, infra/ssh-guard/MANIFEST.sha256",
  "added:scripts/tests/test_*.py": ".github/workflows/ci.yml",
});

describe("coupled files (#5079)", () => {
  it("coupled files: a changed file without its pinned counterpart fails", () => {
    const f = coupledFailures({ rules, changedFiles: ["infra/ssh-guard/bootstrap-body.sh", "infra/ssh-guard/launcher.sh"] });
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "coupled_file_missing");
    assert.equal(f[0].code, "conformance.unimplemented");
    assert.match(f[0].detail, /MANIFEST\.sha256/);
  });
  it("coupled files: passes when every counterpart changes, or the trigger did not", () => {
    assert.deepEqual(coupledFailures({ rules, changedFiles: ["infra/ssh-guard/bootstrap-body.sh", "infra/ssh-guard/launcher.sh", "infra/ssh-guard/MANIFEST.sha256"] }), []);
    assert.deepEqual(coupledFailures({ rules, changedFiles: ["README.md"] }), []);
  });
  it("coupled files: an added: rule fires on a new test file only", () => {
    const t = "scripts/tests/test_x.py";
    assert.equal(coupledFailures({ rules, changedFiles: [t], addedFiles: [t] }).length, 1);
    assert.deepEqual(coupledFailures({ rules, changedFiles: [t], addedFiles: [] }), []);
    assert.deepEqual(coupledFailures({ rules, changedFiles: [t, ".github/workflows/ci.yml"], addedFiles: [t] }), []);
  });
  it("coupled files: malformed config yields no rules", () => {
    assert.deepEqual(parseCoupled(null), []);
    assert.deepEqual(parseCoupled(["a"]), []);
    assert.deepEqual(parseCoupled({ "": "x", a: "" }), []);
  });
  it("coupled files: precheck() carries the failures; absent they change nothing", () => {
    const c = { requirements: [], deliverables: [], validate: [] };
    const failures = coupledFailures({ rules, changedFiles: ["infra/ssh-guard/bootstrap-body.sh"] });
    assert.equal(precheck({ contract: c, result: {}, changedFiles: [], coupledFailures: failures }).ok, false);
    assert.equal(precheck({ contract: c, result: {}, changedFiles: [] }).ok, true);
  });
  it("coupled files: test-map entries select the touched suite and formatter per path (R3, R6)", () => {
    const testMap = parseTestMap(JSON.stringify({ version: 1, entries: [
      { command: "bash infra/ssh-guard/validate-manifest.sh", globs: ["infra/ssh-guard/*.sh"] },
      { command: "black --check services/api && isort --check services/api", globs: ["services/api/**"] },
    ] }));
    const p = planPrecheck({ testMap, files: ["infra/ssh-guard/check-guard-deps.sh", "services/api/x.py"], learned: [] });
    assert.deepEqual(p.commands, ["bash infra/ssh-guard/validate-manifest.sh", "black --check services/api && isort --check services/api"]);
    assert.deepEqual(planPrecheck({ testMap, files: ["docs/a.md"], learned: [] }).commands, []);
  });
  it("coupled files: verify.precheck_block is opt-in", () => {
    assert.equal(parseVerify({ precheck_block: "true" }).precheckBlock, true);
    assert.equal("precheckBlock" in parseVerify({}), false);
    assert.equal("precheckBlock" in parseVerify({ precheck_block: "yes" }), false);
  });
});
