// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { outputTail, removedNamedPaths, removedPathsOf, shellSyntaxError, unrunnableValidate, noopCommand, substituteVerdict, describesUnrunnableCommand, vitestQuietFlag, normalizeRunnerCommand, cliUsageError, validateContract, applyAmendments, amendmentKindProblems, precheck, hotspotGrowth, reproFailures, isBugIssue, parseReview, checkCompleteness, decide, closePlan, isInvestigation, formatShadowSummary, followupItems, inIssue, snapQuote, snapQuotes, isTestPath, normalizeEvidencePath, mergeReviewRows, reviewSkeleton, missingIds, resolveEvidencePath, movingBaseDiff, scopeText, evidencePathLine, evidencePathOnly, reaskable, matchCriterion, criterionLines, fillEngineRows, explainFailures, resolveForgedockPaths, missingTool, repoTracks, tmpdirInputs, isScopeCheck, isPureScopeCheck, dropScopeValidates, tagOutOfBand, outOfBandRequirements, isOutOfBand, followupMap, renderPendingFollowups, VERIFY_MODES, OUT_OF_BAND_RE, FOLLOWUP_CLASSES, followupClass, inLaneDeferral, pendingTracking, BUCKETS, bucketKind, bucketProblems, bucketTally, isE2eCommand, e2eVerified, impliedDocDeliverables, applyValidateRecipes, deferChecklessPostDeploy, substituteShellProblem, reproEnvMiss, ORCHESTRATOR_BUCKET, ownerRoute, weakenedE2eDecisions, guessedUvEnv, projectDirPathMiss, rewriteProjectDirCommand, convertDelivered } from "./conformance.mjs";

const ISSUE = "## Requirements\n1. The scrape route must release the spend reservation on 429.\n2. The search route must release the spend reservation on 429.\n\n- [ ] Billing pricing is unchanged.";
const Q1 = "The scrape route must release the spend reservation on 429.";
const Q2 = "The search route must release the spend reservation on 429.";
const C = {
  requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "deliver" }],
  deliverables: [{ id: "D1", path: "src/scrape.js" }, { id: "D2", path: "src/search.js" }],
  preserve: [{ id: "P1", what: "Billing pricing is unchanged. (src/billing.js)" }],
  validate: [{ id: "V1", command: "node --test test/leak.test.js" }],
};
const files = ["src/scrape.js", "src/search.js", "test/leak.test.js"];
const ctx = { contract: C, changedFiles: files, issueText: ISSUE, pathExists: (p) => p === "src/billing.js" };
const good = {
  issue_coverage: [{ quote: Q1, status: "covered" }, { quote: Q2, status: "covered" }, { quote: "Billing pricing is unchanged.", status: "covered" }],
  requirements: [{ id: "R1", status: "implemented", evidence: "src/scrape.js:7", validated_by: "V1" }, { id: "R2", status: "implemented", evidence: "src/search.js:7", validated_by: "V1" }],
  scope: [{ file: "src/scrape.js", authorized_by: "D1" }, { file: "src/search.js", authorized_by: "D2" }, { file: "test/leak.test.js", authorized_by: "test" }],
  preserve: [{ id: "P1", status: "intact", evidence: "src/billing.js:1" }], regressions: [], verdict: "CONFORMS", summary: "ok",
};
const row = (id, patch) => ({ ...good, requirements: good.requirements.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
const codes = (d) => d.failures.map((f) => f.code);

describe("contract", () => {
  it("a well-formed contract with verbatim quotes is valid", () => assert.deepEqual(validateContract(C, ISSUE), { ok: true, problems: [] }));
  it("quotes must be verbatim (whitespace and emphasis aside) and long enough", () => {
    assert.ok(inIssue("the  SCRAPE route must release the spend reservation on 429.", ISSUE));
    assert.ok(!inIssue("scrape should free money", ISSUE));
    assert.ok(!inIssue("429.", ISSUE), "too short to identify a requirement");
  });
  it("#4789: unicode punctuation and markdown markup do not break the verbatim check; a miss shows the nearest span", () => {
    const issue = "## Problem\nThe \u201cscrape\u201d route \u2014 see [the spec](http://x.y) \u2014 must release the spend reservation\u2026 on 429.\n\nUnrelated line about billing.";
    assert.ok(inIssue('The "scrape" route - see the spec - must release the spend reservation... on 429.', issue));
    assert.ok(inIssue("The \u201cscrape\u201d route \\- see the spec", issue.replace("\u2014", "-")));
    assert.ok(!inIssue("the scrape route must hold the reservation forever", issue));
    const v = validateContract({ ...C, requirements: [{ ...C.requirements[0], quote: "the scrape route must hold the spend reservation on 429" }] }, issue);
    assert.match(v.problems[0], /R1: quote is not verbatim from the issue.*nearest issue text: "The \u201cscrape\u201d route/);
  });
  it("rejects paraphrases, a defer without why, not-applicable without evidence, missing validate, duplicate ids", () => {
    const v = validateContract({ ...C, validate: [], requirements: [
      { id: "R1", quote: "make scrape better", disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "defer" },
      { id: "R2", quote: Q2, disposition: "not-applicable" }, { id: "R4", quote: Q1, disposition: "maybe" }] }, ISSUE);
    assert.equal(v.ok, false);
    for (const p of [/R1: quote is not verbatim/, /R2: defer needs a why/, /duplicated: R2/, /not-applicable needs file:line evidence/, /R4: disposition must be one of/, /no validate\[\] commands/]) assert.ok(v.problems.some((x) => p.test(x)), String(p));
    assert.equal(validateContract(null, ISSUE).ok, false);
  });
});

describe("amendments", () => {
  it("add-deliverable, add-requirement and defer apply with a why; defer is queued for tracking once", () => {
    const a = applyAmendments(C, [
      { kind: "add-deliverable", path: "src/shared.js", why: "both routes share the helper" },
      { kind: "add-requirement", requirement: { id: "R3", quote: "Billing pricing is unchanged.", disposition: "deliver" }, why: "missed" },
      { kind: "defer", requirement: "R2", why: "search is owned by another module" }]);
    assert.deepEqual(a.problems, []);
    assert.ok(a.contract.deliverables.some((d) => d.path === "src/shared.js"));
    assert.equal(a.contract.requirements.find((r) => r.id === "R2").disposition, "defer");
    assert.deepEqual(a.toTrack.map((r) => r.id), ["R2"]);
    assert.equal(a.applied.length, 3);
    assert.equal(C.requirements[1].disposition, "deliver", "the frozen contract is never mutated");
  });
  it("an amendment without a why, an unknown requirement or an unknown kind is a problem, not applied", () => {
    const a = applyAmendments(C, [{ kind: "add-deliverable", path: "x.js" }, { kind: "defer", requirement: "R9", why: "w" }, { kind: "rewrite", why: "w" }]);
    assert.equal(a.problems.length, 3); assert.equal(a.applied.length, 0);
  });
});

describe("amendment kind aliases (#4856)", () => {
  it("deferral spellings apply as a tracked defer of R1", () => {
    for (const kind of ["deferred", "deferral", "scope_deferral", "Scope-Deferral"]) {
      const a = applyAmendments(C, [{ kind, requirement: "R1", why: "w" }]);
      assert.deepEqual(a.problems, [], kind);
      assert.equal(a.contract.requirements.find((r) => r.id === "R1").disposition, "defer", kind);
      assert.deepEqual(a.toTrack.map((r) => r.id), ["R1"], kind);
    }
  });
  it("unlisted kinds stay unknown and list the valid kinds (scope-note is informational since #5036)", () => {
    for (const kind of ["scope-creep", "Scope_Creep", "flaky-note"]) {
      assert.match(applyAmendments(C, [{ kind, requirement: "R1", why: "w" }]).problems[0], new RegExp(`unknown kind '${kind}'; valid kinds are add-deliverable`));
    }
  });
});

describe("#4655 multi-requirement amendment references", () => {
  it("R1/R2, 'R1, R2' and an en-dash range split into one applied row per id", () => {
    for (const requirement of ["R1/R2", "R1, R2", "R1\u2013R2", "R1 and R2"]) {
      const a = applyAmendments(C, [{ kind: "defer", requirement, why: "w" }]);
      assert.deepEqual(a.problems, [], requirement);
      assert.deepEqual(a.toTrack.map((r) => r.id).sort(), ["R1", "R2"], requirement);
      assert.deepEqual(a.applied.map((x) => x.target), ["R1", "R2"], requirement);
    }
  });
  it("an unknown id inside a list is still a problem; an unknown kind with a requirement is still unknown", () => {
    assert.match(applyAmendments(C, [{ kind: "defer", requirement: "R1/R9", why: "w" }]).problems[0], /unknown requirement R9/);
    assert.match(applyAmendments(C, [{ kind: "scope-creep", requirement: "R1", why: "w" }]).problems[0], /unknown kind 'scope-creep'; valid kinds are/);
  });
  it("an unrelated-ci-failure amendment (kind or type) is an informational no-op; other unknown kinds still fail", () => {
    for (const a of [{ kind: "unrelated-ci-failure", target: "core rate-limit test", why: "diff touches no core file" }, { type: "unrelated-ci-failure", target: "t", why: "w" }]) {
      const r = applyAmendments(C, [a]);
      assert.deepEqual(r.problems, []);
      assert.deepEqual(r.contract, C);
      assert.equal(r.applied[0].kind, "unrelated-ci-failure");
    }
    assert.match(applyAmendments(C, [{ kind: "flaky-note", why: "w" }]).problems[0], /unknown kind 'flaky-note'; valid kinds are/);
  });
  it("supersede-guard guards[] expands to per-guard supersedes", () => {
    const a = applyAmendments(C, [{ kind: "supersede-guard", guards: ["#4879", "#4838"], why: "x" }]);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(a.contract.supersedes, [{ guard: "#4879", why: "x" }, { guard: "#4838", why: "x" }]);
    assert.equal(a.applied.length, 2);
  });
  it("synonym kinds and a supersedes amendment with guards[] expand alike; an invalid guard id is reported", () => {
    for (const kind of ["supersede", "supersedes-guard", "supersedes"]) {
      const a = applyAmendments(C, [{ kind, guards: ["4879", "#4838"], why: "x" }]);
      assert.deepEqual(a.problems, [], kind);
      assert.deepEqual(a.contract.supersedes.map((s) => s.guard), ["#4879", "#4838"], kind);
    }
    const bad = applyAmendments(C, [{ kind: "supersedes", guards: ["#4879", "abc"], why: "x" }]);
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0], /needs guard/);
    assert.deepEqual(bad.contract.supersedes.map((s) => s.guard), ["#4879"]);
    assert.match(applyAmendments(C, [{ kind: "supersede-guard", guards: [], why: "x" }]).problems[0], /needs guard/);
  });
  it("an unrelated unknown kind is still rejected with the valid-kinds message", () => {
    assert.match(applyAmendments(C, [{ kind: "supersede-everything", guards: ["#1"], why: "w" }]).problems[0], /unknown kind 'supersede-everything'; valid kinds are/);
  });
});

describe("#4574 amendment slips", () => {
  it("type for kind, amend-requirement and limitation apply as defer; an R# id fills requirement", () => {
    const a = applyAmendments(C, [{ kind: "amend-requirement", id: "R2", why: "stored hashed" }, { id: "A1", requirement: "R1", type: "limitation", why: "plugin limit" }]);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(a.toTrack.map((r) => r.id).sort(), ["R1", "R2"]);
    assert.ok(a.contract.requirements.every((r) => r.disposition === "defer"));
  });
  it("an unknown kind names the valid kinds and shows the full amendment", () => {
    const why = "x".repeat(300);
    const a = applyAmendments(C, [{ kind: "rewrite", why }]);
    assert.match(a.problems[0], /unknown kind 'rewrite'; valid kinds are add-deliverable, add-requirement, defer, post-deploy/);
    assert.ok(a.problems[0].includes(why));
  });
  it("an Object.prototype key as kind is an unknown kind, not a slip", () => {
    assert.match(applyAmendments(C, [{ kind: "constructor", why: "w" }]).problems[0], /unknown kind 'constructor'; valid kinds are add-deliverable/);
  });
  it("an incomplete known kind names the missing field", () => {
    assert.match(applyAmendments(C, [{ kind: "defer", why: "w" }]).problems[0], /'defer' needs requirement/);
  });
});

describe("precheck (deterministic, no reviewer)", () => {
  const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
  it("passes a complete, validated, in-scope change", () => assert.deepEqual(precheck({ contract: C, result: res, changedFiles: files }), { ok: true, failures: [], superseded: [], ciCovered: [] }));
  it("unauthorized file -> scope_creep; tests and ignored paths are always allowed", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: res, changedFiles: [...files, "src/billing.js", ".forge-lean/x", "tests/test_x.py", "pkg/foo_test.go"], ignore: [".forge-lean/"] })), ["conformance.scope_creep"]);
    for (const t of ["test/a.js", "src/a.test.ts", "tests/test_a.py", "a_test.go", "spec/a.spec.js"]) assert.ok(isTestPath(t), t);
    assert.ok(!isTestPath("src/testing.js"));
  });
  it("failed or missing validation -> unimplemented", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [{ id: "V1", exit: 1 }] }, changedFiles: files })), ["conformance.unimplemented"]);
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [] }, changedFiles: files })), ["conformance.unimplemented"]);
  });
  it("#4857 validateContract rejects a validate command that fails bash -n", () => {
    const prose = { ...C, validate: [{ id: "V3", command: "node checks.mjs --base origin/staging (then run the scoped tsc/eslint commands it prints)" }] };
    assert.ok(validateContract(prose, ISSUE).problems.some((p) => /V3: the command is not valid shell/.test(p)));
    assert.ok(!validateContract({ ...C, validate: [{ id: "V1", command: "node checks.mjs --base origin/staging" }] }, ISSUE).problems.some((p) => /valid shell/.test(p)));
    assert.equal(shellSyntaxError("echo ok && true"), null);
    assert.ok(shellSyntaxError("echo (oops"));
  });
  it("#4857 a command that died before any test ran is contract.invalid_command; substitute-validate swaps a runnable one", () => {
    assert.ok(unrunnableValidate({ rc: 5, output: "collected 0 items / 1 deselected\nno tests ran" }));
    assert.ok(unrunnableValidate({ rc: 1, output: "Poetry could not find a pyproject.toml file in /repo" }));
    assert.ok(!unrunnableValidate({ rc: 1, output: "AssertionError: 1 !== 2" }));
    assert.ok(!unrunnableValidate({ rc: 0, output: "no tests ran" }));
    const r = applyAmendments({ requirements: [], validate: [{ id: "V2", command: "poetry run pytest -k 404_probe" }] }, [{ kind: "substitute-validate", validate: "V2", command: "poetry -C services/worker run pytest tests/test_probe.py", why: "no pyproject at root" }]);
    assert.deepEqual(r.problems, []);
    assert.equal(r.contract.validate[0].command, "poetry -C services/worker run pytest tests/test_probe.py");
    assert.equal(r.contract.validate[0].substituted.from, "poetry run pytest -k 404_probe");
    const bad = applyAmendments({ requirements: [], validate: [{ id: "V2", command: "x" }] }, [{ kind: "substitute-validate", validate: "V2", command: "echo (oops", why: "w" }]);
    assert.ok(bad.problems.some((p) => /not valid shell/.test(p)));
    assert.ok(applyAmendments({ requirements: [], validate: [] }, [{ kind: "substitute-validate", validate: "V9", command: "true", why: "w" }]).problems.length);
  });
  it("#4995 noopCommand bare keywords and constant-false guards", () => {
    for (const cmd of ["if true\nthen\n  :\nfi", "while true\ndo\n  :\ndone", "if false; then pytest; fi", "if [ 0 = 1 ]; then pytest; fi", "if test -n \"\"; then node --test a.test.mjs; fi", "while false; do pytest; done", "if false\nthen\n  pytest\nfi"]) assert.ok(noopCommand(cmd), JSON.stringify(cmd));
    for (const cmd of ["if [ -f x ]; then pytest; fi", "for f in a b; do node --test $f; done", "if false; then :; else pytest; fi", "if true\nthen\n  pytest\nfi", "if false; then :; elif [ -f x ]; then pytest; fi"]) assert.ok(!noopCommand(cmd), JSON.stringify(cmd));
  });
  it("#4979 SPEC-2 a substitute that runs no check is rejected at amendment time", () => {
    for (const cmd of ["true", ":", "exit 0", "echo ok", "true && echo done", "printf x | true"]) {
      assert.ok(noopCommand(cmd), cmd);
      const r = applyAmendments({ requirements: [], validate: [{ id: "V2", command: "poetry run pytest -k probe" }] }, [{ kind: "substitute-validate", validate: "V2", command: cmd, why: "w" }]);
      assert.ok(r.problems.some((p) => /runs no check/.test(p)), cmd);
    }
    for (const cmd of ["node --test a.test.mjs", "echo start && pytest tests/x.py", "test -f out.json", "[ -f a ] && npm test", "bash scripts/check.sh", "if [ -f x ]; then pytest; fi", "if true; then node --test a.test.mjs; fi", "for f in a b; do node --test $f; done"]) assert.ok(!noopCommand(cmd), cmd); // SEC-22: keywords around a real check
    for (const cmd of ["test 1", "[ 1 ]", "sleep 0", "node -e 0", "true\ntrue", "if true; then :; fi", "python -c pass", "exit 1"]) assert.ok(noopCommand(cmd), JSON.stringify(cmd)); // SEC-12
  });
  it("#4979 SPEC-2 a substitute stands only when the frozen command cannot run", () => {
    const sub = applyAmendments({ ...C, validate: [{ id: "V1", command: "poetry run pytest -k leak" }] }, [{ kind: "substitute-validate", validate: "V1", command: "node --test test/leak.test.js", why: "no pyproject at root" }]).contract;
    const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    const run = (substitutedRuns) => precheck({ contract: sub, result: res, changedFiles: files, substitutedRuns });
    assert.deepEqual(run({ V1: { rc: 1, output: "Poetry could not find a pyproject.toml file in /repo" } }).failures, [], "unrunnable original: substitute stands");
    assert.deepEqual(run({ V1: { rc: 127, output: "poetry: command not found" } }).failures, [], "missing runner");
    assert.deepEqual(run({ V1: { rc: 0, output: "1 passed" } }).failures, [], "original passes anyway");
    const runs = run({ V1: { rc: 1, output: "FAILED tests/test_leak.py::test_release - AssertionError" } });
    assert.deepEqual(runs.failures.map((f) => f.kind), ["validate_failed"], "a failing original may not be hidden");
    assert.match(runs.failures[0].detail, /frozen command runs and fails \(exit 1\)/);
    assert.deepEqual(run(null).failures.map((f) => f.kind), ["substitute_unverified"], "no rerun: fail closed");
    assert.deepEqual(run({ V1: { rc: 124, output: "" } }).failures.map((f) => f.kind), ["validate_timeout"]);
    assert.deepEqual(precheck({ contract: sub, result: res, changedFiles: files, ciVerified: true, substitutedRuns: { V1: { rc: 1, output: "AssertionError" } } }).failures.map((f) => f.kind), ["validate_failed"], "CI never covers a hidden failure");
    assert.equal(substituteVerdict(undefined), "unverified");
    // SEC-11: a second substitute of the same id never replaces the frozen command the engine reruns
    const twice = applyAmendments({ ...C, validate: [{ id: "V1", command: "poetry run pytest -k leak" }] }, [
      { kind: "substitute-validate", validate: "V1", command: "nonexistent-xyz", why: "a" },
      { kind: "substitute-validate", validate: "V1", command: "node --test test/leak.test.js", why: "b" },
    ]).contract;
    assert.equal(twice.validate[0].substituted.from, "poetry run pytest -k leak");
    assert.equal(twice.validate[0].command, "node --test test/leak.test.js");
    // SEC-21: a planner-set substituted field on the frozen contract is dropped; only an amendment sets it
    const planted = applyAmendments({ ...C, validate: [{ id: "V1", command: "poetry run pytest -k leak", substituted: { from: "true", why: "x" } }] }, []).contract;
    assert.equal(planted.validate[0].substituted, undefined);
    const plantedSub = applyAmendments({ ...C, validate: [{ id: "V1", command: "poetry run pytest -k leak", substituted: { from: "true", why: "x" } }] }, [{ kind: "substitute-validate", validate: "V1", command: "node --test test/leak.test.js", why: "b" }]).contract;
    assert.equal(plantedSub.validate[0].substituted.from, "poetry run pytest -k leak");
  });
  it("#4990 a substitute whose frozen command names a removed path is rejected", async () => {
    const sub = applyAmendments({ ...C, validate: [{ id: "V1", command: "node --test test/leak.test.js" }] }, [{ kind: "substitute-validate", validate: "V1", command: "node --test test/weak.test.js", why: "w" }]).contract;
    const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    const gone = precheck({ contract: sub, result: res, changedFiles: files, substitutedRuns: { V1: { rc: 1, output: "no tests found" } }, removedPaths: ["test/leak.test.js"] });
    assert.deepEqual(gone.failures.map((f) => f.kind), ["substitute_removed_path"]);
    assert.equal(gone.failures[0].code, "conformance.unimplemented");
    assert.match(gone.failures[0].detail, /test\/leak\.test\.js/);
    const env = precheck({ contract: sub, result: res, changedFiles: files, substitutedRuns: { V1: { rc: 1, output: "Unknown option `-q`" } }, removedPaths: ["docs/other.md"] });
    assert.deepEqual(env.failures, [], "intact named files: env-unrunnable substitute stands");
    assert.deepEqual(removedNamedPaths("node --test ./test/a.js 'b/c.js' z.js", ["test/a.js", "b/c.js", "tests/x.js", "z.js"]), ["test/a.js", "b/c.js", "z.js"]);
    assert.deepEqual(removedNamedPaths("pytest -k leak", ["leak.py"]), []);
    assert.deepEqual(await removedPathsOf(async () => "D\0a.js\0R100\0old.js\0new.js\0M\0m.js\0A\0n.js\0", "b"), ["a.js", "old.js"]);
  });
  it("#5003 removed-path matching: node ids, globs, flag paths, directory tokens, -z, fail closed", async () => {
    assert.deepEqual(removedNamedPaths("pytest tests/a.py::test_x", ["tests/a.py"]), ["tests/a.py"]);
    assert.deepEqual(removedNamedPaths("pytest --junit=tests/a.py", ["tests/a.py"]), ["tests/a.py"]);
    assert.deepEqual(removedNamedPaths('pytest "tests/a.py::T::t"', ["tests/a.py"]), ["tests/a.py"]);
    const base = ["tests/test_a.py", "tests/test_b.py", "tests/fixtures/d.json", "src/x.py"];
    assert.deepEqual(removedNamedPaths("pytest tests/test_*.py", ["tests/test_a.py", "tests/fixtures/d.json", "src/x.py"], base), ["tests/test_a.py"]);
    assert.deepEqual(removedNamedPaths("pytest tests/", ["tests/fixtures/d.json"]), []);
    assert.deepEqual(removedNamedPaths("pytest tests/", ["tests/test_a.py"]), ["tests/test_a.py"]);
    assert.deepEqual(removedNamedPaths("npm test", ["test/fixtures/d.json"]), []);
    assert.deepEqual(removedNamedPaths("npm test", ["test/a.test.js"]), ["test/a.test.js"]);
    assert.deepEqual(await removedPathsOf(async (a) => (a.includes("-z") ? "D\0tests/é.py\0" : '"tests/\\303\\251.py"'), "b"), ["tests/é.py"]);
    assert.equal(await removedPathsOf(async () => { throw new Error("git"); }, "b"), null);
    const sub = applyAmendments({ ...C, validate: [{ id: "V1", command: "node --test test/leak.test.js" }] }, [{ kind: "substitute-validate", validate: "V1", command: "node --test test/weak.test.js", why: "w" }]).contract;
    const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    assert.deepEqual(precheck({ contract: sub, result: res, changedFiles: files, substitutedRuns: { V1: { rc: 1, output: "no tests found" } }, removedPaths: null }).failures.map((f) => f.kind), ["substitute_unverified"]);
  });
  it("#4857 describesUnrunnableCommand reads a blocked summary", () => {
    assert.ok(describesUnrunnableCommand("V2 is unrunnable: poetry found no pyproject at the repo root"));
    assert.ok(!describesUnrunnableCommand("needs a pricing decision from the product owner"));
  });
  it("#4761 vitest -q is a contract problem; a runner usage error is contract.invalid_command, not conformance", () => {
    const bad = { ...C, validate: [{ id: "V1", command: "pnpm --filter x exec vitest run a.test.ts -q" }] };
    assert.ok(validateContract(bad, ISSUE).problems.some((p) => /V1: vitest 3 rejects -q/.test(p)));
    assert.ok(!validateContract({ ...bad, validate: [{ id: "V1", command: "pnpm exec vitest run a.test.ts --reporter=dot" }] }, ISSUE).problems.some((p) => /vitest/.test(p)));
    assert.equal(vitestQuietFlag("pytest -q"), null);
    assert.equal(normalizeRunnerCommand("vitest run a -q && pytest -q"), "vitest run a --reporter=dot && pytest -q");
    assert.ok(cliUsageError({ rc: 1, output: "CACError: Unknown option `-q`" }));
    assert.ok(cliUsageError({ rc: 1, output: "Unrecognized CLI Parameter: --foo" }));
    assert.ok(!cliUsageError({ rc: 1, output: "AssertionError: 1 !== 2" }));
    assert.ok(!cliUsageError({ rc: 0, output: "Unknown option" }));
    const failed = { ...res, validation: [{ id: "V1", exit: 1 }] };
    const pc = precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 1, output: "CACError: Unknown option `-q`" } } });
    assert.deepEqual(codes(pc), ["contract.invalid_command"]);
    assert.equal(pc.failures[0].kind, "validate_command_invalid");
  });
  it("#4323 a failed validate whose rerun could not find a host tool or module is env.tool_missing naming it, not conformance", () => {
    const failed = { ...res, validation: [{ id: "V1", exit: 1 }] };
    const pc = precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 1, output: "Traceback...\nModuleNotFoundError: No module named 'yaml'" } } });
    assert.deepEqual(codes(pc), ["env.tool_missing"]);
    assert.equal(pc.failures[0].kind, "validate_env"); assert.equal(pc.failures[0].tool, "yaml");
    assert.match(pc.failures[0].detail, /could not run: the host is missing Python module 'yaml'/);
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 127, output: "bash: line 1: pytest: command not found" } } })), ["env.tool_missing"]);
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, ciVerified: true, validateRuns: { V1: { rc: 127, output: "bash: pytest: command not found" } } })), [], "CI-verified head: like a validate left to CI");
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 0, output: "" } } })), [], "a passing rerun counts as passed");
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 1, output: "AssertionError: 1 !== 2" } } })), ["conformance.unimplemented"]);
    // #4906: a rerun that timed out (rc 124) is infrastructure, never conformance.unimplemented
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, validateRuns: { V1: { rc: 124, output: "(timed out)" } } })), ["env.validate_timeout"]);
    assert.deepEqual(codes(precheck({ contract: C, result: failed, changedFiles: files, ciVerified: true, validateRuns: { V1: { rc: 124, output: "" } } })), [], "CI-verified head covers a timed-out rerun");
    const local = precheck({ contract: C, result: failed, changedFiles: files, repoHas: repoTracks(["src/leak/__init__.py"]), validateRuns: { V1: { rc: 1, output: "ModuleNotFoundError: No module named 'leak.core'" } } });
    assert.deepEqual(codes(local), ["conformance.unimplemented"], "a repo module the change did not create is a code defect");
  });
  it("#4527 a CI-verified head lists the validate ids it accepted without a local result; a ran-and-failed validate still fails", () => {
    const C2 = { ...C, validate: [{ id: "V1", command: "node --test a.test.mjs" }, { id: "V2", command: "tsc" }, { id: "V3", command: "lint" }] };
    const pc = precheck({ contract: C2, result: { ...res, validation: [{ id: "V2", ci: true }, { id: "V3", exit: 0 }] }, changedFiles: files, ciVerified: true });
    assert.deepEqual(codes(pc), []); assert.deepEqual(pc.ciCovered, ["V1", "V2"]);
    const local = precheck({ contract: C2, result: { ...res, validation: [{ id: "V2", ci: true }, { id: "V3", exit: 0 }] }, changedFiles: files });
    assert.deepEqual(local.failures.map((f) => f.kind), ["validate_missing", "validate_missing"]); assert.deepEqual(local.ciCovered, []);
    const failed = precheck({ contract: C2, result: { ...res, validation: [{ id: "V1", exit: 1 }, { id: "V2", ci: true }, { id: "V3", exit: 0 }] }, changedFiles: files, ciVerified: true });
    assert.deepEqual(failed.failures.map((f) => f.kind), ["validate_failed"]); assert.deepEqual(failed.ciCovered, ["V2"]);
  });
  it("#4708 a validate row carried forward across a CI fix round counts as recorded; a row absent outside a CI-verified head still fails", () => {
    const carried = precheck({ contract: C, result: { ...res, validation: [{ id: "V1", exit: 0, carried: true }] }, changedFiles: files });
    assert.deepEqual(codes(carried), []);
    assert.deepEqual(precheck({ contract: C, result: { ...res, validation: [] }, changedFiles: files }).failures.map((f) => f.kind), ["validate_missing"]);
  });
  it("#4323 missingTool: commands, python and node modules; paths, relative and repo-tracked names are not the environment", () => {
    assert.deepEqual(missingTool({ rc: 127, output: "sh: 1: jq: not found" }), { tool: "jq", kind: "command" });
    assert.deepEqual(missingTool({ rc: 127, output: "" }, { command: "uv run pytest -q" }), { tool: "uv", kind: "command" });
    assert.deepEqual(missingTool({ rc: 1, output: "ImportError: No module named yaml.constructor" }), { tool: "yaml", kind: "python-module" });
    assert.deepEqual(missingTool({ rc: 1, output: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /x/a.mjs" }), { tool: "zod", kind: "node-module" });
    assert.deepEqual(missingTool({ rc: 1, output: "Error: Cannot find module '@scope/pkg/sub'" }), { tool: "@scope/pkg", kind: "node-module" });
    assert.equal(missingTool({ rc: 1, output: "Error: Cannot find module './lib/new.js'" }), null);
    assert.equal(missingTool({ rc: 1, output: "Error: Cannot find module '/repo/src/x.mjs'" }), null);
    assert.equal(missingTool({ rc: 127, output: "bash: ./scripts/check.sh: No such file or directory" }, { command: "./scripts/check.sh" }), null);
    assert.equal(missingTool({ rc: 1, output: "ModuleNotFoundError: No module named 'app'" }, { repoHas: repoTracks(["app.py"]) }), null);
    assert.equal(missingTool({ rc: 1, output: "1 test failed: expected not found" }), null, "rc != 127 needs command not found");
  });
  it("#5371 substituteVerdict treats docker daemon, playwright browser and npm network failures as not runs", () => {
    const sigs = [
      "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "docker: Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: /x/infra",
      "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1/chrome\nRun npx playwright install",
      "npm ERR! code EAI_AGAIN\nnpm ERR! network request to https://registry.npmjs.org/x failed",
      "npm error code ENOTFOUND",
    ];
    for (const output of sigs) {
      assert.equal(substituteVerdict({ rc: 1, output }, { command: "x" }), "ok", output);
      assert.equal(missingTool({ rc: 1, output })?.kind, "environment", output);
    }
    assert.equal(substituteVerdict({ rc: 1, output: "AssertionError: expected 1 to equal 2" }, { command: "x" }), "runs");
  });
  it("#5371 a failed validate detail carries a redacted last-40-line output tail; an env signature is env.tool_missing", () => {
    const C = { requirements: [], validate: [{ id: "V1", command: "bash t.sh" }], deliverables: [{ id: "D1", path: "a.mjs", change: "x" }] };
    const failed = { validation: [{ id: "V1", exit: 1 }], requirements: [] };
    const out = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\n") + "\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\nAuthorization: Bearer abcdefghijklmnop1234";
    const pc = precheck({ contract: C, result: failed, changedFiles: ["a.mjs"], validateRuns: { V1: { rc: 1, output: out } } });
    const d = pc.failures.find((f) => f.kind === "validate_failed").detail;
    assert.match(d, /line59/); assert.doesNotMatch(d, /line5\b/); assert.doesNotMatch(d, /ghp_abcdef|abcdefghijklmnop1234/); assert.match(d, /\[redacted\]/);
    const env = precheck({ contract: C, result: failed, changedFiles: ["a.mjs"], validateRuns: { V1: { rc: 1, output: "Cannot connect to the Docker daemon" } } });
    assert.deepEqual(env.failures.map((f) => f.code), ["env.tool_missing"]); assert.match(env.failures[0].detail, /Cannot connect/);
    assert.equal(outputTail(""), "");
  });
  it("#5005 a missing forgedock install is env.tool_missing, not conformance; other absolute paths stay code defects", () => {
    const out = "node:internal/modules/cjs/loader\nError: Cannot find module '/opt/node/lib/node_modules/forgedock/bin/lean/checks.mjs'\n code: 'MODULE_NOT_FOUND'";
    assert.deepEqual(missingTool({ rc: 1, output: out }), { tool: "forgedock", kind: "command" });
    assert.equal(missingTool({ rc: 1, output: "Error: Cannot find module '/repo/forgedock/src/x.mjs'" }), null);
    const contract = { requirements: [], deliverables: [], validate: [{ id: "V2", command: "node /opt/node/lib/node_modules/forgedock/bin/lean/checks.mjs --base origin/staging" }] };
    const result = { validation: [{ id: "V2", command: "", exit: 1 }] };
    const pc = precheck({ contract, result, changedFiles: [], validateRuns: { V2: { rc: 1, output: out } } });
    assert.deepEqual(pc.failures.map((f) => f.code), ["env.tool_missing"]);
  });
  it("#5005 resolveForgedockPaths rewrites a missing forgedock entry point to this install, leaves an existing one", () => {
    const o = { checksCli: "/h/forgedock/bin/lean/checks.mjs", forgedockCli: "/h/forgedock/bin/forgedock.mjs" };
    const cmd = "node /opt/node/lib/node_modules/forgedock/bin/lean/checks.mjs --base origin/staging && node /opt/node/lib/node_modules/forgedock/bin/forgedock.mjs check";
    assert.equal(resolveForgedockPaths(cmd, { ...o, exists: () => false }), "node /h/forgedock/bin/lean/checks.mjs --base origin/staging && node /h/forgedock/bin/forgedock.mjs check");
    assert.equal(resolveForgedockPaths(cmd, { ...o, exists: () => true }), cmd);
    assert.equal(resolveForgedockPaths("node bin/x.mjs", { ...o, exists: () => false }), "node bin/x.mjs");
  });
  it("a deliver requirement reported deferred without an amendment -> untracked_deferral; partial -> unimplemented", () => {
    const r = { ...res, requirements: [{ id: "R1", status: "deferred" }, { id: "R2", status: "partial" }] };
    assert.deepEqual(codes(precheck({ contract: C, result: r, changedFiles: files })), ["conformance.untracked_deferral", "conformance.unimplemented"]);
  });
  it("a typed deferral is not a precheck failure: the reviewer judges it, then it is filed", () => {
    const k = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w" }] };
    assert.equal(precheck({ contract: k, result: res, changedFiles: files }).ok, true);
  });
  it("deliverables may be directories or globs; changelogs and lockfiles are always allowed", () => {
    const k = { ...C, deliverables: [{ id: "D1", path: "src/" }, { id: "D2", path: "./lib/**/*.go" }] };
    assert.equal(precheck({ contract: k, result: res, changedFiles: ["src/a/b.js", "lib/x/y/z.go", "CHANGELOG.md", "web/package-lock.json", "go.sum"] }).ok, true);
    assert.deepEqual(codes(precheck({ contract: k, result: res, changedFiles: ["lib/x.py"] })), ["conformance.scope_creep"]);
  });
});

describe("conformance review: the engine computes the verdict from complete rows", () => {
  it("complete conforming rows conform", () => assert.equal(decide(good, ctx).state, "conforms"));
  it("a generic PASS (the old two-question reply) is incomplete, never conforming", () => {
    const d = decide({ verdict: "PASS", fixes_issue: true, regression: false, reason: "looks good" }, ctx);
    assert.equal(d.state, "review.incomplete");
    assert.ok(d.failures.every((f) => f.code === "review.incomplete"));
  });
  it("no JSON is unparseable", () => { assert.equal(parseReview("LGTM"), null); assert.equal(decide(null, ctx).state, "review.unparseable"); });
  it("incomplete: a missing requirement row (only the reviewer can judge it), and missing lists that id for the re-ask", () => {
    const d = decide({ ...good, requirements: good.requirements.slice(1) }, ctx);
    assert.equal(d.state, "review.incomplete"); assert.deepEqual(d.missing, ["R1"]);
  });
  it("#4160 missing scope and preserve rows are filled by the engine: complete, with the honest verdict", () => {
    assert.equal(decide({ ...good, scope: good.scope.slice(1) }, ctx).state, "conforms", "an authorized file needs no reviewer row");
    const creep = decide({ ...good }, { ...ctx, changedFiles: [...files, "src/pricing.js"] });
    assert.deepEqual(codes(creep), ["conformance.scope_creep"], "an unauthorized file without a row is still creep");
    const noPres = decide({ ...good, preserve: [] }, ctx);
    assert.deepEqual(codes(noPres), ["conformance.preserve_violated"], "a missing preserve row is unverified, not incomplete");
    assert.match(noPres.failures[0].detail, /P1 unverified/);
    assert.equal(decide({ ...good, scope: undefined, preserve: undefined }, ctx).state, "nonconforming");
  });
  it("#4160 basename and wrapped evidence are normalized to the repo path; an ambiguous or unknown name is still incomplete", () => {
    assert.equal(decide(row("R1", { evidence: "scrape.js:7" }), ctx).state, "conforms");
    assert.equal(decide(row("R1", { evidence: "see `src/scrape.js:7` (guard)" }), ctx).state, "conforms");
    assert.equal(decide(row("R1", { evidence: "billing.js:1" }), { ...ctx, repoFiles: ["src/billing.js"], pathExists: (p) => p === "src/billing.js" }).state, "conforms");
    assert.equal(decide(row("R1", { evidence: "nope.js:3" }), ctx).state, "review.incomplete");
    assert.equal(normalizeEvidencePath("route.ts", { changedFiles: ["app/a/route.ts", "app/b/route.ts"] }), "route.ts", "ambiguous stays as is");
    assert.equal(normalizeEvidencePath("b/route.ts", { changedFiles: ["app/a/route.ts", "app/b/route.ts"] }), "app/b/route.ts");
    assert.equal(decide(row("R1", { evidence: "scrape.js:7" }), ctx).review.requirements[0].evidence, "src/scrape.js:7");
  });
  it("#4327 evidence paths with route-group, dynamic and catch-all segments are kept verbatim", () => {
    const repo = ["apps/admin/app/(console)/layout.tsx", "apps/web/app/blog/[slug]/page.tsx", "apps/web/app/docs/[...slug]/page.tsx"];
    const c = { ...ctx, repoFiles: repo, pathExists: (p) => repo.includes(p) };
    for (const [ev, want] of [
      ["`(console)/layout.tsx:12` + nav (sidebar)", "apps/admin/app/(console)/layout.tsx:12"],
      ["`apps/admin/app/(console)/layout.tsx`:12", "apps/admin/app/(console)/layout.tsx:12"],
      ["see apps/web/app/blog/[slug]/page.tsx:4", "apps/web/app/blog/[slug]/page.tsx:4"],
      ["(apps/web/app/docs/[...slug]/page.tsx:9)", "apps/web/app/docs/[...slug]/page.tsx:9"],
      ["[page](apps/web/app/docs/[...slug]/page.tsx:9)", "apps/web/app/docs/[...slug]/page.tsx:9"],
    ]) {
      const d = decide(row("R1", { evidence: ev }), c);
      assert.equal(d.state, "conforms", ev); assert.equal(d.review.requirements[0].evidence, want, ev);
    }
    assert.deepEqual(evidencePathLine("(src/scrape.js:7), fixed"), { path: "src/scrape.js", line: "7" });
  });
  it("#4327 a missing route-group path is still missing; only path problems qualify for the extra re-ask", () => {
    const c = { ...ctx, repoFiles: ["apps/admin/app/(console)/layout.tsx"], pathExists: (p) => p === "apps/admin/app/(console)/layout.tsx" };
    const d = decide(row("R1", { evidence: "`apps/admin/app/(admin)/layout.tsx:12`" }), c);
    assert.equal(d.state, "review.incomplete"); assert.deepEqual(d.missing, ["R1"]);
    assert.match(d.failures[0].detail, /evidence path apps\/admin\/app\/\(admin\)\/layout\.tsx does not exist/);
    assert.equal(evidencePathOnly(d.failures.map((f) => f.detail)), true);
    assert.equal(evidencePathOnly(decide({ verdict: "PASS" }, ctx).failures.map((f) => f.detail)), false);
    assert.equal(evidencePathOnly([]), false);
  });
  it("#4160 a targeted re-ask merges by id: the repair rows complete the first reply", () => {
    const first = { ...good, requirements: [good.requirements[1]], preserve: [] };
    const d1 = decide(first, ctx);
    assert.equal(d1.state, "review.incomplete"); assert.deepEqual(d1.missing, ["R1"]);
    const merged = mergeReviewRows(first, { requirements: [good.requirements[0]], preserve: good.preserve });
    assert.equal(decide(merged, ctx).state, "conforms");
    assert.equal(mergeReviewRows(first, null), first, "an unparseable repair keeps the first reply");
    assert.equal(decide(mergeReviewRows({ ...good, verdict: "NONCONFORMING" }, { verdict: "CONFORMS" }), ctx).state, "conforms");
  });
  it("#4160 the skeleton has one row per requirement, preserve id and changed file, scope pre-filled by the engine", () => {
    const s = reviewSkeleton(C, [...files, ".forge-lean/x", "src/pricing.js"], [".forge-lean/"]);
    assert.deepEqual(s.requirements.map((r) => r.id), ["R1", "R2"]);
    assert.deepEqual(s.preserve.map((r) => r.id), ["P1"]);
    assert.deepEqual(s.scope.map((r) => [r.file, r.authorized_by]), [["src/scrape.js", "D1"], ["src/search.js", "D2"], ["test/leak.test.js", "test"], ["src/pricing.js", "none"]]);
    assert.deepEqual(s.issue_coverage.map((r) => r.quote), [Q1, Q2]);
    assert.ok(s.requirements.every((r) => r.status === ""), "requirement status is left for the reviewer");
    assert.ok(s.preserve.every((r) => r.status === "unverified"), "preserve starts unverified");
  });
  it("#4160 missingIds lists only what a targeted re-ask must fill", () => {
    assert.deepEqual(missingIds(good, ctx), []);
    assert.deepEqual(missingIds({ ...good, requirements: [good.requirements[1]], preserve: [], scope: [] }, ctx), ["R1"], "engine-filled preserve/scope rows are not asked for");
    assert.deepEqual(missingIds({ ...good, issue_coverage: [] }, ctx), ["issue_coverage"]);
    assert.equal(normalizeEvidencePath("billing.js", { listed: new Set(["src/billing.js"]) }), "src/billing.js", "listed is the repo file list");
  });
  it("#4160 checkCompleteness on the raw reply still lists a missing scope row for an unauthorized changed file (decide fills it as creep)", () => {
    const extra = { ...ctx, changedFiles: [...files, "src/billing.js"] };
    assert.equal(checkCompleteness(good, extra).problems.includes("changed file src/billing.js has no scope row"), true);
  });
  it("#4160: a changed file the contract already authorizes (deliverable, test, incidental) needs no scope row", () => {
    assert.equal(decide({ ...good, scope: [] }, ctx).state, "conforms");
    assert.equal(checkCompleteness({ ...good, scope: [] }, { ...ctx, changedFiles: [...files, "CHANGELOG.md"] }).complete, true);
  });
  it("#4160: a scope row the reviewer gives for an authorized file is still judged (none on a deliverable is creep)", () => {
    const s = good.scope.map((x) => (x.file === "src/scrape.js" ? { ...x, authorized_by: "none", note: "unrelated rewrite" } : x));
    assert.equal(decide({ ...good, scope: s }, ctx).state, "nonconforming");
  });
  it("#4160: evidence given as a bare or partial file name resolves to the one changed file it names", () => {
    assert.equal(resolveEvidencePath("scrape.js", files), "src/scrape.js");
    assert.equal(resolveEvidencePath("./src/scrape.js", files), "src/scrape.js");
    assert.equal(resolveEvidencePath("leak.test.js", files), "test/leak.test.js");
    assert.equal(resolveEvidencePath("x.js", ["a/x.js", "b/x.js"]), null, "ambiguous");
    assert.equal(resolveEvidencePath("nope.js", files), null);
    assert.equal(decide(row("R1", { evidence: "scrape.js:4" }), ctx).state, "conforms");
  });
  it("a validate command that diffs against the moving origin/<lane> tip invalidates the contract; a merge-base diff does not", () => {
    const withV = (command) => ({ ...C, validate: [{ id: "V4", command }] });
    const bad = validateContract(withV("./scripts/sync.sh --check-only && git diff --quiet origin/staging -- infra/a infra/b"), ISSUE);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((x) => /^V4: `git diff` against the moving origin\/staging tip/.test(x) && x.includes("origin/staging...HEAD")), bad.problems.join("; "));
    for (const ok of ["git diff --quiet origin/staging...HEAD -- infra/a", "git diff --quiet $(git merge-base HEAD origin/staging) -- infra/a", "node --test test/leak.test.js", "git log origin/staging..HEAD --oneline"]) {
      assert.equal(validateContract(withV(ok), ISSUE).ok, true, ok);
    }
  });
  it("movingBaseDiff finds the remote ref in any git diff segment, and ignores merge-base forms and other commands", () => {
    assert.equal(movingBaseDiff("git diff --name-only origin/main HEAD"), "origin/main");
    assert.equal(movingBaseDiff("git -C sub diff origin/milestone/foo | wc -l"), "origin/milestone/foo");
    assert.equal(movingBaseDiff("git diff HEAD~1"), null);
    assert.equal(movingBaseDiff(""), null);
  });
  it("#4325 a validate or repro_test command reading a $TMPDIR file it does not create is rejected at freeze", () => {
    const bad = validateContract({ ...C, validate: [{ id: "V4", command: "uv run --with-requirements $TMPDIR/api-req.txt pytest tests/x.py" }] }, ISSUE);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((x) => x.startsWith("V4: reads $TMPDIR/api-req.txt")), bad.problems.join("; "));
    const rt = validateContract({ ...C, repro_test: { path: "t/x.py", command: "pytest -r ${TMPDIR}/req.txt t/x.py" } }, ISSUE, { repro: true });
    assert.ok(rt.problems.some((x) => x.startsWith("repro_test: reads $TMPDIR/req.txt")), rt.problems.join("; "));
    for (const ok of ["uv export > $TMPDIR/r.txt && uv run --with-requirements $TMPDIR/r.txt pytest", "pytest --basetemp=$TMPDIR/pt --junitxml $TMPDIR/j.xml", "mkdir -p \"$TMPDIR/d\" && cp a $TMPDIR/d/a && cat $TMPDIR/d/a", "X=$TMPDIR/cache npm test", "echo hi | tee $TMPDIR/l; grep hi $TMPDIR/l", "node --test test/leak.test.js"]) {
      assert.equal(validateContract({ ...C, validate: [{ id: "V4", command: ok }] }, ISSUE).ok, true, ok);
    }
  });
  it("#5234 project-dir paths and pytest exit 4", () => {
    const poetry = "poetry -C services/api run pytest -q services/api/tests/test_x.py services/api/tests/test_y.py";
    assert.deepEqual(projectDirPathMiss(poetry), { dir: "services/api", paths: ["services/api/tests/test_x.py", "services/api/tests/test_y.py"] });
    assert.equal(rewriteProjectDirCommand(poetry), "cd services/api && poetry run pytest -q tests/test_x.py tests/test_y.py");
    const uv = "uv run --project services/api pytest services/api/tests/x.py -k foo";
    assert.equal(rewriteProjectDirCommand(uv), "cd services/api && uv run pytest tests/x.py -k foo");
    assert.equal(rewriteProjectDirCommand("poetry --directory=./services/api run pytest services/api/tests/x.py"), "cd services/api && poetry run pytest tests/x.py");
    const mixed = "poetry -C services/api run pytest services/api/tests/x.py tests/hands_conformance";
    assert.equal(rewriteProjectDirCommand(mixed), mixed);
    const chained = "poetry -C services/api run pytest services/api/tests/x.py && echo ok";
    assert.equal(rewriteProjectDirCommand(chained), chained);
    for (const fine of ["cd services/api && poetry run pytest ../../services/api/tests/x.py", "poetry -C services/api run pytest tests/x.py", "poetry run pytest services/api/tests/x.py"]) {
      assert.equal(projectDirPathMiss(fine), null, fine);
      assert.equal(rewriteProjectDirCommand(fine), fine);
    }
    for (const cmd of [poetry, uv, mixed]) {
      const v = validateContract({ ...C, validate: [{ id: "V1", command: cmd }] }, ISSUE);
      assert.ok(v.problems.some((x) => x.startsWith("V1: the command moves its cwd to `services/api`")), v.problems.join("; "));
    }
    const rt = validateContract({ ...C, repro_test: { path: "t/x.py", command: uv } }, ISSUE, { repro: true });
    assert.ok(rt.problems.some((x) => x.startsWith("repro_test: the command moves its cwd")), rt.problems.join("; "));
    // pytest exit 4 is a defect of the frozen command: contract.invalid_command, and a substitute is judged ok
    const exit4 = { rc: 4, output: "ERROR: file or directory not found: services/api/tests/x.py\n\nno tests ran in 0.01s" };
    assert.ok(unrunnableValidate({ rc: 4, output: "ERROR: file or directory not found: services/api/tests/x.py" }));
    assert.ok(unrunnableValidate({ rc: 4, output: "ERROR: not found: /repo/tests/x.py::t" }));
    assert.ok(!unrunnableValidate({ rc: 1, output: "1 failed, 2 passed" }));
    // exit 4 or 5 of a pytest command is unrunnable whatever the output says; other runners and test failures are not
    for (const rc of [4, 5]) assert.ok(unrunnableValidate({ rc, output: "" }, "poetry run pytest -q tests/x.py"), `rc ${rc}`);
    assert.ok(!unrunnableValidate({ rc: 4, output: "" }, "node --test x.mjs"));
    assert.ok(!unrunnableValidate({ rc: 1, output: "1 failed" }, "pytest tests/x.py"));
    assert.equal(substituteVerdict({ rc: 4, output: "" }, { command: poetry }), "ok");
    assert.equal(substituteVerdict({ rc: 1, output: "1 failed" }, { command: poetry }), "runs");
    assert.equal(substituteVerdict(exit4), "ok");
    const contract = { requirements: [], deliverables: [], validate: [{ id: "V1", command: poetry }] };
    const p = precheck({ contract, result: { validation: [{ id: "V1", exit: 4 }] }, changedFiles: [], validateRuns: { V1: exit4 } });
    assert.deepEqual(p.failures.map((f) => [f.code, f.kind]), [["contract.invalid_command", "validate_command_invalid"]]);
  });
  it("#5232 a guessed offline uv --with environment is rejected for repro_test and validate; a requirements export passes", () => {
    const bad = "cd w && uv run --offline --no-project --with pytest --with structlog python -m pytest -q t.py";
    assert.equal(guessedUvEnv(bad), true);
    assert.equal(guessedUvEnv("uv run --no-project --python 3.12 --with-requirements r.txt pytest -q t.py"), false);
    assert.equal(guessedUvEnv("uv run --offline --no-project --with-requirements r.txt pytest"), false);
    assert.equal(guessedUvEnv("pnpm vitest run x"), false);
    const rt = validateContract({ ...C, repro_test: { path: "t/x.py", command: bad } }, ISSUE, { repro: true });
    assert.ok(rt.problems.some((x) => x.startsWith("repro_test: the command builds its environment from a hand-picked")), rt.problems.join("; "));
    const v = validateContract({ ...C, validate: [{ id: "V1", command: bad }] }, ISSUE);
    assert.ok(v.problems.some((x) => x.startsWith("V1: the command builds its environment")), v.problems.join("; "));
    const ok = validateContract({ ...C, repro_test: { path: "t/x.py", command: "uv run --no-project --with-requirements r.txt pytest t/x.py" } }, ISSUE, { repro: true });
    assert.ok(!ok.problems.some((x) => /hand-picked/.test(x)));
  });

  it("#5230 tmpdirInputs counts venv, clone and worktree dirs as created", () => {
    assert.deepEqual(tmpdirInputs('uv venv -q "$TMPDIR/pv" && uv pip install --offline -q --python "$TMPDIR/pv/bin/python" pytest && "$TMPDIR/pv/bin/python" -m pytest -q x'), []);
    assert.deepEqual(tmpdirInputs("python3 -m venv $TMPDIR/v && $TMPDIR/v/bin/pip install x"), []);
    assert.deepEqual(tmpdirInputs("virtualenv $TMPDIR/v && $TMPDIR/v/bin/pip install x"), []);
    assert.deepEqual(tmpdirInputs("git clone https://x/y.git $TMPDIR/c && cat $TMPDIR/c/f"), []);
    assert.deepEqual(tmpdirInputs("git worktree add $TMPDIR/w && cat $TMPDIR/w/f"), []);
    assert.deepEqual(tmpdirInputs('uv pip install --python "$TMPDIR/pv/bin/python" pytest'), ["$TMPDIR/pv/bin/python"]);
  });
  it("#4325 tmpdirInputs lists read-before-create $TMPDIR paths once, in first-use order", () => {
    assert.deepEqual(tmpdirInputs("cat ${TMPDIR:-/tmp}/a.json | jq . && cp $TMPDIR/b.txt out && cat $TMPDIR/a.json"), ["$TMPDIR/a.json", "$TMPDIR/b.txt"]);
    assert.deepEqual(tmpdirInputs("cp src.txt $TMPDIR/b.txt && cat $TMPDIR/b.txt"), []);
    assert.deepEqual(tmpdirInputs(""), []);
  });
  it("#4160: reviewSkeleton (object form) lists every required row, scope rows pre-filled with the engine's authorization", () => {
    const k = { ...C, requirements: [...C.requirements, { id: "R9", quote: "Billing pricing is unchanged.", disposition: "defer", why: "w" }] };
    const sk = reviewSkeleton({ contract: k, changedFiles: [...files, "src/billing.js", ".forge-lean/x"], ignore: [".forge-lean/"] });
    assert.deepEqual(sk.requirements.map((r) => r.id), k.requirements.map((r) => r.id));
    assert.equal(sk.requirements.find((r) => r.id === "R9").deferral_ok, null);
    assert.ok(!("deferral_ok" in sk.requirements[0]));
    assert.deepEqual(sk.preserve.map((p) => p.id), (k.preserve ?? []).map((p) => p.id));
    assert.deepEqual(sk.scope.map((s) => [s.file, s.authorized_by]), [...files.map((f) => [f, f.startsWith("test/") ? "test" : f === "src/scrape.js" ? "D1" : "D2"]), ["src/billing.js", "none"]]);
    assert.deepEqual(sk.issue_coverage.map((c) => c.quote), k.requirements.map((r) => r.quote));
    assert.ok(sk.issue_coverage.every((c) => inIssue(c.quote, ISSUE)), "seeded quotes pass the verbatim check");
    assert.ok([...sk.requirements, ...sk.issue_coverage].every((r) => r.status === ""), "no requirement or coverage status is pre-judged");
    assert.ok(sk.preserve.every((p) => p.status === "unverified"), "preserve starts unverified");
  });
  it("incomplete: implemented without path:line, with evidence in a nonexistent file, or without validation", () => {
    assert.equal(decide(row("R1", { evidence: "looks fine" }), ctx).state, "review.incomplete");
    assert.equal(decide(row("R1", { evidence: "src/nope.js:3" }), ctx).state, "review.incomplete");
    assert.equal(decide(row("R1", { evidence: "src/billing.js:1" }), ctx).state, "conforms", "an existing unchanged file is valid evidence");
    assert.equal(decide(row("R1", { validated_by: "none" }), ctx).state, "review.incomplete");
  });
  it("incomplete: a coverage quote paraphrased instead of verbatim", () => {
    assert.equal(decide({ ...good, issue_coverage: [{ quote: "scrape should release money on rate limits", status: "covered" }] }, ctx).state, "review.incomplete");
  });
  it("#5164 a near-verbatim coverage misquote is requoted to the criterion line and the review completes", () => {
    const issue = "## Acceptance Criteria\n- [ ] Every manifest step kind from #38826 compiles to engine nodes, with a test per kind.\n- [ ] The scrape route must release the spend reservation on 429.";
    const k = { ...C, requirements: [{ id: "R1", quote: "The scrape route must release the spend reservation on 429.", disposition: "deliver" }, { id: "R2", quote: Q2, disposition: "deliver" }] };
    const quote = "Every manifest step kind from #38829 compiles to engine node";
    const rv = { ...good, issue_coverage: [{ quote, contract_ids: ["R1"], status: "covered" }, { quote: "The scrape route must release the spend reservation on 429.", status: "covered" }] };
    const d = decide(rv, { ...ctx, contract: k, issueText: `${issue}\n${ISSUE}` });
    assert.equal(d.state, "conforms");
    assert.equal(d.review.issue_coverage[0].quote, "Every manifest step kind from #38826 compiles to engine nodes, with a test per kind.");
    assert.equal(d.review.issue_coverage[0].requoted, quote, "the substitution is recorded in the review");
  });
  it("#5164 matchCriterion: loose prefix or a unique token match; a paraphrase, an ambiguous or a short quote matches nothing", () => {
    const t = "- [ ] Every manifest step kind from #38826 compiles to engine nodes, with a test per kind.\n- The scrape route must release the spend reservation on 429.\n- The search route must release the spend reservation on 429.";
    assert.deepEqual(criterionLines(t)[0], "Every manifest step kind from #38826 compiles to engine nodes, with a test per kind.");
    assert.equal(matchCriterion("every manifest step kind from #1 compiles to engine node with a test per kinds", t), criterionLines(t)[0], "prefix tier");
    assert.equal(matchCriterion("The scrape route must release the spend reservations on 429", t), "The scrape route must release the spend reservation on 429.");
    assert.equal(matchCriterion("route must release the spend reservation", t), null, "two lines tie");
    assert.equal(matchCriterion("scrape should release money on rate limits", t), null);
    assert.equal(matchCriterion("engine node", t), null);
  });
  it("#5164 a quote that matches no criterion still fails as incomplete, naming the nearest criterion line; it is re-askable, a real gap is not", () => {
    const d = decide({ ...good, issue_coverage: [{ quote: "scrape should release money on rate limits", status: "covered" }] }, ctx);
    assert.equal(d.state, "review.incomplete");
    assert.equal(d.review.issue_coverage[0].requoted, undefined);
    const problems = d.failures.map((f) => f.detail);
    assert.match(problems[0], /nearest criterion line: "The scrape route must release/);
    assert.ok(reaskable(problems));
    assert.ok(reaskable(["R1: evidence path /layout.tsx does not exist"]), "#4327 evidence paths stay re-askable");
    assert.ok(reaskable([...problems, "requirement R1 needs exactly one row (has 0)"]), "#5345 a missing row is repaired in place");
    assert.ok(reaskable(["issue_coverage is missing or empty"]));
    assert.ok(!reaskable(["requirements rows are missing"]), "a whole absent section keeps the two-run limit");
    assert.ok(!reaskable([...problems, "something else is wrong"]));
    assert.ok(!reaskable([]));
    assert.deepEqual(fillEngineRows(good, ctx).issue_coverage, good.issue_coverage, "verbatim rows are untouched");
  });
  it("omission: an issue requirement missing from or narrowed by the contract", () => {
    const d = decide({ ...good, issue_coverage: [...good.issue_coverage.slice(0, 2), { quote: "Billing pricing is unchanged.", status: "missing" }] }, ctx);
    assert.deepEqual(codes(d), ["conformance.omission"]);
  });
  it("contract mismatch: a deliver requirement partial or missing in the diff", () => {
    assert.deepEqual(codes(decide(row("R2", { status: "missing", evidence: "src/search.js:5" }), ctx)), ["conformance.unimplemented"]);
    assert.deepEqual(codes(decide(row("R2", { status: "deferred" }), ctx)), ["conformance.untracked_deferral"]);
  });
  it("scope creep, preserve violated or unverified, and regressions fail", () => {
    assert.deepEqual(codes(decide({ ...good, scope: [{ ...good.scope[0], authorized_by: "none", note: "rewrites pricing inside scrape.js" }, ...good.scope.slice(1)] }, ctx)), ["conformance.scope_creep"]);
    assert.equal(decide({ ...good, scope: [...good.scope.slice(0, 2), { file: "test/leak.test.js", authorized_by: "none" }] }, ctx).state, "conforms", "a reviewer 'none' on a test file is a misreading, not creep");
    assert.deepEqual(codes(decide({ ...good, preserve: [{ id: "P1", status: "violated", evidence: "src/billing.js:1" }] }, ctx)), ["conformance.preserve_violated"]);
    assert.deepEqual(codes(decide({ ...good, preserve: [{ id: "P1", status: "unverified" }] }, ctx)), ["conformance.preserve_violated"]);
    assert.deepEqual(codes(decide({ ...good, regressions: [{ at: "src/x.js:3", failure: "caller passes null" }] }, ctx)), ["conformance.regression"]);
  });
  it("CONFORMS with a failing row is nonconforming and flagged inconsistent; NONCONFORMING with no failing row is re-asked (review.inconsistent)", () => {
    const d = decide(row("R1", { status: "partial" }), ctx);
    assert.equal(d.state, "nonconforming"); assert.equal(d.inconsistent, true);
    const i = decide({ ...good, verdict: "NONCONFORMING" }, ctx);
    assert.equal(i.state, "review.inconsistent"); assert.deepEqual(codes(i), ["review.inconsistent"]);
  });
  it("a deferred requirement needs the reviewer's deferral_ok; false is an unjustified deferral", () => {
    const k = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w", bucket: "owner:rotate the key" }] };
    const c2 = { ...ctx, contract: k };
    const rv = (extra) => ({ ...good, requirements: [good.requirements[0], { id: "R2", status: "deferred", ...extra }] });
    assert.equal(decide(rv({}), c2).state, "review.incomplete");
    assert.equal(decide(rv({ deferral_ok: true }), c2).state, "conforms");
    assert.deepEqual(codes(decide(rv({ deferral_ok: false, note: "two lines in the same file" }), c2)), ["conformance.unjustified_deferral"]);
  });
  it("#5207 an in-lane engineering deferral (new-issue or unbucketed) is never accepted, whatever deferral_ok says, and is never filed", () => {
    const rv = (extra) => ({ ...good, requirements: [good.requirements[0], { id: "R2", status: "deferred", ...extra }] });
    for (const bucket of ["new-issue", undefined]) {
      const c2 = { ...ctx, contract: { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w", ...(bucket ? { bucket } : {}) }] } };
      for (const ok of [true, false]) {
        const d = decide(rv({ deferral_ok: ok }), c2);
        assert.deepEqual(codes(d), ["conformance.unjustified_deferral"], `${bucket} ${ok}`); // one per row, no duplicate
        assert.match(d.failures[0].detail, new RegExp(`^R2 is in-lane engineering work \\(bucket ${bucket ?? "none"}\\): deliver it .*\\(#5207\\)$`));
      }
      assert.deepEqual(pendingTracking(c2.contract).map((r) => r.id), [], "never filed");
      assert.ok(inLaneDeferral(c2.contract.requirements[1]));
    }
    for (const r of [{ disposition: "defer", bucket: "owner:spend" }, { disposition: "defer", bucket: "host" }, { disposition: "post-deploy", bucket: "post-deploy" }, { disposition: "defer", class: "ops" }, { disposition: "deliver" }]) assert.equal(inLaneDeferral(r), false, JSON.stringify(r));
    assert.deepEqual(pendingTracking({ requirements: [{ id: "R1", disposition: "defer", bucket: "owner:spend" }, { id: "R2", disposition: "defer", bucket: "new-issue" }] }).map((r) => r.id), ["R1"]);
  });
  it("short quotes are accepted only as a whole issue line or list item", () => {
    const t = "Do this:\n- [ ] add --dry-run\n2. keep -v";
    assert.ok(inIssue("add --dry-run", t)); assert.ok(inIssue("keep -v", t)); assert.ok(!inIssue("dry-run", t)); assert.ok(!inIssue("do", t));
  });
  it("add-requirement quotes are checked against the issue; an oversized contract is invalid", () => {
    assert.equal(applyAmendments(C, [{ kind: "add-requirement", requirement: { id: "R9", quote: "something nobody asked for at all", disposition: "defer" }, why: "w" }], ISSUE).problems.length, 1);
    assert.equal(applyAmendments(C, [{ kind: "add-requirement", requirement: { id: "R9", quote: "Billing pricing is unchanged." }, why: "w" }], ISSUE).problems.length, 0);
    assert.match(validateContract({ ...C, deliverables: [...C.deliverables, { id: "DX", path: "x".repeat(41000) }] }, ISSUE).problems.join(), /over 40000 characters/);
  });
  it("checkCompleteness lists every problem", () => assert.ok(checkCompleteness({}, ctx).problems.length >= 5));
});

describe("close plan and follow-up items", () => {
  it("#5285: a live default-on change with live acceptance deferred closes partial and names the blocker", () => {
    const k = { requirements: [{ id: "R3", disposition: "defer", bucket: "post-deploy" }] };
    const p = closePlan(k, { liveBlocks: [{ id: "R3", flag: "pool" }] });
    assert.equal(p.reason, "partial");
    assert.equal(p.liveBlocked, true);
    assert.deepEqual(p.open.map((r) => r.id), ["R3"]);
    assert.equal(closePlan(k).reason, "completed");
  });
  it("#5382: a default-on live-blocked lane still transfers its e2e/manual post-deploy rows to the epic", () => {
    const k = { requirements: [{ id: "R3", disposition: "defer", bucket: "post-deploy" }, { id: "R4", quote: "[type:e2e] checkout works", disposition: "post-deploy" }] };
    const p = closePlan(k, { liveBlocks: [{ id: "R3", flag: "pool" }] });
    assert.equal(p.liveBlocked, true);
    assert.equal(p.transferred, true);
    assert.deepEqual(p.transfer.map((r) => r.id), ["R4"]);
    assert.deepEqual(p.open.map((r) => r.id), ["R3"]);
    assert.equal(closePlan({ requirements: [k.requirements[0]] }, { liveBlocks: [{ id: "R3", flag: "pool" }] }).transferred, undefined);
  });
  it("#5285: interactive UI on a high-risk surface with no browser check fails precheck; with one, or off a risk surface, it passes", () => {
    const k = { requirements: [{ id: "R1", disposition: "deliver" }], deliverables: [{ id: "D1", path: "web/Cta.tsx" }] };
    const res = { requirements: [{ id: "R1", status: "implemented" }], validation: [] };
    const run = (uiBrowser) => precheck({ contract: k, result: res, changedFiles: ["web/Cta.tsx"], uiBrowser }).failures.filter((f) => f.kind === "ui_browser_unverified");
    assert.equal(run({ files: ["web/Cta.tsx"], ran: false, highRisk: true, reason: "no e2e_label or e2e_workflow configured" }).length, 1);
    assert.equal(run({ files: ["web/Cta.tsx"], ran: true, highRisk: true, reason: "x" }).length, 0);
    assert.equal(run({ files: ["web/Cta.tsx"], ran: false, highRisk: false, reason: "x" }).length, 0);
  });
  it("links every tracking issue once; nothing tracked when everything is delivered", () => {
    assert.deepEqual(closePlan(C), { reason: "completed", tracked: [] });
    const k = { requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "defer", tracked: "#9" }, { id: "R3", disposition: "post-deploy", tracked: "#9" }] };
    assert.deepEqual(closePlan(k).tracked, ["#9"]);
  });
  it("#4398 isInvestigation reads the investigate( / investigate: title type only", () => {
    for (const t of ["investigate(stealth): which signal", "Investigate: why", "  investigate(x)"]) assert.equal(isInvestigation(t), true, t);
    for (const t of ["fix(investigate): x", "feat: investigate later", "investigation(x)", "", null]) assert.equal(isInvestigation(t), false, String(t));
  });
  it("#4398 an investigation closes partial when a requirement is deferred or its answer is not implemented; otherwise completed", () => {
    const title = "investigate(stealth): which device signal is rejected";
    const k = { requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "defer", tracked: "#9" }, { id: "R3", disposition: "not-applicable" }] };
    const p = closePlan(k, { title });
    assert.equal(p.reason, "partial"); assert.deepEqual(p.open.map((r) => r.id), ["R2"]); assert.deepEqual(p.tracked, ["#9"]);
    assert.deepEqual(closePlan(k, { title: "fix: foo" }), { reason: "completed", tracked: ["#9"] }, "only investigations change");
    const d = { requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "deliver" }] };
    const rows = (s1, s2) => ({ requirements: [{ id: "R1", status: s1 }, { id: "R2", status: s2 }] });
    assert.deepEqual(closePlan(d, { title, review: rows("implemented", "implemented") }), { reason: "completed", tracked: [] });
    assert.deepEqual(closePlan(d, { title, review: rows("implemented", "deferred") }).open.map((r) => r.id), ["R2"]);
    assert.deepEqual(closePlan(d, { title, review: { requirements: [{ id: "R1", status: "implemented" }] } }).open.map((r) => r.id), ["R2"], "a missing row is not an answer");
    assert.equal(closePlan(d, { title, review: null }).reason, "completed", "a skipped review judges dispositions only");
  });
  it("#5240 an unticked acceptance box with an undelivered or untracked requirement closes partial for any title", () => {
    const issueText = "## Acceptance\n\n- [ ] Replaying the incident keeps the issue open with a partial outcome\n- [ ] The gate mode is recorded in the trajectory notes\n";
    const reqs = [
      { id: "R1", quote: "- [ ] Replaying the incident keeps the issue open with a partial outcome", disposition: "deliver" },
      { id: "R2", quote: "- [ ] The gate mode is recorded in the trajectory notes", disposition: "defer", tracked: "#9" },
    ];
    const rows = (s1) => ({ requirements: [{ id: "R1", status: s1 }, { id: "R2", status: "deferred" }] });
    const p = closePlan({ requirements: reqs }, { title: "fix: x", review: rows("partial"), issueText });
    assert.equal(p.reason, "partial"); assert.equal(p.checklist, true);
    assert.deepEqual(p.open.map((r) => r.id), ["R1"]); assert.deepEqual(p.unticked, ["Replaying the incident keeps the issue open with a partial outcome"]);
    assert.deepEqual(closePlan({ requirements: reqs }, { title: "fix: x", review: rows("implemented"), issueText }), { reason: "completed", tracked: ["#9"] });
    const untracked = closePlan({ requirements: [reqs[0], { ...reqs[1], tracked: undefined }] }, { title: "fix: x", review: rows("implemented"), issueText });
    assert.deepEqual(untracked.open.map((r) => r.id), ["R2"]);
    assert.equal(closePlan({ requirements: reqs }, { title: "fix: x", review: rows("partial") }).reason, "completed", "no issue text: unchanged");
    assert.equal(closePlan({ requirements: reqs }, { title: "fix: x", review: null, issueText }).reason, "completed", "skipped review judges dispositions only");
  });
  it("#4398 formatShadowSummary: shadow would-block and false-block shares, risk-enforced lanes; null without conformance rows", () => {
    assert.equal(formatShadowSummary([{ issue: 1 }]), null); assert.equal(formatShadowSummary(undefined), null);
    const rows = [{ conformance: { mode: "shadow", would: "conforms", risk: false } }, { conformance: { mode: "shadow", would: "nonconforming", risk: false } },
      { conformance: { mode: "shadow", would: "review.incomplete", risk: false } }, { conformance: { mode: "shadow", would: null, risk: false } },
      { conformance: { mode: "enforce", would: null, risk: true } }, { issue: 9 }];
    assert.equal(formatShadowSummary(rows), "conformance: 4 shadow lanes, would block 2 (50%), false-block 1 (25%: would-block on an incomplete/inconsistent/unparseable review); risk-path enforced: 1");
    assert.match(formatShadowSummary([{ conformance: { mode: "enforce", would: null, risk: false } }]), /0 shadow lanes, would block 0 \(n\/a\)/);
  });
  it("follow-up keys are single-line, tab-free and stable", () => {
    const [i] = followupItems([{ id: "R2", quote: "a\tb\n`c`", disposition: "defer", why: "x\ny" }]);
    assert.equal(i.key, "R2: a b c"); assert.equal(i.why, "defer: x y"); assert.doesNotMatch(i.key + i.why, /[\t\n`]/);
  });
  it("a follow-up key whose 240-char cut ends on a space has no trailing whitespace (#4388)", () => {
    const quote = `${"x".repeat(234)} tail of the quote past the cut`; // "R12: " + 234 chars puts the space at index 239
    assert.equal(`R12: ${quote}`[239], " ");
    const [i] = followupItems([{ id: "R12", quote, disposition: "defer", why: "w" }]);
    assert.equal(i.key, i.key.trim()); assert.equal(i.key.length, 239); assert.doesNotMatch(i.key, /\s$/);
  });
  it("followupMap resolves untrimmed item keys from the script's trimmed echo (#4388)", () => {
    assert.deepEqual(followupMap("R1: a\t42\nnoise\nR2: b\tx\n", [{ key: "R1: a " }, { key: "R2: b" }]), { "R1: a ": 42 });
  });
});

describe("hotspot growth precheck (forge#4195)", () => {
  const H = (o = {}) => ({ path: "src/scrape.js", lines: 2600, commits_90d: 30, hotspot: 78000, over: true, excluded: false, base_lines: 2400, growth: 200, ...o });
  const hs = (fs, o = {}) => ({ enabled: true, file_lines: 2000, growth_lines: 150, files: fs, ...o });
  const result = { validation: [{ id: "V1", exit: 0 }], requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }] };
  const run = (hotspots, contract = C, r = result) => precheck({ contract, result: r, changedFiles: files, hotspots });

  it("an over-threshold file grown past growth_lines fails with maintenance.hotspot_growth", () => {
    const pc = run(hs([H()]));
    assert.equal(pc.ok, false);
    assert.deepEqual(pc.failures.map((f) => [f.code, f.kind]), [["maintenance.hotspot_growth", "hotspot_growth"]]);
    assert.match(pc.failures[0].detail, /^src\/scrape\.js grew by 200 lines \(now 2600, limit \+150 over 2000\) without hotspot-exempt$/);
  });

  it("#4519 generated paths: applyAmendments refuses add-deliverable on maintenance.generated_paths, hotspotGrowth skips generated rows", () => {
    const gen = ["web/public/openapi*.json", "web/public/openapi-versions/*"];
    const amends = [{ kind: "add-deliverable", path: "web/public/openapi-versions/3.29.2.json", why: "sync the spec archive" },
      { kind: "add-deliverable", path: "./web/public/openapi.json", why: "sync the spec" }, { kind: "add-deliverable", path: "src/shared.js", why: "helper" }];
    const a = applyAmendments(C, amends, null, { generatedPaths: gen });
    assert.deepEqual(a.applied.map((x) => x.target), ["src/shared.js"]);
    assert.equal(a.problems.length, 2);
    assert.match(a.problems[0], /^add-deliverable web\/public\/openapi-versions\/3\.29\.2\.json: generated path \(forge\.yaml maintenance\.generated_paths\)/);
    assert.ok(!a.contract.deliverables.some((d) => d.path.includes("openapi")), "a refused path never becomes a deliverable");
    assert.equal(applyAmendments(C, amends).applied.length, 3, "without generatedPaths every add-deliverable applies as before");
    assert.equal(applyAmendments(C, amends, null, { generatedPaths: ["web/public/openapi.json"] }).applied.length, 2, "a literal glob matches only that path");
    // linguist-generated / generated_paths / header rows (hotspots.sh `generated`) never trigger hotspot_growth
    const big = H({ path: "src/scrape.js", lines: 83974, growth: 83974 });
    assert.equal(run(hs([big])).ok, false);
    assert.equal(run(hs([{ ...big, generated: true }])).ok, true);
    assert.equal(run(hs([{ ...big, generated: true, excluded: true }])).ok, true);
  });

  it("within the limit, under the threshold, excluded, unchanged, disabled or no facts: no failure", () => {
    for (const h of [hs([H({ growth: 150 })]), hs([H({ over: false, lines: 1900 })]), hs([H({ excluded: true })]), hs([H({ path: "src/other.js" })]),
      hs([H()], { enabled: false }), hs([H({ growth: null })]), null, undefined, {}]) assert.equal(run(h).ok, true, JSON.stringify(h));
    assert.deepEqual(precheck({ contract: C, result, changedFiles: files }), run(null), "callers without hotspots are unchanged");
  });

  it("hotspot-exempt: <reason> in a covering deliverable's change or an add-deliverable amendment's why exempts the file", () => {
    const withChange = (change) => ({ ...C, deliverables: [{ id: "D1", path: "src/scrape.js", change }, C.deliverables[1]] });
    assert.equal(run(hs([H()]), withChange("route fix; Hotspot-Exempt: the handler table must stay in one file")).ok, true);
    assert.equal(run(hs([H()]), withChange("hotspot-exempt:   ")).ok, false, "an empty reason does not exempt");
    assert.equal(run(hs([H()]), { ...C, deliverables: [{ id: "D1", path: "src/", change: "hotspot-exempt: generated routes" }, C.deliverables[1]] }).ok, true, "a covering directory deliverable");
    const amended = { ...result, amendments: [{ kind: "add-deliverable", path: "src/scrape.js", why: "hotspot-exempt: one-off migration table" }] };
    assert.equal(run(hs([H()]), C, amended).ok, true);
    assert.equal(run(hs([H(), H({ path: "src/search.js" })]), withChange("hotspot-exempt: ok")).failures.length, 1, "the exemption covers only its own file");
    assert.equal(hotspotGrowth({ contract: C, hotspots: hs([H()]), changedFiles: ["./src/scrape.js"] }).length, 1);
  });
});

describe("repro_test on bug lanes (#4271)", () => {
  const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
  const RT = { path: "test/leak.test.js", id: "releases on 429", command: "node --test test/leak.test.js" };
  it("isBugIssue reads bug and type:bug labels, as names or {name}", () => {
    assert.equal(isBugIssue([{ name: "bug" }]), true);
    assert.equal(isBugIssue(["P2", "type:bug"]), true);
    assert.equal(isBugIssue([{ name: "feature" }, "debug"]), false);
    assert.equal(isBugIssue(null), false);
  });
  it("a testable bug needs repro_test {path, command}; a non-testable one records none with a reason", () => {
    assert.deepEqual(validateContract({ ...C, repro_test: RT }, ISSUE, { repro: true }), { ok: true, problems: [] });
    assert.deepEqual(validateContract({ ...C, repro_test: "none", repro_test_reason: "spec-only change" }, ISSUE, { repro: true }), { ok: true, problems: [] });
    assert.match(validateContract(C, ISSUE, { repro: true }).problems.join(), /repro_test must be/);
    assert.match(validateContract({ ...C, repro_test: { path: "test/x.js" } }, ISSUE, { repro: true }).problems.join(), /repro_test must be/);
    assert.match(validateContract({ ...C, repro_test: "none" }, ISSUE, { repro: true }).problems.join(), /repro_test_reason/);
  });
  it("red on base and green on head passes; anything else fails the precheck as conformance.unimplemented", () => {
    const k = { ...C, repro_test: RT };
    assert.deepEqual(precheck({ contract: k, result: res, changedFiles: files, repro: { base: "FAILED", head: "RAN" } }), { ok: true, failures: [], superseded: [], ciCovered: [] });
    for (const repro of [{ base: "SKIPPED", head: "FAILED" }, { base: "UNRUNNABLE", head: "RAN" }, { base: "SKIPPED", head: "RAN_NOTHING" }]) {
      const pc = precheck({ contract: k, result: res, changedFiles: files, repro });
      assert.deepEqual(pc.failures.map((f) => [f.code, f.kind]), [["conformance.unimplemented", "repro_red_green"]], JSON.stringify(repro));
      assert.match(pc.failures[0].detail, new RegExp(`BASE=${repro.base} HEAD=${repro.head}`));
    }
    assert.match(reproFailures(k, { base: "SKIPPED", head: "FAILED" })[0].detail, /HEAD=FAILED \(base not run: head did not pass\)$/);
    assert.doesNotMatch(reproFailures(k, { base: "RAN", head: "RAN" })[0].detail, /base not run/);
  });
  it("#5080 repro_base_green: BASE=RAN HEAD=RAN is its own kind, and a test-only diff with a source deliverable is never the fix", () => {
    const k = { ...C, repro_test: RT };
    const green = precheck({ contract: k, result: res, changedFiles: files, repro: { base: "RAN", head: "RAN" } });
    assert.deepEqual(green.failures.map((f) => [f.code, f.kind]), [["conformance.unimplemented", "repro_base_green"]]);
    assert.match(green.failures[0].detail, /must fail on the base and pass on head; got BASE=RAN HEAD=RAN/);
    const testOnly = ["test/leak.test.js"];
    const pc = precheck({ contract: k, result: res, changedFiles: testOnly, repro: { base: "RAN", head: "RAN" } });
    assert.deepEqual(pc.failures.map((f) => f.kind), ["repro_base_green", "source_deliverable_untouched"]);
    assert.equal(alreadyFixedOnBase(pc.failures, testOnly), true);
    assert.equal(alreadyFixedOnBase(green.failures, testOnly), true);
    assert.equal(alreadyFixedOnBase(green.failures, ["src/leak.js", "test/leak.test.js"]), false, "a source change keeps conformance.unimplemented (K3)");
    assert.equal(alreadyFixedOnBase(green.failures, ["docs/a.md", ".forge-lean/x.json"], [".forge-lean/"]), true);
    assert.equal(alreadyFixedOnBase([{ kind: "repro_base_green" }, { kind: "validate_failed" }]), false);
    assert.equal(alreadyFixedOnBase([{ kind: "source_deliverable_untouched" }]), false);
    const only = precheck({ contract: k, result: res, changedFiles: testOnly, repro: { base: "FAILED", head: "RAN" } });
    assert.deepEqual(only.failures.map((f) => f.kind), ["source_deliverable_untouched"]);
    assert.deepEqual(sourceDeliverableFailures(k, files), []);
    assert.deepEqual(sourceDeliverableFailures({ deliverables: [{ id: "D1", path: "docs/a.md" }, { id: "D2", path: "test/leak.test.js" }] }, testOnly), []);
    assert.deepEqual(sourceDeliverableFailures(k, ["test/leak.test.js", ".forge-lean/x.json"], [".forge-lean/"]).map((f) => f.kind), ["source_deliverable_untouched"]);
  });
  it("a harness UNRUNNABLE on head is env.repro_unrunnable, not conformance.unimplemented (#4334)", () => {
    const k = { ...C, repro_test: RT };
    for (const repro of [{ base: "SKIPPED", head: "UNRUNNABLE" }, { base: "UNRUNNABLE", head: "UNRUNNABLE" }, {}]) {
      const pc = precheck({ contract: k, result: res, changedFiles: files, repro });
      assert.deepEqual(pc.failures.map((f) => [f.code, f.kind]), [["env.repro_unrunnable", "repro_env"]], JSON.stringify(repro));
      assert.match(pc.failures[0].detail, /test\/leak\.test\.js releases on 429 \(`node --test test\/leak\.test\.js`\): the harness could not run the test on head \(environment, not the change\)/);
      assert.match(pc.failures[0].detail, new RegExp(`BASE=${repro.base ?? "UNRUNNABLE"} HEAD=UNRUNNABLE$`));
    }
  });
  it("off (no repro option) is today's contract check and precheck exactly", () => {
    assert.deepEqual(validateContract(C, ISSUE), validateContract(C, ISSUE, { repro: false }));
    assert.deepEqual(validateContract(C, ISSUE), { ok: true, problems: [] });
    assert.deepEqual(precheck({ contract: C, result: res, changedFiles: files }), precheck({ contract: C, result: res, changedFiles: files, repro: null }));
  });
});

describe("#4265 issue scope and failure explanations", () => {
  const iss = { title: "t", body: "Fix foo.\n\n<!-- FORGE:STATE\n{\"lease\":1}\n-->" };
  const human = { body: "Also bar." };
  it("scopeText ignores the engine's HTML-comment blocks and FORGE comments, keeps human text", () => {
    const base = scopeText(iss, [human]);
    assert.equal(scopeText({ ...iss, body: iss.body.replace("\"lease\":1", "\"lease\":2") }, [human, { body: "<!-- FORGE:CONTRACT -->\n## Builder Contract" }, { body: "  <!-- FORGE:STARTED -->\nStarted" }]), base);
    assert.match(base, /Fix foo\.[\s\S]*Also bar\./);
    assert.doesNotMatch(base, /FORGE:STATE|lease/);
    assert.notEqual(scopeText(iss, [human, { body: "Scope: also baz." }]), base);
    assert.notEqual(scopeText({ ...iss, body: "Fix foo and qux." }, [human]), base);
  });
  it("#4298 SEC-5: an edit that only touches a human HTML comment is not a scope edit", () => {
    const withNote = { ...iss, body: `${iss.body}\n<!-- note: maybe also qux -->` };
    assert.equal(scopeText(withNote, [human]), scopeText({ ...withNote, body: withNote.body.replace("maybe also qux", "definitely qux") }, [human]));
    assert.equal(scopeText(withNote, [human]), scopeText(iss, [human]));
  });
  it("#4298: movingBaseDiff reads only the revisions before `--`", () => {
    assert.equal(movingBaseDiff("git diff HEAD -- origin/x.txt"), null);
    assert.equal(movingBaseDiff("git diff --stat -- origin/foo/bar && echo ok"), null);
    assert.equal(movingBaseDiff("git diff origin/main -- src"), "origin/main");
    assert.equal(movingBaseDiff("git diff --name-only origin/main --"), "origin/main");
  });
  it("explainFailures appends the quote of the requirement a detail names, and leaves other details alone", () => {
    const contract = { requirements: [{ id: "R1", quote: "foo must handle null" }, { id: "R2", quote: "x".repeat(300) }] };
    const out = explainFailures([{ code: "c", detail: "R1 reported \"partial\"" }, { code: "c", detail: "R2 missing" }, { code: "c", detail: "validate V1 failed (exit 1)" }, { code: "c", detail: "R9 missing" }], contract);
    assert.equal(out[0].detail, 'R1 reported "partial" ("foo must handle null")');
    assert.ok(out[1].detail.endsWith('...")') && out[1].detail.length < 200);
    assert.equal(out[2].detail, "validate V1 failed (exit 1)");
    assert.equal(out[3].detail, "R9 missing");
    assert.equal(out[0].code, "c");
  });
  it("a failed validate names its command", () => {
    const r = precheck({ contract: { requirements: [], deliverables: [], validate: [{ id: "V1", command: "npm test" }] }, result: { validation: [{ id: "V1", exit: 2 }] }, changedFiles: [] });
    assert.equal(r.failures[0].detail, "validate V1 (`npm test`) failed (exit 2)");
  });
});

describe("#4350 the engine's scope gate is the authority over a builder's scope-check validate", () => {
  const ALLOW = 'test -z "$(git diff --name-only origin/main...HEAD | grep -v -x -e src/tool.js -e test/tool.test.js)"';
  const frozen = {
    requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }],
    deliverables: [{ id: "D1", path: "src/tool.js" }],
    validate: [{ id: "V1", command: "node --test test/tool.test.js" }, { id: "V2", command: ALLOW }],
  };
  const amendments = [{ kind: "add-deliverable", path: "docs/tool.md", why: "the docs-freshness rule needs the module doc" }];
  const effective = applyAmendments(frozen, amendments).contract;
  const changed = ["src/tool.js", "test/tool.test.js", "docs/tool.md", ".forge-lean/result.json"];
  const result = { requirements: [{ id: "R1", status: "implemented" }], validation: [{ id: "V1", exit: 0 }, { id: "V2", exit: 1 }], amendments };
  const run = (o = {}) => precheck({ contract: effective, result, changedFiles: changed, ignore: [".forge-lean/"], validateRuns: { V2: { rc: 1, output: "" } }, frozen, ...o });
  it("#4350 a scope-allowlist validate that fails only for an amended deliverable is superseded, not conformance.unimplemented", () => {
    const pc = run();
    assert.deepEqual(pc.failures, []);
    assert.equal(pc.ok, true, "the lane is not ended by the stale check");
    assert.deepEqual(pc.superseded, [{ id: "V2", files: ["docs/tool.md"] }]);
  });
  it("#4350 a real out-of-scope edit is still scope creep, and the stale validate failure stands", () => {
    const pc = run({ changedFiles: [...changed, "src/other.js"] });
    assert.deepEqual(codes(pc), ["conformance.scope_creep", "conformance.unimplemented"]);
    assert.match(pc.failures[0].detail, /src\/other\.js/);
    assert.deepEqual(pc.superseded, []);
  });
  it("#4350 a failing non-scope validate, a scope check failing with no amended file, and callers without frozen are unchanged", () => {
    const testFail = { ...result, validation: [{ id: "V1", exit: 1 }, { id: "V2", exit: 0 }] };
    assert.deepEqual(codes(run({ result: testFail, validateRuns: { V1: { rc: 1, output: "AssertionError" } } })), ["conformance.unimplemented"]);
    assert.deepEqual(codes(run({ changedFiles: ["src/tool.js", "test/tool.test.js"] })), ["conformance.unimplemented"], "nothing amended in the diff: the validate failed for its own reason");
    const legacy = run({ frozen: undefined });
    assert.deepEqual(codes(legacy), ["conformance.unimplemented"]);
    assert.deepEqual(legacy.superseded, []);
  });
  it("#4350 isScopeCheck recognises file-listing git commands only", () => {
    for (const c of [ALLOW, "git diff --name-status origin/x...HEAD | grep -c .", "git -C pkg diff --stat $(git merge-base HEAD origin/x)", "git log --name-only -1", "test -z \"$(git status --porcelain)\""]) assert.ok(isScopeCheck(c), c);
    for (const c of ["npm test", "git diff --check origin/x...HEAD", "pytest -k name_only", "git diff --exit-code -- src/a.js"]) assert.ok(!isScopeCheck(c), c);
  });
});

describe("#4353 the engine's scope gate is the only scope authority: pure scope validates are dropped at freeze", () => {
  const ALLOW = 'test -z "$(git diff --name-only origin/main...HEAD | grep -v -x -e src/tool.js -e test/tool.test.js)"';
  it("#4353 isPureScopeCheck: an allowlist or denylist made only of git listing and filter commands; anything that also runs code is kept", () => {
    for (const c of [ALLOW, "git diff --name-status origin/x...HEAD | grep -c .", "git -C pkg diff --stat $(git merge-base HEAD origin/x)", "! git diff --name-only origin/x...HEAD | grep -qv '^src/'", "test -z \"$(git status --porcelain)\"", "[ \"$(git diff --name-only origin/x...HEAD | wc -l)\" -le 3 ]"]) assert.ok(isPureScopeCheck(c), c);
    for (const c of ["npm test", "node --test x && git diff --stat origin/x...HEAD", "git diff --name-only origin/x...HEAD | xargs node --check", "pytest -k name_only", "git diff --exit-code -- src/a.js", "git diff --name-only HEAD~1 | sh"]) assert.ok(!isPureScopeCheck(c), c);
  });
  it("#4353 dropScopeValidates removes only pure scope validates and reports them; other contracts are unchanged", () => {
    const c = { requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }], deliverables: [{ id: "D1", path: "src/tool.js" }],
      validate: [{ id: "V1", command: "node --test test/tool.test.js" }, { id: "V2", command: ALLOW }, { id: "V3", command: "node --test x && git diff --stat" }] };
    const d = dropScopeValidates(c);
    assert.deepEqual(d.dropped, [{ id: "V2", command: ALLOW }]);
    assert.deepEqual(d.contract.validate.map((v) => v.id), ["V1", "V3"]);
    assert.equal(c.validate.length, 3, "the input is not mutated");
    assert.equal(validateContract(d.contract, `${Q1}`).ok, true, "the dropped contract still freezes");
    const plain = { ...c, validate: [c.validate[0]] };
    assert.equal(dropScopeValidates(plain).contract, plain); assert.deepEqual(dropScopeValidates(plain).dropped, []);
    for (const x of [null, [], "x", { requirements: [] }]) assert.deepEqual(dropScopeValidates(x), { contract: x, dropped: [] });
  });
  it("#4353 a legacy frozen contract that still carries the allowlist keeps the #4350 superseded path", () => {
    const frozen = { requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }], deliverables: [{ id: "D1", path: "src/tool.js" }], validate: [{ id: "V1", command: "node --test test/tool.test.js" }, { id: "V2", command: ALLOW }] };
    const amendments = [{ kind: "add-deliverable", path: "docs/tool.md", why: "module doc" }];
    const pc = precheck({ contract: applyAmendments(frozen, amendments).contract, frozen, changedFiles: ["src/tool.js", "docs/tool.md"], validateRuns: { V2: { rc: 1, output: "" } },
      result: { requirements: [{ id: "R1", status: "implemented" }], validation: [{ id: "V1", exit: 0 }, { id: "V2", exit: 1 }], amendments } });
    assert.equal(pc.ok, true); assert.deepEqual(pc.superseded, [{ id: "V2", files: ["docs/tool.md"] }]);
  });
});

describe("#4404 verified out of band: a requirement measured outside the lane is judged by its instrumentation", () => {
  const LH = "Lighthouse performance score >= 95 on the landing page.";
  const TTI = "Interactive < 1 s on a throttled mid-range Android profile.";
  const NIGHTLY = "The nightly perf suite reports the 1,000-event render time.";
  const OOB_ISSUE = `${ISSUE}\n- [ ] ${LH}\n- [ ] ${TTI}\n- [ ] ${NIGHTLY}\n- [ ] Field perf stays within budget.`;
  const k = { ...C, requirements: [...C.requirements, { id: "R3", quote: LH, disposition: "deliver", evidence: "lighthouse-nightly" }] };
  const tagged = tagOutOfBand(k).contract;
  const oobRow = { id: "R3", status: "partial", evidence: "web/perf/budget.test.js:4", validated_by: "V1", verify: "out_of_band", job: "lighthouse-nightly", instrumented: true };
  const oobCtx = { ...ctx, contract: tagged, changedFiles: [...files, "web/perf/budget.test.js"], issueText: OOB_ISSUE };
  const withRow = (r) => ({ ...good, requirements: [...good.requirements, r], issue_coverage: [...good.issue_coverage, { quote: LH, status: "covered" }] });

  it("a contract requirement mentioning Lighthouse or field perf is tagged out_of_band at plan time", () => {
    const c = { ...C, requirements: [...C.requirements,
      { id: "R3", quote: LH, disposition: "deliver" }, { id: "R4", quote: "Field perf stays within budget.", disposition: "deliver" },
      { id: "R5", quote: TTI, disposition: "deliver" }, { id: "R6", quote: NIGHTLY, disposition: "deliver" },
      { id: "R7", quote: LH, disposition: "deliver", verify: "in_lane" }, { id: "R8", quote: LH, disposition: "post-deploy", why: "w" }] };
    const t = tagOutOfBand(c);
    assert.deepEqual(t.tagged, ["R3", "R4", "R5", "R6"]);
    assert.deepEqual(t.contract.requirements.filter(isOutOfBand).map((r) => r.id), ["R3", "R4", "R5", "R6"]);
    assert.equal(t.contract.requirements.find((r) => r.id === "R7").verify, "in_lane"); // an explicit verify wins
    assert.equal(t.contract.requirements.find((r) => r.id === "R8").verify, undefined); // only deliver requirements
    assert.equal(c.requirements[2].verify, undefined); // the input contract is not mutated
    assert.equal(tagOutOfBand(C).contract, C); assert.deepEqual(tagOutOfBand(C).tagged, []);
    for (const x of [null, [], "x", {}]) assert.deepEqual(tagOutOfBand(x), { contract: x, tagged: [] });
    assert.deepEqual(VERIFY_MODES, ["in_lane", "out_of_band"]);
    for (const q of [LH, TTI, NIGHTLY, "Field performance holds.", "Web vitals pass.", "A report-only bench workflow tracks it."]) assert.match(q, OUT_OF_BAND_RE, q);
    for (const q of ["The nightly build. Then a suite.", "Add a unit test for the parser.", "Run the job locally."]) assert.doesNotMatch(q, OUT_OF_BAND_RE, q);
  });

  it("an add-requirement amendment is tagged the same way", () => {
    const a = applyAmendments(C, [{ kind: "add-requirement", requirement: { id: "R9", quote: LH }, why: "missed" }], OOB_ISSUE);
    assert.equal(a.contract.requirements.find((r) => r.id === "R9").verify, "out_of_band");
  });

  it("validateContract: an out-of-band requirement names its job; verify takes only known modes and deliver", () => {
    assert.deepEqual(validateContract(tagged, OOB_ISSUE), { ok: true, problems: [] });
    const noJob = tagOutOfBand({ ...C, requirements: [...C.requirements, { id: "R3", quote: LH, disposition: "deliver" }] }).contract;
    assert.match(validateContract(noJob, OOB_ISSUE).problems.join("\n"), /R3: verify out_of_band needs evidence naming the job/);
    const bad = { ...C, requirements: [{ ...C.requirements[0], verify: "later" }, { ...C.requirements[1], disposition: "defer", why: "w", verify: "out_of_band", evidence: "j" }] };
    const p = validateContract(bad, OOB_ISSUE).problems.join("\n");
    assert.match(p, /R1: verify must be one of in_lane\|out_of_band/); assert.match(p, /R2: verify out_of_band applies only to a deliver requirement/);
  });

  it("with the instrumentation present the reviewer passes the requirement; without it it is still unimplemented", () => {
    assert.equal(decide(withRow(oobRow), oobCtx).state, "conforms");
    const missing = decide(withRow({ ...oobRow, status: "missing", instrumented: false, evidence: "" }), oobCtx);
    assert.equal(missing.state, "nonconforming"); assert.deepEqual(codes(missing), ["conformance.unimplemented"]);
    assert.match(missing.failures[0].detail, /R3 verified out of band by lighthouse-nightly: instrumentation missing/);
    // instrumented is required on an out-of-band row, and instrumented true needs path:line evidence
    assert.deepEqual(checkCompleteness(withRow({ ...oobRow, instrumented: null }), oobCtx).missing, ["R3"]);
    assert.deepEqual(checkCompleteness(withRow({ ...oobRow, evidence: "" }), oobCtx).missing, ["R3"]);
    // the same partial row on an in-lane requirement still fails (unchanged behaviour)
    const inLane = { ...oobCtx, contract: { ...tagged, requirements: tagged.requirements.map((r) => (r.id === "R3" ? { ...r, verify: "in_lane" } : r)) } };
    assert.deepEqual(codes(decide(withRow(oobRow), inLane)), ["conformance.unimplemented"]);
  });

  it("precheck: the builder's instrumented out-of-band row is not unimplemented; a bare partial one is", () => {
    const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    const ok = { requirements: [...res.requirements, { id: "R3", status: "partial", instrumented: true }], validation: res.validation };
    assert.equal(precheck({ contract: tagged, result: ok, changedFiles: files }).ok, true);
    const no = { requirements: [...res.requirements, { id: "R3", status: "partial" }], validation: res.validation };
    const f = precheck({ contract: tagged, result: no, changedFiles: files }).failures;
    assert.deepEqual(f.map((x) => x.kind), ["requirement_unimplemented"]); assert.match(f[0].detail, /R3 is verified out of band by lighthouse-nightly/);
  });

  it("the skeleton row carries the job and an empty instrumented; outOfBandRequirements lists the job", () => {
    const sk = reviewSkeleton(tagged, files);
    assert.deepEqual(sk.requirements.find((r) => r.id === "R3"), { id: "R3", status: "", evidence: "", validated_by: "", verify: "out_of_band", job: "lighthouse-nightly", instrumented: null, note: "" });
    assert.equal("instrumented" in sk.requirements[0], false);
    assert.deepEqual(outOfBandRequirements(tagged), [{ id: "R3", quote: LH, job: "lighthouse-nightly" }]);
  });
});

describe("#4594 amend-requirement", () => {
  const am = { kind: "amend-requirement", requirement: "R1", text: "regenerate and reveal the feed URL once", why: "token stored hash-only" };
  it("with text it keeps deliver, tracks nothing and records the amendment", () => {
    const a = applyAmendments(C, [am]);
    assert.deepEqual(a.problems, []); assert.deepEqual(a.toTrack, []);
    const r = a.contract.requirements.find((x) => x.id === "R1");
    assert.equal(r.disposition, "deliver"); assert.equal(r.amendment.text, am.text); assert.equal(r.amendment.why, am.why); assert.equal(r.quote, C.requirements[0].quote);
  });
  it("amend-requirement with text on a defer requirement flips it to deliver and files no follow-up (#4984)", () => {
    const D = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "later", bucket: "new-issue", tracked: "#5" }] };
    const a = applyAmendments(D, [{ ...am, requirement: D.requirements[1].id, why: "token stored hash-only; #5 is now delivered in the diff" }]);
    assert.deepEqual(a.problems, []); assert.deepEqual(a.toTrack, []);
    const r = a.contract.requirements[1];
    assert.equal(r.disposition, "deliver"); assert.equal(r.amendment.text, am.text);
    assert.ok(!("bucket" in r) && !("why" in r) && !("tracked" in r));
  });
  it("a trivial rewording of a deferred requirement keeps amended_from for the reviewer (#4996)", () => {
    const D = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "later", bucket: "new-issue" }] };
    const a = applyAmendments(D, [{ ...am, requirement: D.requirements[1].id, text: "done", why: "trivial" }]);
    assert.deepEqual(a.problems, []);
    const r = a.contract.requirements[1];
    assert.equal(r.disposition, "deliver"); assert.equal(r.amended_from.disposition, "defer"); assert.equal(r.amended_from.quote, C.requirements[1].quote); assert.equal(r.amended_from.why, "later");
  });
  it("post-deploy flip with a check id is rejected without naming it, accepted when named (#4996)", () => {
    const chk = "pd-check-1";
    const D = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "post-deploy", why: "after deploy", bucket: "post-deploy", check: chk }] };
    const bad = applyAmendments(D, [{ ...am, requirement: D.requirements[1].id }]);
    assert.match(bad.problems[0], /does not name its pd-check-1/);
    assert.equal(D.requirements[1].disposition, "post-deploy"); assert.equal(bad.contract.requirements[1].disposition, "post-deploy");
    const ok = applyAmendments(D, [{ ...am, requirement: D.requirements[1].id, why: `${chk} now runs in the diff` }]);
    assert.deepEqual(ok.problems, []); assert.equal(ok.contract.requirements[1].amended_from.check, chk);
  });
  it("the reviewer prompt tells it to compare amended_from with the amendment (#4996)", () => {
    assert.match(readFileSync(new URL("./prompts.mjs", import.meta.url), "utf8"), /amended_from\.quote and amended_from\.why with amendment\.text/);
  });
  it("followupMap matches a key whose quote repeats its own R<n>: prefix, as the script collapses it (#5141)", () => {
    const items = followupItems([{ id: "R6", disposition: "defer", bucket: "host", quote: "R6: Fleet: x in (browser, replay) over 48h.", why: "w" }, { id: "R1", disposition: "defer", bucket: "new-issue", quote: "R3: Named accounts", why: "w" }]);
    assert.deepEqual(followupMap("R6: Fleet: x in (browser, replay) over 48h.\t901\nR1: Named accounts\t902\n", items), { [items[0].key]: 901, [items[1].key]: 902 });
  });

  it("renderPendingFollowups lists each unfiled follow-up with its text and the FORGE:DEFERRED_FROM marker (#5141)", () => {
    const md = renderPendingFollowups([{ id: "R2", disposition: "defer", quote: "a\tb\nc", why: "w", marker: "FORGE:DEFERRED_FROM: #7" }], 12);
    assert.match(md, /^## Follow-up pending\nMerged by PR #12/);
    assert.match(md, /\n- R2 \(defer\): a b c \| why: w \| `FORGE:DEFERRED_FROM: #7`$/);
  });
  it("followupMap falls back to the single echoed row carrying the item id, never to an ambiguous one (#5141)", () => {
    assert.deepEqual(followupMap("R2: drifted text\t7\n", [{ id: "R2", key: "R2: original text" }]), { "R2: original text": 7 });
    assert.deepEqual(followupMap("R2: a\t7\nR2: b\t8\n", [{ id: "R2", key: "R2: c" }]), {});
    assert.deepEqual(followupMap("R20: a\t7\n", [{ id: "R2", key: "R2: c" }]), {});
  });

  it("followupMap matches an item key whose backticks the script stripped (#4984)", () => {
    assert.deepEqual(followupMap("R2: wire pd.py in\t20\n", [{ key: "R2: wire `pd.py` in" }]), { "R2: wire `pd.py` in": 20 });
  });
  it("an unknown requirement is a problem; the frozen contract is untouched", () => {
    assert.match(applyAmendments(C, [{ ...am, requirement: "R9" }]).problems[0], /unknown requirement R9/);
    assert.equal(C.requirements[0].amendment, undefined);
  });
  it("decide: an amended requirement the reviewer rejects fails as 'amendment not accepted'; accepted conforms", () => {
    const k = { ...ctx, contract: applyAmendments(C, [am]).contract };
    assert.equal(decide(good, k).state, "conforms");
    const d = decide({ ...row("R1", { status: "partial", note: "amendment: still never shows the URL" }), issue_coverage: good.issue_coverage.map((c) => (c.quote === Q1 ? { ...c, contract_ids: ["R1"], status: "narrowed" } : c)) }, k);
    assert.equal(d.state, "nonconforming");
    assert.ok(d.failures.length >= 2 && d.failures.every((f) => /amendment not accepted \(.*amended to "regenerate/.test(f.detail)));
  });
  it("explainFailures shows the amended text", () => {
    const c = applyAmendments(C, [am]).contract;
    assert.match(explainFailures([{ code: "x", detail: "R1 partial" }], c)[0].detail, /amended to "regenerate and reveal/);
  });
});

describe("post-deploy check ids (#4626)", () => {
  const pd = (extra = {}) => ({ ...C, requirements: [{ id: "R1", quote: Q1, disposition: "post-deploy", why: "needs prod", ...extra }, C.requirements[1]] });
  it("validateContract: a post-deploy requirement needs a well-formed check id", () => {
    assert.ok(validateContract(pd(), ISSUE).problems.some((p) => /post-deploy needs a check id/.test(p)));
    assert.ok(validateContract(pd({ check: "Bad Id" }), ISSUE).problems.some((p) => /post-deploy needs a check id/.test(p)));
    assert.ok(!validateContract(pd({ check: "login-smoke" }), ISSUE).problems.some((p) => /check id/.test(p)));
  });
  it("applyAmendments: a post-deploy amendment without a check id is deferred to the orchestrator (#5020)", () => {
    const bad = applyAmendments(C, [{ kind: "post-deploy", requirement: "R1", why: "w" }], ISSUE);
    assert.deepEqual(bad.problems, []);
    assert.equal(bad.contract.requirements[0].disposition, "defer");
    const ok = applyAmendments(C, [{ kind: "post-deploy", requirement: "R1", why: "w", check: "login-smoke" }], ISSUE);
    assert.equal(ok.contract.requirements[0].check, "login-smoke");
  });
  it("precheck: a check id on neither branch is unimplemented; null checkIds skips the rule", () => {
    const res = { requirements: [{ id: "R1", status: "post-deploy" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    const c = pd({ check: "login-smoke" });
    assert.ok(precheck({ contract: c, result: res, changedFiles: files, checkIds: new Set() }).failures.some((f) => f.kind === "check_unknown"));
    assert.ok(!precheck({ contract: c, result: res, changedFiles: files, checkIds: new Set(["login-smoke"]) }).failures.some((f) => f.kind === "check_unknown"));
    assert.ok(!precheck({ contract: c, result: res, changedFiles: files }).failures.some((f) => f.kind === "check_unknown"));
  });
  it("#4664 followupItems carries the follow-up class; validateContract rejects an unknown class", () => {
    const cls = (r) => followupItems([{ id: "R1", quote: Q1, why: "w", ...r }])[0].class;
    assert.equal(cls({ disposition: "defer" }), "engineering");
    assert.equal(cls({ disposition: "post-deploy", check: "x" }), "post-deploy");
    assert.equal(cls({ disposition: "defer", class: "external" }), "external");
    assert.equal(cls({ disposition: "defer", class: "bogus" }), "engineering");
    assert.deepEqual(FOLLOWUP_CLASSES, ["engineering", "post-deploy", "external", "ops", "host"]); // #5207: backlog removed
    assert.equal(followupClass({ disposition: "post-deploy" }), "post-deploy"); assert.equal(followupClass({ class: "ops" }), "ops");
    const v = validateContract({ requirements: [{ id: "R1", quote: Q1, disposition: "defer", why: "w", class: "bogus" }], deliverables: [], preserve: [], validate: [{ id: "V1", command: "true" }] }, Q1);
    assert.ok(v.problems.some((x) => /R1: class must be one of/.test(x)), v.problems.join(";"));
  });
  it("followupItems names the check in a post-deploy item", () => {
    const [i] = followupItems([{ id: "R1", quote: Q1, disposition: "post-deploy", why: "w", check: "login-smoke" }]);
    assert.match(i.why, /^post-deploy: \[check:login-smoke\] w$/);
  });
  it("#4724 a deferred row needs exactly one valid bucket; owner actions are never post-deploy; dates are absolute", () => {
    const contract = (r) => ({ requirements: [{ id: "R1", quote: Q1, why: "w", ...r }], deliverables: [], preserve: [], validate: [{ id: "V1", command: "true" }] });
    const probs = (r) => validateContract(contract(r), Q1).problems.filter((x) => /^R1: .*(bucket|never post-deploy|owner)/.test(x));
    assert.deepEqual(BUCKETS, ["post-deploy", "verify-now", "date", "owner", "new-issue", "host"]);
    assert.equal(probs({ disposition: "defer" }).length, 1); // missing bucket
    for (const bucket of ["post-deploy", "verify-now", "new-issue", "date:2026-12-01", "owner:rotate the key"]) assert.deepEqual(probs({ disposition: "defer", bucket }), [], bucket);
    for (const bucket of ["date:5 weeks after deploy", "date:2026-02-30", "date", "owner:", "owner", "later", "post-deploy:x"]) assert.equal(probs({ disposition: "defer", bucket }).length, 1, bucket);
    assert.match(probs({ disposition: "post-deploy", check: "a-smoke", bucket: "owner:spend" })[0], /never post-deploy/);
    assert.equal(probs({ disposition: "deliver", bucket: "post-deploy" }).length, 1);
    assert.deepEqual(probs({ disposition: "deliver" }), []);
    assert.deepEqual(bucketProblems({ disposition: "defer", bucket: "owner:x", class: "post-deploy" }).length, 1);
    assert.equal(bucketKind("date:2026-12-01"), "date"); assert.equal(bucketKind("nope"), null);
  });
  it("#4724 the bucket decides the follow-up class and tags the item for the script and the gate", () => {
    const one = (r) => followupItems([{ id: "R1", quote: Q1, disposition: "defer", why: "w", ...r }], { now: Date.UTC(2026, 9, 27) })[0];
    assert.equal(followupClass({ disposition: "defer", bucket: "owner:spend" }), "external");
    assert.equal(followupClass({ disposition: "defer", bucket: "owner:spend", class: "ops" }), "ops");
    assert.equal(followupClass({ disposition: "defer", bucket: "owner:x", class: "post-deploy" }), "external");
    assert.equal(followupClass({ disposition: "defer", bucket: "new-issue", class: "post-deploy" }), "engineering");
    assert.equal(followupClass({ disposition: "defer", bucket: "new-issue" }), "engineering"); assert.equal(followupClass({ disposition: "defer", bucket: "new-issue", class: "ops" }), "engineering"); // #5207
    for (const bucket of ["post-deploy", "verify-now", "date:2026-12-01"]) assert.equal(followupClass({ disposition: "defer", bucket }), "post-deploy");
    assert.equal(one({ bucket: "owner:rotate the key" }).why, "owner: rotate the key. [bucket:owner] w");
    assert.equal(one({ bucket: "verify-now" }).why, "post-deploy: [bucket:verify-now] w");
    assert.equal(one({ bucket: "date:2026-12-01" }).why, "post-deploy: [bucket:date] due:2026-12-01 from:2026-10-27 w");
    assert.equal(one({ bucket: "new-issue" }).why, "defer: [bucket:new-issue] w");
    assert.equal(one({}).why, "defer: w"); // an unbucketed (older) row is unchanged
  });
  it("#5078 owner is narrowed: post-promotion -> rollup, read-only prod -> host, credentials/spend -> external", () => {
    const d = (bucket, why = "w") => ({ disposition: "defer", bucket, why });
    assert.equal(ownerRoute(d(ORCHESTRATOR_BUCKET)), "post-deploy");
    assert.equal(followupClass(d("owner:orchestrator", "post-deploy action with no registered check")), "post-deploy");
    assert.equal(followupClass(d("owner:promote:new-nav", "activate the flag")), "post-deploy");
    assert.equal(followupClass(d("owner:ops", "purge the CDN after release")), "post-deploy");
    assert.equal(followupClass(d("owner:qa", "verify in production after promotion")), "post-deploy");
    assert.equal(followupClass(d("owner:obs-psql", "capture the read-only production query counts")), "host");
    assert.equal(followupClass(d("owner:ssh ovh-monitor", "tail the logs")), "host");
    assert.equal(followupClass(d("owner:stripe", "needs live Stripe credentials")), "external");
    assert.equal(followupClass(d("owner:finance", "approve the spend")), "external");
    assert.equal(followupClass(d("owner:ops", "needs a customer account to read production data")), "external");
    assert.equal(followupClass({ ...d("owner:obs-psql", "read prod data"), class: "ops" }), "ops");
    assert.equal(followupClass(d("host")), "host");
    // #5186: host + post-promotion text -> rollup; pre-promotion or external need stays host
    assert.equal(followupClass(d("host", "≥95% success over 7 days by the canary after promotion")), "post-deploy");
    assert.equal(followupClass(d("host", "billed margin from billing rows in production after promotion")), "post-deploy");
    assert.equal(followupClass(d("owner:ops", "read billing rows after promotion")), "post-deploy");
    assert.equal(followupClass(d("host", "capture the page in a browser on the host before promotion")), "host");
    assert.equal(followupClass(d("host", "capture the page in a browser on the host")), "host");
    assert.equal(followupClass(d("host", "update the rows after promotion")), "host");
    assert.deepEqual(bucketProblems(d("host")), []);
    assert.match(bucketProblems({ disposition: "post-deploy", check: "a", bucket: "host" }).join(";"), /never post-deploy/);
    assert.match(bucketProblems(d("owner:obs-psql", "capture production query counts")).join(";"), /use bucket host/);
    assert.deepEqual(bucketProblems(d("owner:stripe", "needs live credentials")), []);
    assert.deepEqual(bucketProblems(d(ORCHESTRATOR_BUCKET, "manual prod action")), []);
    const [h, o] = followupItems([{ id: "R1", quote: Q1, ...d("host", "count rows") }, { id: "R2", quote: Q1, why: "w", ...d("owner:orchestrator") }]);
    assert.equal(h.why, "host: [bucket:host] count rows"); assert.equal(h.class, "host");
    assert.equal(o.class, "post-deploy"); assert.match(o.why, /^owner: orchestrator\. \[bucket:owner\]/);
  });
  it("#4724 bucketTally counts deferred items per bucket kind; an amendment may carry the bucket", () => {
    assert.deepEqual(bucketTally([{ bucket: "date:2026-12-01" }, { bucket: "date:2026-12-02" }, { bucket: "owner:x" }, {}]), { date: 2, owner: 1, none: 1 });
    const c = { requirements: [{ id: "R1", quote: Q1, disposition: "deliver" }], deliverables: [], preserve: [], validate: [] };
    const r = applyAmendments(c, [{ kind: "defer", requirement: "R1", why: "w", bucket: "verify-now" }]);
    assert.equal(r.contract.requirements[0].bucket, "verify-now"); assert.equal(r.toTrack.length, 1);
  });
});

describe("#4726 a [type:e2e] requirement needs a real end-to-end validate", () => {
  const Q = "Users can sign up and sign in with an emailed code alone [type:e2e]";
  const mk = (cmd, quote = Q, extra = {}) => {
    const contract = { ...C, requirements: [{ id: "R1", quote, disposition: "deliver", ...extra }, C.requirements[1]], validate: [{ id: "V1", command: cmd }] };
    return { contract, ctx: { ...ctx, contract } };
  };
  const rv = (contract) => ({ ...good, issue_coverage: [{ quote: contract.requirements[0].quote, status: "covered" }, ...good.issue_coverage.slice(1)] });
  const run = (cmd, quote, extra, e2e) => { const m = mk(cmd, quote, extra); return decide(rv(m.contract), { ...m.ctx, issueText: `${ISSUE}\n${m.contract.requirements[0].quote}`, e2e }); };
  it("e2e requirement verified only by a unit test fails conformance (the #36414 shape)", () => {
    const d = run("pytest tests/test_email_code_auth.py");
    assert.equal(d.state, "nonconforming");
    assert.deepEqual(codes(d), ["conformance.e2e_unverified"]);
  });
  it("a Playwright, configured e2e check or e2e spec file validate passes", () => {
    assert.equal(run("npx playwright test e2e/signup.spec.ts").state, "conforms");
    assert.equal(run("make smoke-live", Q, {}, { checks: ["make smoke-live"] }).state, "conforms");
    assert.equal(run("node --test tests/signup.js", Q, {}, { isSpec: (f) => f === "tests/signup.js" }).state, "conforms");
  });
  it("isE2eCommand and e2eVerified resolve a V-ref to its contract command", () => {
    assert.equal(isE2eCommand("npx playwright test"), true);
    assert.equal(isE2eCommand("pytest tests/test_x.py"), false);
    const contract = { validate: [{ id: "V1", command: "pytest tests/a.py" }, { id: "V2", command: "npx cypress run" }] };
    assert.equal(e2eVerified({ validated_by: "V1" }, contract), false);
    assert.equal(e2eVerified({ validated_by: "V1, V2" }, contract), true);
  });
  it("[type:unit] and [type:api] requirements keep their evidence rules; not-applicable is untouched", () => {
    assert.equal(run("pytest tests/test_x.py", "Users can sign up with an emailed code [type:unit]").state, "conforms");
    assert.equal(run("pytest tests/test_x.py", "Users can sign up with an emailed code [type:api]").state, "conforms");
    const na = { ...C.requirements[0], quote: Q, disposition: "not-applicable", evidence: "src/a.js:1" };
    const contract = { ...C, requirements: [na, C.requirements[1]] };
    const r = { ...good, issue_coverage: [{ quote: Q, status: "covered" }, ...good.issue_coverage.slice(1)], requirements: [{ id: "R1", status: "not-applicable" }, good.requirements[1]] };
    assert.notEqual(decide(r, { ...ctx, contract, issueText: `${ISSUE}\n${Q}` }).failures.some((f) => f.code === "conformance.e2e_unverified"), true);
  });
});

describe("decision amendments (#4695)", () => {
  const withRow = { ...C, preserve: [...C.preserve, { id: "H1", what: "use A", source: "decision", decision: "d9-1" }] };
  const amend = (extra, opts = { baseFiles: ["src/scrape.js", "src/search.js"] }) => applyAmendments(withRow, [{ kind: "decision", why: "w", decision: { choice: "use B", anchors: ["src/**"], ...extra } }], null, opts);
  it("applies a decision whose anchors exist on the base and returns the record", () => {
    const a = amend({});
    assert.deepEqual(a.problems, []);
    assert.equal(a.decisions[0].choice, "use B");
    assert.ok(a.contract.preserve.some((p) => p.id === "H1"));
  });
  it("rejects an anchor that matches no base file", () => {
    const a = amend({ anchors: ["nope/**"] });
    assert.match(a.problems[0], /match no file on the base/);
    assert.equal(a.decisions.length, 0);
  });
  it("an anchor on a lane-added file conforms and the unlisted file becomes a deliverable; an anchor matching neither base nor an added file is rejected", () => {
    const go = (added, anchor = "scripts/seed.py") => applyAmendments(withRow, [{ kind: "decision", why: "w", decision: { choice: "use B", anchors: [anchor] } }], null, { baseFiles: ["src/scrape.js"], addedPaths: added });
    const ok = go(["scripts/seed.py"]);
    assert.deepEqual(ok.problems, []);
    assert.ok(ok.contract.deliverables.some((d) => d.path === "scripts/seed.py" && d.amended));
    assert.equal(ok.contract.deliverables.filter((d) => d.path === "scripts/seed.py").length, 1);
    assert.match(go(["scripts/other.py"]).problems[0], /match no file on the base/);
  });
  it("a blank-why amendment takes the engine's defaultWhy; without one it is still rejected", () => {
    const am = [{ kind: "add-deliverable", path: "x.js" }];
    const ok = applyAmendments(C, am, null, { defaultWhy: "engine-demanded rename" });
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.applied[0].why, "engine-demanded rename");
    assert.match(applyAmendments(C, am).problems[0], /amendment without why/);
  });
  it("supersedes drops the engine-authored preserve row; without it the row stays", () => {
    assert.ok(!amend({ supersedes: "d9-1" }).contract.preserve.some((p) => p.id === "H1"));
    assert.ok(amend({}).contract.preserve.some((p) => p.id === "H1"));
  });
  it("a decision without choice or anchors is an incomplete amendment", () => {
    assert.match(amend({ choice: "" }).problems[0], /needs decision/);
  });
});

describe("implied docs-freshness deliverable", () => {
  const base = ["src/scrape.js"], after = [...base, "src/search.js", "docs/guide.md", "src/extra.js"];
  it("a doc path newly added by a freshness fix round becomes an add-deliverable amendment, a code file does not", () => {
    const am = impliedDocDeliverables({ before: base, after, contract: C, wasFailing: true, nowOk: true });
    assert.deepEqual(am, [{ kind: "add-deliverable", path: "docs/guide.md", why: "docs freshness rule" }]);
  });
  it("applied, the doc passes conformance and an unrelated out-of-contract file in the same round is still scope_creep", () => {
    const am = impliedDocDeliverables({ before: base, after, contract: C, wasFailing: true, nowOk: true });
    const { contract } = applyAmendments(C, am, ISSUE);
    const pc = precheck({ contract, changedFiles: ["src/scrape.js", "src/search.js", "docs/guide.md", "src/extra.js"], result: null });
    const creep = pc.failures.filter((f) => f.kind === "scope_creep").map((f) => f.detail).join();
    assert.match(creep, /src\/extra\.js/); assert.doesNotMatch(creep, /docs\/guide\.md/);
  });
  it("only prose files under a docs directory are implied: build, dependency, agent-instruction and spec files stay scope_creep", () => {
    const bad = ["requirements.txt", "CMakeLists.txt", "CLAUDE.md", "AGENTS.md", "commands/work-on.md", ".claude/agents/x.md", "notes.txt", "docs/run.sh"];
    const good = ["devdocs/modules/lean.md", "doc/api.rst", "packages/web/docs/setup.mdx"];
    const am = impliedDocDeliverables({ before: base, after: [...base, ...bad, ...good], contract: C, wasFailing: true, nowOk: true });
    assert.deepEqual(am.map((a) => a.path), good);
  });
  it("nothing is implied unless the rule failed before the round and passes after, or when the doc was already changed or covered", () => {
    assert.deepEqual(impliedDocDeliverables({ before: base, after, contract: C, wasFailing: false, nowOk: true }), []);
    assert.deepEqual(impliedDocDeliverables({ before: base, after, contract: C, wasFailing: true, nowOk: false }), []);
    assert.deepEqual(impliedDocDeliverables({ before: [...base, "docs/guide.md"], after, contract: C, wasFailing: true, nowOk: true }), []);
  });
});

import { normalizeKindModes, blockingFailures, unverifiedRequirements, KIND_MODES } from "./conformance.mjs";

describe("per-kind modes and requirement evidence", () => {
  const f = (code) => ({ code });
  const ALLOW = ["conformance.unimplemented"];
  it("normalizeKindModes keeps valid entries from a map or the flat forge.yaml string", () => {
    assert.deepEqual(KIND_MODES, ["enforce", "shadow"]);
    assert.deepEqual(normalizeKindModes({ "a.b": "shadow", c: "bogus", d: "enforce" }), { "a.b": "shadow", d: "enforce" });
    assert.deepEqual(normalizeKindModes("a.b=shadow, c.d = enforce, x=nope"), { "a.b": "shadow", "c.d": "enforce" });
    assert.deepEqual(normalizeKindModes(null), {});
  });
  it("a shadow kind is recorded and an enforce kind blocks, in either lane mode", () => {
    const kinds = { "k.shadow": "shadow", "k.enforce": "enforce" };
    for (const shadow of [true, false]) {
      const r = blockingFailures([f("k.shadow"), f("k.enforce")], { shadow, kinds });
      assert.deepEqual([r.block.map((x) => x.code), r.record.map((x) => x.code)], [["k.enforce"], ["k.shadow"]]);
    }
  });
  it("kinds without their own mode follow the lane: enforce blocks all, shadow only the allowlist", () => {
    assert.equal(blockingFailures([f("x"), f("conformance.unimplemented")], { shadow: false }).block.length, 2);
    const r = blockingFailures([f("x"), f("conformance.unimplemented")], { shadow: true, allow: ALLOW });
    assert.deepEqual([r.block.map((x) => x.code), r.record.map((x) => x.code)], [["conformance.unimplemented"], ["x"]]);
    assert.equal(blockingFailures([f("conformance.unimplemented")], { shadow: true, allow: ALLOW, kinds: { "conformance.unimplemented": "shadow" } }).block.length, 0);
  });
  it("a deliver requirement with no executed evidence test is unverified, with its id", () => {
    const c = {
      requirements: [{ id: "R1", disposition: "deliver" }, { id: "R2", disposition: "deliver" }, { id: "R3", disposition: "deliver" }, { id: "R4", disposition: "defer" }, { id: "R5", disposition: "deliver", verify: "out_of_band" }],
      deliverables: [{ id: "D1", path: "src/a.js", requirements: ["R1"] }, { id: "D2", path: "test/a.test.js", requirements: ["R1"] }, { id: "D3", path: "test/b.test.js", requirements: ["R2"] }],
      validate: [{ id: "V1", command: "node --test test/a.test.js" }, { id: "V2", command: "node --test test/b.test.js" }],
    };
    const u = (o) => unverifiedRequirements(c, o).map((x) => x.id);
    assert.deepEqual(u({ runs: [{ id: "V1", exit: 0 }, { id: "V2", exit: 1 }] }), ["R2", "R3"]);
    assert.deepEqual(u({ runs: [{ id: "V1", exit: 1 }], reruns: { V1: { rc: 0 }, V2: { rc: 0 } } }), ["R3"]);
    assert.deepEqual(u({ runs: [], ciCovered: ["V1", "V2"] }), ["R3"]);
    assert.deepEqual(u({ runs: [{ id: "V1", exit: 0 }, { id: "V2", exit: 0 }], reruns: { V2: { rc: 1 } } }), ["R2", "R3"]);
  });
  it("formatShadowSummary adds per-kind shares only when rows carry kinds", () => {
    const rows = [{ conformance: { mode: "shadow", would: "nonconforming", kinds: ["a.b"] } }, { conformance: { mode: "shadow", would: "conforms", kinds: [] } }];
    assert.match(formatShadowSummary(rows), /; per kind: a\.b 1\/2 \(50%\)$/);
    assert.doesNotMatch(formatShadowSummary([{ conformance: { mode: "shadow", would: "conforms" } }]), /per kind/);
  });
});

import { mutationTargets, mutationFailures, runMutationCheck, MUTATION_SURVIVED } from "./conformance.mjs";
import { alreadyFixedOnBase, sourceDeliverableFailures } from "./conformance.mjs";

describe("mutation check (#4913)", () => {
  const c = {
    requirements: [{ id: "R1", quote: "q1", disposition: "deliver" }, { id: "R2", quote: "q2", disposition: "deliver" }, { id: "R3", quote: "q3", disposition: "deliver", verify: "out_of_band", evidence: "job" }],
    deliverables: [{ id: "D1", path: "test/a.test.js", requirements: ["R1", "R3"] }, { id: "D2", path: "src/b.js", requirements: ["R2"] }],
    validate: [{ id: "V1", command: "node --test test/a.test.js" }],
  };
  const green = { runs: [{ id: "V1", exit: 0 }] };
  it("targets only deliver requirements whose evidence test ran green", () => {
    assert.deepEqual(mutationTargets(c, green), [{ id: "R1", commands: [{ id: "V1", command: "node --test test/a.test.js" }] }]);
    assert.deepEqual(mutationTargets(c, { runs: [{ id: "V1", exit: 1 }] }), []);
  });
  it("only a survivor fails; killed and skipped never do", () => {
    const f = mutationFailures([{ id: "R1", command: "x", status: "survived" }, { id: "R2", command: "y", status: "killed" }, { id: "R4", command: "z", status: "skipped" }]);
    assert.equal(f.length, 1); assert.equal(f[0].code, MUTATION_SURVIVED); assert.match(f[0].detail, /^R1 /);
  });
  const harness = (o = {}) => {
    const calls = [], fs = { writeFileSync() {}, rmSync() {} };
    let restored = false;
    const git = async (a) => { calls.push(a.join(" ")); if (a[0] === "reset") restored = true; if (a[0] === "status") return restored ? (o.stillDirty ?? "") : (o.dirty ?? ""); if (a[0] === "apply" && o.applyFails) throw new Error("no"); return "patch"; };
    const runCommand = async () => { calls.push("run"); if (o.throws) throw new Error("boom"); return { rc: o.rc ?? 0 }; };
    const targets = mutationTargets(c, green);
    return { calls, go: () => runMutationCheck({ targets, files: ["src/b.js", "test/a.test.js"], base: "origin/staging", git, runCommand, cwd: "/w", fs, tmp: "/t" }) };
  };
  it("reverts only non-test files, reruns, then restores from HEAD (reset + clean of those paths)", async () => {
    const h = harness(); const r = await h.go();
    assert.deepEqual(r.results.map((x) => x.status), ["survived"]);
    assert.ok(h.calls.some((x) => x.startsWith("diff --binary origin/staging...HEAD -- src/b.js") && !x.includes("test/a")));
    assert.deepEqual(h.calls.filter((x) => /^(apply|run|reset|clean)/.test(x)), ["apply -R --whitespace=nowarn /t/mutation-" + process.pid + ".patch", "run", "reset -q --hard HEAD", "clean -fdq -- src/b.js"]);
  });
  it("a failing rerun is killed; the tree is restored even when the command throws", async () => {
    assert.equal((await harness({ rc: 1 }).go()).results[0].status, "killed");
    const h = harness({ throws: true }); assert.equal((await h.go()).results[0].status, "skipped");
    assert.equal(h.calls.at(-1), "status --porcelain -- src/b.js");
  });
  it("a dirty tree or a failed revert skips without running anything or restoring", async () => {
    for (const o of [{ dirty: " M src/b.js" }, { applyFails: true }]) { const h = harness(o); const r = await h.go(); assert.deepEqual(r.results, []); assert.ok(r.skipped); assert.ok(!h.calls.includes("run") && !h.calls.some((x) => x.startsWith("reset"))); }
  });
  it("#4931: a tree still dirty after the restore throws instead of returning (never push the reverted change)", async () => {
    await assert.rejects(harness({ stillDirty: "?? src/b.js" }).go(), /could not restore the worktree: \?\? src\/b\.js/);
  });
  it("#4931: a real repo whose change deleted a non-test file is fully restored", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpDir } = await import("../tests/_tmp.mjs");
    const d = tmpDir("mut-");
    const g = (...a) => execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main"); writeFileSync(join(d, "a.js"), "a1\n"); writeFileSync(join(d, "b.js"), "b\n"); g("add", "."); g("commit", "-qm", "base");
    g("checkout", "-qb", "lane"); writeFileSync(join(d, "a.js"), "a2\n"); g("rm", "-q", "b.js"); g("add", "a.js"); g("commit", "-qm", "change");
    const r = await runMutationCheck({ targets: [{ id: "R1", commands: [{ id: "V1", command: "t" }] }], files: ["a.js", "b.js"], base: "main",
      git: async (a) => g(...a), runCommand: async () => ({ rc: 1 }), cwd: d, tmp: d });
    assert.equal(r.skipped, "", r.skipped); assert.equal(r.results[0].status, "killed");
    assert.equal(readFileSync(join(d, "a.js"), "utf8"), "a2\n"); assert.equal(existsSync(join(d, "b.js")), false);
    assert.equal(g("status", "--porcelain").trim(), "");
  });
});

describe("builder amendment slips (#5036)", () => {
  it("deferral-shaped kinds naming a requirement apply as a tracked defer", () => {
    for (const kind of ["scope_narrowing", "scope_reduction", "defer-verification", "deferred_measurement", "Scope-Narrowing"]) {
      const a = applyAmendments(C, [{ kind, requirement: "R1", why: "w" }]);
      assert.deepEqual(a.problems, [], kind);
      assert.equal(a.contract.requirements.find((r) => r.id === "R1").disposition, "defer", kind);
      assert.deepEqual(a.toTrack.map((r) => r.id), ["R1"], kind);
    }
    assert.match(applyAmendments(C, [{ kind: "scope_narrowing", why: "w" }]).problems[0], /unknown kind 'scope_narrowing'; valid kinds are/);
  });
  it("verification_substitution applies as substitute-validate with the same checks", () => {
    const base = { requirements: [], validate: [{ id: "V2", command: "poetry run pytest" }] };
    const ok = applyAmendments(base, [{ kind: "verification_substitution", validate: "V2", command: "node --test t.mjs", why: "no poetry" }]);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.contract.validate[0].command, "node --test t.mjs");
    assert.equal(ok.contract.validate[0].substituted.from, "poetry run pytest");
    for (const command of ["echo (oops", "true", "git diff origin/main"]) {
      assert.equal(applyAmendments(base, [{ kind: "verification_substitution", validate: "V2", command, why: "w" }]).problems.length, 1, command);
    }
    assert.match(applyAmendments(base, [{ kind: "verification_substitution", why: "w" }]).problems[0], /needs validate/);
  });
  it("out_of_band_verification marks a deliver requirement out_of_band with its evidence", () => {
    const ok = applyAmendments(C, [{ kind: "out_of_band_verification", requirement: "R1", evidence: ".github/workflows/perf.yml", why: "field metric" }]);
    assert.deepEqual(ok.problems, []);
    const r = ok.contract.requirements.find((x) => x.id === "R1");
    assert.equal(r.verify, "out_of_band"); assert.equal(r.evidence, ".github/workflows/perf.yml");
    assert.equal(applyAmendments(C, [{ kind: "out_of_band_verification", requirement: "R1", why: "w" }]).problems.length, 1);
  });
  it("annotation-only kinds are informational: recorded, no problem, no contract change", () => {
    for (const kind of ["scope-note", "scope_clarification", "interpretation", "environment", "scope", "validation_unavailable"]) {
      const a = applyAmendments(C, [{ kind, note: "n" }, { kind, why: "w" }]);
      assert.deepEqual(a.problems, [], kind);
      assert.deepEqual(a.contract, C, kind);
      assert.equal(a.applied.length, 2, kind);
    }
  });
  it("a truly unknown kind is still rejected with the valid kinds", () => {
    assert.match(applyAmendments(C, [{ kind: "flaky-note", why: "w" }]).problems[0], /unknown kind 'flaky-note'; valid kinds are .*substitute-validate/);
  });
});

describe("#5020 freeze-time environment defects", () => {
  const base = { requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], validate: [{ id: "V1", command: "cd services/api && poetry run pytest tests/x.py" }, { id: "V2", command: "node --test a.test.mjs" }], repro_test: { path: "t.py", id: "t", command: "cd services/api && poetry run pytest t.py" } };
  const recipes = [{ match: "poetry run pytest", replace: "uv run --with-requirements r.txt pytest" }];

  it("applyValidateRecipes rewrites matching validate and repro commands and leaves the rest", () => {
    const { contract, applied } = applyValidateRecipes(base, recipes);
    assert.equal(contract.validate[0].command, "cd services/api && uv run --with-requirements r.txt pytest tests/x.py");
    assert.equal(contract.validate[1].command, "node --test a.test.mjs");
    assert.match(contract.repro_test.command, /uv run --with-requirements r\.txt pytest t\.py/);
    assert.deepEqual(applied.map((a) => a.id), ["V1", "repro_test"]);
    assert.equal(base.validate[0].command.includes("poetry"), true, "input is not mutated");
  });
  it("applyValidateRecipes ignores no recipes and invalid regexes", () => {
    assert.equal(applyValidateRecipes(base, null).contract, base);
    assert.equal(applyValidateRecipes(base, [{ match: "(", replace: "x" }]).applied.length, 0);
  });
  it("Poetry's missing-env output is env.tool_missing material, and a repro head that dies on it is an env miss", () => {
    const run = { rc: 1, output: "Creating virtualenv api-py3.12\n\nCommand not found: pytest\n" };
    assert.deepEqual(missingTool(run), { tool: "pytest", kind: "command" });
    assert.deepEqual(reproEnvMiss(run), { tool: "pytest", kind: "command" });
    assert.equal(reproEnvMiss({ rc: 1, output: "1 failed" }), null);
    // release review BUG-1: a module the repo tracks is a real failure of the change, not an env miss
    const mod = { rc: 1, output: "ModuleNotFoundError: No module named 'mypkg'" };
    assert.deepEqual(reproEnvMiss(mod, { command: "pytest t.py" }), { tool: "mypkg", kind: "python-module" });
    assert.equal(reproEnvMiss(mod, { command: "pytest t.py", repoHas: repoTracks(["src/mypkg/__init__.py"]) }), null);
    assert.equal(reproEnvMiss({ rc: 0, output: "" }), null);
  });
  it("a post-deploy requirement with no check id is deferred to the orchestrator; one with a check is untouched", () => {
    const c = { requirements: [{ id: "R1", quote: "q", disposition: "post-deploy", why: "needs prod creds" }, { id: "R2", quote: "q", disposition: "post-deploy", check: "login-smoke", why: "w" }] };
    const { contract, converted } = deferChecklessPostDeploy(c);
    assert.deepEqual(converted, ["R1"]);
    assert.equal(contract.requirements[0].disposition, "defer");
    assert.equal(contract.requirements[0].bucket, ORCHESTRATOR_BUCKET);
    assert.equal(contract.requirements[1].disposition, "post-deploy");
    assert.deepEqual(bucketProblems(contract.requirements[0]), []);
  });
  it("a post-deploy amendment with no check becomes a tracked defer instead of a problem", () => {
    const c = { requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], deliverables: [], validate: [] };
    const r = applyAmendments(c, [{ kind: "post-deploy", requirement: "R1", why: "manual prod action" }], "q");
    assert.deepEqual(r.problems, []);
    assert.equal(r.contract.requirements[0].disposition, "defer");
    assert.equal(r.contract.requirements[0].bucket, ORCHESTRATOR_BUCKET);
  });
  it("a substitute-validate that is not valid shell is rejected", () => {
    assert.match(substituteShellProblem("pytest tests/ && ("), /./);
    assert.equal(substituteShellProblem("pytest tests/"), null);
    const c = { requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], deliverables: [], validate: [{ id: "V1", command: "poetry run pytest" }] };
    const r = applyAmendments(c, [{ kind: "substitute-validate", validate: "V1", command: "uv run pytest tests/ && (", why: "poetry env missing" }], "q");
    assert.ok(r.problems.some((p) => /not valid shell/.test(p)));
    assert.equal(r.contract.validate[0].command, "poetry run pytest");
  });
});

describe("#5087 a plan decision may not weaken an e2e/integration criterion to mocked tests", () => {
  const K2 = { id: "K2", choice: "No Playwright e2e; integration coverage via route and component tests with mocked getServerSession and fetch", justification: "web/e2e needs a live stack", source: "precedent" };
  it("rejects the K2 wording of AlterLab#38180 at contract validation", () => {
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [K2] }), ["K2"]);
    const v = validateContract({ ...C, decisions: [K2] }, ISSUE);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.startsWith("K2:") && p.includes("forge-probe")), v.problems.join("|"));
  });
  it("accepts it when an acceptance probe is declared, in the decision or elsewhere in the contract", () => {
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ ...K2, justification: "a forge-probe acceptance probe runs the flow after promotion" }] }), []);
    assert.deepEqual(weakenedE2eDecisions({ ...C, deliverables: [...C.deliverables, { id: "D9", path: "x.md", change: "declare a forge-probe block" }], decisions: [K2] }), []);
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ ...K2, justification: "no acceptance probe" }] }), ["K2"]);
  });
  it("#5116 negated or strengthening wording is not a weakening; real weakenings still are", () => {
    for (const choice of ["Run the Playwright e2e suite against the live stack; do not mock the API", "Integration tests use fake timers, no sleeps", "E2E check hits the real server rather than a stubbed one"]) {
      const c = { ...C, decisions: [{ id: "K1", choice, source: "doc" }] };
      assert.deepEqual(weakenedE2eDecisions(c), [], choice);
      assert.ok(!validateContract(c, ISSUE).problems.some((p) => p.startsWith("K1:")), choice);
    }
    for (const choice of ["No Playwright e2e; integration coverage via route and component tests", "Replace the e2e test with mocked unit tests", "Skip e2e, use vitest instead", "Use mocked unit tests instead of the e2e check"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), ["K1"], choice);
    }
  });
  it("#5130 double negatives and word prefixes are not weakenings; trailing negations and distant weakeners are", () => {
    for (const choice of ["Do not skip the e2e suite; mock the mailer", "E2E tests are not replaced by mocks", "Skip the e2e run for billing units", "No integration with United Airlines API", "Skip e2e; ship the Unity build"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), [], choice);
    }
    for (const choice of ["Mock everything; the e2e suite is not needed", "e2e is not run, jest mocks cover it", "e2e tests are not required, rely on mocked unit tests", "e2e suite no longer runs; mocks used", "Skip the slow flaky nightly e2e and use mocks", "Use stubbed unit tests, e2e not needed"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), ["K1"], choice);
    }
  });
  it("#5145 unittest/unittests and substitute units are mocks; a negator across a preposition is not a weakener", () => {
    for (const choice of ["Replace e2e with unittest cases", "Skip e2e, covered by unittests", "e2e dropped, use units", "Use unittest cases instead of the e2e check"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), ["K1"], choice);
    }
    for (const choice of ["Keep playwright e2e coverage; add unit tests (no new fixtures needed for e2e)"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), [], choice);
    }
  });
  it("#5157 negated verbs and bare negators before a preposition still weaken e2e", () => {
    for (const choice of ["We do not need to run e2e; mocked route tests cover it", "will not rely on e2e, mock the API", "not with e2e: unit tests used", "not for e2e, unit tests used", "no need to run e2e; mocks cover it", "no need for e2e, mocks cover it"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), ["K1"], choice);
    }
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice: "Keep playwright e2e coverage; add unit tests (no new fixtures needed for e2e)", source: "doc" }] }), []);
  });
  it("#5184 a negated omission verb keeps e2e and is not flagged", () => {
    for (const choice of ["Mocked the gateway with stubs; will not forget to add the e2e test", "Mocked the gateway with stubs; not going to forget to add the e2e test", "Mocked the gateway with stubs; never intending to skip the e2e test", "Stubs for the API; will not fail to run e2e", "Mocks used; never omit the e2e test"]) {
      assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice, source: "doc" }] }), [], choice);
    }
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice: "We do not need to run e2e; mocked route tests cover it", source: "doc" }] }), ["K1"]);
  });
  it("leaves unrelated decisions and contracts without decisions alone", () => {
    assert.deepEqual(weakenedE2eDecisions(C), []);
    assert.deepEqual(weakenedE2eDecisions({ ...C, decisions: [{ id: "K1", choice: "Run the Playwright e2e suite against the live stack", source: "doc" }, { id: "K3", choice: "Use unit tests with mocks for the parser", source: "spec" }] }), []);
    assert.deepEqual(validateContract({ ...C, decisions: [{ id: "K1", choice: "copy the recipes pattern", source: "precedent" }] }, ISSUE), { ok: true, problems: [] });
  });
  it("precheck appends routeFailures as blocking failures; absent keeps today's behaviour", () => {
    const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
    assert.equal(precheck({ contract: C, result: res, changedFiles: files }).ok, true);
    assert.equal(precheck({ contract: C, result: res, changedFiles: files, routeFailures: [] }).ok, true);
    const pc = precheck({ contract: C, result: res, changedFiles: files, routeFailures: [{ code: "conformance.unimplemented", kind: "route_unreachable", detail: "x" }] });
    assert.equal(pc.ok, false);
    assert.deepEqual(pc.failures.map((f) => f.kind), ["route_unreachable"]);
  });
  it("#4726 [type:e2e] behaviour is unchanged", () => {
    assert.equal(isE2eCommand("node --test test/leak.test.js"), false);
    assert.equal(isE2eCommand("npx playwright test"), true);
  });
});

describe("amendmentKindProblems (#5089)", () => {
  it("flags the invented deliverable_change kind and names the valid kinds", () => {
    const p = amendmentKindProblems([{ kind: "deliverable_change", requirement: "R1", why: "no Linux build" }]);
    assert.equal(p.length, 1);
    assert.match(p[0], /unknown kind 'deliverable_change'; valid kinds are .*defer/);
  });
  it("accepts valid kinds, normalised slips and informational kinds", () => {
    assert.deepEqual(amendmentKindProblems([{ kind: "defer", requirement: "R1", why: "w" }, { type: "limitation", requirement: "R2", why: "w" }, { kind: "scope-note", why: "w" }, { kind: "add-deliverable", path: "a.js", why: "w" }]), []);
    assert.deepEqual(amendmentKindProblems(undefined), []);
  });
  it("flags a missing path or requirement", () => {
    assert.equal(amendmentKindProblems([{ kind: "add-deliverable", why: "w" }, { kind: "defer", why: "w" }]).length, 2);
  });
});

// Release review of #5103: MAT-1/REG-1 (non-code fixes are never "already fixed") and the read-only-prod routing theme
// (SPEC-1, SEC-4, AUTH-1, BUG-2/3, QA-3, MAT-7, REG-4).
import { READONLY_PROD_RE as RO5103, EXTERNAL_NEED_RE as EX5103, ownerRoute as route5103, alreadyFixedOnBase as afb5103 } from "./conformance.mjs";
describe("release review #5103", () => {
  const green = [{ kind: "repro_base_green" }, { kind: "source_deliverable_untouched" }];
  it("a lane that changed css/json/yaml/sql/vue/tf is never closed as already fixed on base", () => {
    for (const f of ["web/app.css", "config/limits.json", "deploy/values.yaml", "db/0042.sql", "web/App.vue", "infra/main.tf", "web/index.html"]) {
      assert.equal(afb5103(green, [f, "test/x.test.js"]), false, f);
    }
  });
  it("tests and docs only still close as already fixed", () => {
    assert.equal(afb5103(green, ["test/x.test.js", "docs/a.md", "devdocs/x.mdx"]), true);
  });
  const host = (why) => RO5103.test(why) && !EX5103.test(why);
  it("read-only production telemetry, captures and queries route to host", () => {
    for (const why of ["read-only production telemetry from ovh", "ssh ovh-monitor to capture the queue", "obs-psql query of prod", "run a production query against the replica", "capture production logs for the run"]) assert.equal(host(why), true, why);
  });
  it("owner asks, writes, credentials and product wording stay external", () => {
    for (const why of ["Should we delete production data older than 90 days?", "add uptime-monitor dashboard", "needs the production database password to query prod data",
      "needs the prod ssh key to read production logs", "product manager decides the pricing", "production dataset retention policy", "drop the production table after the capture"]) {
      assert.equal(host(why), false, why);
    }
    assert.equal(route5103({ bucket: "owner:decide", why: "Should we delete production data older than 90 days?" }), "external");
  });
  it("#5115: production-mutating verbs naming a prod monitor stay external, never host", () => {
    for (const why of ["ssh ovh-monitor and restart the worker", "rotate the prod monitor webhook", "update the production telemetry config",
      "remove the stale prod monitor alert", "grant read-only prod access to the analyst", "alter the production query timeout"]) {
      assert.equal(RO5103.test(why), true, `read-only prod phrase: ${why}`);
      assert.equal(host(why), false, why);
      assert.equal(route5103({ bucket: "owner:x", why }), "external", why);
    }
  });
});

import { hostRoute as hostRoute5197 } from "./conformance.mjs";
describe("#5197 hostRoute is exported as the single host-route source", () => {
  it("post-promotion text joins the rollup; pre-promotion and external needs stay host", () => {
    assert.equal(hostRoute5197({ bucket: "host", why: "verify the dashboard after release" }), "post-deploy");
    assert.equal(hostRoute5197({ bucket: "host", why: "capture logs before promotion" }), "host");
    assert.equal(hostRoute5197({ bucket: "host", why: "provide the API key after release" }), "host");
  });
});

import { intakeHostWork } from "./conformance.mjs";
describe("#5250 intakeHostWork", () => {
  const body = (...items) => `## Problem\nx\n\n## Acceptance Criteria\n\n${items.map((t) => `- [ ] ${t}`).join("\n")}\n`;
  it("matches when every criterion needs live production measurement or a real-browser capture", () => {
    const r = intakeHostWork(body("Measured clear rate on live production traffic is above 50%", "Root-cause capture from a real browser is attached"));
    assert.equal(r.host, true); assert.equal(r.items.length, 2);
  });
  it("one code-shaped criterion keeps a code lane", () => {
    assert.equal(intakeHostWork(body("Measured clear rate on live production traffic is above 50%", "The retry guard stops after a rejection")).host, false);
  });
  it("code-only, credential-needing, checklist-less and empty bodies do not match", () => {
    assert.equal(intakeHostWork(body("The retry guard stops after a rejection")).host, false);
    assert.equal(intakeHostWork(body("Measure live production latency using the API key")).host, false);
    assert.equal(intakeHostWork("## Acceptance\nmeasured on live production").host, false);
    assert.equal(intakeHostWork("").host, false); assert.equal(intakeHostWork(null).host, false);
  });
  it("a backlog aggregate that merely quotes such text is not host work", () => {
    assert.equal(intakeHostWork("## Acceptance Criteria\n\n### #5240\n<!-- FORGE:DEFERRED_FROM: #5240 -->\n\n- [ ] classify issues whose acceptance requires live production measurement or real-browser captures as host work\n").host, false);
  });
});

describe("contract quote snapping (#5244)", () => {
  const LINE = "- Add `SLI_CONCENTRATION_MIN_REST_EVENTS` (default 30 per window, documented in `config.env.example`). Below it, publish no signal.";
  const ISS = `## Problem\n\n${LINE}\n- Remove the legacy **alert** path entirely from the worker.\n- Remove the legacy alert path entirely from the scheduler.\n`;
  it("markdown inline code spans, elision and spaced identifiers all match", () => {
    assert.ok(inIssue("Add `SLI_CONCENTRATION_MIN_REST_EVENTS` (default 30 per window, documented in `config.env.example`).", ISS));
    assert.ok(inIssue("Add SLI_CONCENTRATION_MIN_REST_EVENTS (default 30 per window, documented in config.env.example). Below it, publish...", ISS));
    assert.ok(inIssue("Add `SLI_CONCENTRATION_MIN_REST_EVENTS` (default 30 per window, documented in `config.env.example`). Below it, publish…", ISS));
    assert.ok(inIssue("Add SLI CONCENTRATION MIN REST EVENTS (default 30 per window", ISS));
    assert.ok(!inIssue("Add SLI_CONCENTRATION_MIN_REST_EVENTS (default 99 per window", ISS));
  });
  it("a near-verbatim quote snaps to the one issue line and records the original", () => {
    const q = "Add the SLI_CONCENTRATION_MIN_REST_EVENTS (default 30 per window, documented in config.env.example)";
    assert.ok(!inIssue(q, ISS));
    const c = { requirements: [{ id: "R2b", quote: q, disposition: "deliver" }] };
    const { contract, snapped } = snapQuotes(c, ISS);
    assert.equal(snapped.length, 1);
    assert.ok(contract.requirements[0].quote.includes("`SLI_CONCENTRATION_MIN_REST_EVENTS`"));
    assert.equal(contract.requirements[0].requoted, q);
    assert.ok(inIssue(contract.requirements[0].quote, ISS));
  });
  it("an ambiguous or dissimilar quote does not snap", () => {
    assert.equal(snapQuote("Remove the legacy alert path entirely from the service", ISS), null);
    assert.equal(snapQuote("Publish a completely different dashboard widget for billing", ISS), null);
    assert.equal(snapQuotes({ requirements: [{ id: "R1", quote: "totally unrelated words about something else here" }] }, ISS).snapped.length, 0);
  });
});

describe("#5345 an incomplete reviewer reply is repaired in place", () => {
  it("every row-level gap is re-askable and the repaired rows merge into the first reply (no new review round)", () => {
    for (const p of ["R2: status invalid: maybe", "R1: a defer requirement needs deferral_ok true|false (is deferring it justified?)", "changed file a.js has no scope row", "preserve P1 needs a row with status intact|violated|unverified", "verdict must be CONFORMS or NONCONFORMING"]) assert.ok(reaskable([p]), p);
    const merged = mergeReviewRows({ verdict: "CONFORMS", requirements: [{ id: "R1", status: "implemented" }] }, { requirements: [{ id: "R2", status: "implemented" }] });
    assert.deepEqual(merged.requirements.map((r) => r.id), ["R1", "R2"]);
  });
});

describe("#5339 a faked or deferred e2e/manual requirement is not met", () => {
  const Q = "Users can render the launch film end to end [type:e2e]";
  const mk = (cmd, quote, extra = {}, disposition = "deliver") => {
    const contract = { ...C, requirements: [{ id: "R1", quote, disposition, ...extra }, C.requirements[1]], validate: [{ id: "V1", command: cmd }] };
    return { contract, ctx: { ...ctx, contract } };
  };
  const rv = (contract) => ({ ...good, issue_coverage: [{ quote: contract.requirements[0].quote, status: "covered" }, ...good.issue_coverage.slice(1)] });
  const run = (cmd, quote, e2e, disposition, row = {}) => { const m = mk(cmd, quote, {}, disposition); const r = rv(m.contract); r.requirements = [{ ...r.requirements[0], ...row }, ...r.requirements.slice(1)]; return decide(r, { ...m.ctx, issueText: `${ISSUE}\n${quote}`, e2e }); };
  it("a validate that names a faked test is not an e2e run, even with e2e in its name (spectracut #63 replay)", () => {
    const d = run("node --test tests/e2e/film.e2e.test.mjs", Q, { faked: ["tests/e2e/film.e2e.test.mjs"] });
    assert.equal(d.state, "nonconforming");
    assert.deepEqual(codes(d), ["conformance.e2e_unverified"]);
    assert.equal(d.failures[0].kind, "e2e_row");
    assert.equal(run("node --test tests/e2e/film.e2e.test.mjs", Q, { faked: [] }).state, "conforms");
    assert.equal(run("make film", Q, { checks: ["make film"], faked: ["make film"] }).state, "conforms", "a configured e2e check is always real");
  });
  it("[type:manual] is judged like [type:e2e]; a deferred e2e row fails, a post-deploy one is transferred", () => {
    assert.deepEqual(codes(run("pytest tests/test_x.py", "Operators can restore a backup [type:manual]")), ["conformance.e2e_unverified"]);
    assert.equal(codes(run("pytest tests/test_x.py", Q, undefined, "defer", { status: "deferred", deferral_ok: true })).includes("conformance.e2e_unverified"), true);
    assert.equal(codes(run("pytest tests/test_x.py", Q, undefined, "post-deploy", { status: "post-deploy" })).includes("conformance.e2e_unverified"), false);
  });
  it("e2e_unverified of the e2e row blocks by default; forge.yaml conformance_kinds overrides; other kinds follow the lane", () => {
    const fs = [{ code: "conformance.e2e_unverified", kind: "e2e_row" }, { code: "conformance.e2e_unverified", kind: "ui_browser_unverified" }];
    assert.deepEqual(blockingFailures(fs, { shadow: true }).block.map((f) => f.kind), ["e2e_row"]);
    assert.deepEqual(blockingFailures(fs, { shadow: true, kinds: { "conformance.e2e_unverified": "shadow" } }).block, []);
  });
  it("closePlan: a transferred e2e/manual requirement closes partial, never completed", () => {
    const k = { requirements: [{ id: "R1", quote: Q, disposition: "post-deploy", tracked: "#9" }] };
    const p = closePlan(k);
    assert.equal(p.reason, "partial");
    assert.equal(p.transferred, true);
    assert.deepEqual(p.open.map((r) => r.id), ["R1"]);
    assert.equal(closePlan({ requirements: [{ id: "R1", quote: "A plain thing [type:unit]", disposition: "post-deploy" }] }).reason, "completed");
  });
  it("#5365 add-requirement id collision is renumbered to the next free R<n> and recorded, never a problem", () => {
    const add = (id) => ({ kind: "add-requirement", requirement: { id, quote: "Billing pricing is unchanged.", disposition: "deliver" }, why: "missed" });
    const a = applyAmendments(C, [add("R2"), add("R2")], ISSUE);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(a.contract.requirements.map((r) => r.id), ["R1", "R2", "R3", "R4"]);
    assert.ok(a.applied.some((x) => x.target === "R2 -> R3") && a.applied.some((x) => x.target === "R2 -> R4"));
    assert.equal(applyAmendments(C, [add("R9")], ISSUE).applied[0].target, "R9");
  });
  it("#5365 a file coupled to a deliverable (outcome-codes.mjs <-> docs/OUTCOME-CODES.md) is not scope creep; an unrelated doc still is", () => {
    const k = { ...C, deliverables: [{ id: "D1", path: "bin/engine/outcome-codes.mjs" }] };
    const run = (f) => precheck({ contract: k, result: { requirements: [], validation: [{ id: "V1", exit: 0 }] }, changedFiles: ["bin/engine/outcome-codes.mjs", f] }).failures.map((x) => x.kind);
    assert.equal(run("docs/OUTCOME-CODES.md").includes("scope_creep"), false);
    assert.ok(run("docs/OTHER.md").includes("scope_creep"));
    const none = precheck({ contract: C, result: { requirements: [], validation: [] }, changedFiles: ["docs/OUTCOME-CODES.md"] }).failures.map((x) => x.kind);
    assert.ok(none.includes("scope_creep"), "coupling needs the paired deliverable");
    const dctx = { ...ctx, contract: k, changedFiles: ["bin/engine/outcome-codes.mjs", "docs/OUTCOME-CODES.md"] };
    const kr = { ...good, requirements: [good.requirements[0], good.requirements[1]], scope: [{ file: "bin/engine/outcome-codes.mjs", authorized_by: "D1" }, { file: "docs/OUTCOME-CODES.md", authorized_by: "none" }] };
    assert.ok(!decide(kr, dctx).failures.some((f) => f.code === "conformance.scope_creep"));
  });
  it("#5365 a defer row the review finds implemented converts to deliver instead of unjustified_deferral; an undelivered one still fails", () => {
    const k = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w", bucket: "owner:rotate the key" }] };
    const c2 = { ...ctx, contract: k };
    const rv = (extra) => ({ ...good, requirements: [good.requirements[0], { id: "R2", ...extra }] });
    const d = decide(rv({ status: "implemented", evidence: "src/search.js:7", validated_by: "V1", deferral_ok: false, note: "replay already ships" }), c2);
    assert.deepEqual(codes(d), []);
    assert.deepEqual(d.converted, [{ id: "R2", evidence: "src/search.js:7" }]);
    const conv = convertDelivered(k, d.converted).requirements[1];
    assert.equal(conv.disposition, "deliver"); assert.equal(conv.bucket, undefined); assert.equal(conv.amended_from.disposition, "defer");
    assert.deepEqual(codes(decide(rv({ status: "deferred", deferral_ok: false }), c2)), ["conformance.unjustified_deferral"]);
  });
});

import { contractBriefProblems as pageBriefProblems, parsePagesConfig as parsePagesCfg } from "./pagegate.mjs";
describe("page gate wiring (#5428)", () => {
  it("validateContract reports missing page_gate briefs and precheck carries pageFailures", () => {
    const pages = parsePagesCfg(undefined, { hasAppPages: true });
    const c = { requirements: [{ id: "R1", quote: "q", disposition: "deliver" }], deliverables: [{ id: "D1", path: "web/app/x/page.tsx", change: "c", requirements: ["R1"] }], validate: [] };
    assert.equal(pageBriefProblems(c, pages).length, 1);
    assert.ok(validateContract(c, "q", { pages }).problems.some((p) => /page_gate/.test(p)));
    assert.ok(!validateContract(c, "q").problems.some((p) => /page_gate/.test(p)));
    const pc = precheck({ contract: c, result: {}, changedFiles: [], pageFailures: [{ code: "x", kind: "page_sitemap_missing", detail: "d" }] });
    assert.ok(pc.failures.some((f) => f.kind === "page_sitemap_missing"));
  });
});

import { pathCovers as cover5440 } from "./conformance.mjs";
describe("#5440 pathCovers: directory without slash, renumbered sequence file", () => {
  it("#5440 directory deliverable without slash covers files beneath it", () => {
    assert.ok(cover5440("listings/official/travel", "listings/official/travel/agent.md"));
    assert.ok(cover5440("listings/official/travel", "listings/official/travel/a/b/page.md"));
    assert.ok(cover5440("listings/official/travel", "listings/official/travel"));
  });
  it("#5440 a sibling directory sharing the prefix is not covered", () => {
    assert.ok(!cover5440("listings/official/travel", "listings/official/travel2/agent.md"));
    assert.ok(!cover5440("listings/official/travel", "listings/official/jobs/agent.md"));
  });
  it("#5440 a renumbered migration is covered (exact and glob); other dirs and names are not", () => {
    assert.ok(cover5440("db/migrations/0637_add_x.sql", "db/migrations/0639_add_x.sql"));
    assert.ok(cover5440("db/migrations/0637_*", "db/migrations/0639_add_x.sql"));
    assert.ok(!cover5440("db/migrations/0637_add_x.sql", "db/migrations/0639_other.sql"));
    assert.ok(!cover5440("db/migrations/0637_*", "other/0639_add_x.sql"));
    assert.ok(!cover5440("src/a.js", "src/b.js"));
  });
});
