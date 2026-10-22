// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateContract, applyAmendments, precheck, hotspotGrowth, reproFailures, isBugIssue, parseReview, checkCompleteness, decide, closePlan, isInvestigation, formatShadowSummary, followupItems, inIssue, isTestPath, normalizeEvidencePath, mergeReviewRows, reviewSkeleton, missingIds, resolveEvidencePath, movingBaseDiff, scopeText, evidencePathLine, evidencePathOnly, explainFailures, missingTool, repoTracks, tmpdirInputs, isScopeCheck, isPureScopeCheck, dropScopeValidates, tagOutOfBand, outOfBandRequirements, isOutOfBand, followupMap, VERIFY_MODES, OUT_OF_BAND_RE } from "./conformance.mjs";

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

describe("precheck (deterministic, no reviewer)", () => {
  const res = { requirements: [{ id: "R1", status: "implemented" }, { id: "R2", status: "implemented" }], validation: [{ id: "V1", exit: 0 }] };
  it("passes a complete, validated, in-scope change", () => assert.deepEqual(precheck({ contract: C, result: res, changedFiles: files }), { ok: true, failures: [], superseded: [] }));
  it("unauthorized file -> scope_creep; tests and ignored paths are always allowed", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: res, changedFiles: [...files, "src/billing.js", ".forge-lean/x", "tests/test_x.py", "pkg/foo_test.go"], ignore: [".forge-lean/"] })), ["conformance.scope_creep"]);
    for (const t of ["test/a.js", "src/a.test.ts", "tests/test_a.py", "a_test.go", "spec/a.spec.js"]) assert.ok(isTestPath(t), t);
    assert.ok(!isTestPath("src/testing.js"));
  });
  it("failed or missing validation -> unimplemented", () => {
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [{ id: "V1", exit: 1 }] }, changedFiles: files })), ["conformance.unimplemented"]);
    assert.deepEqual(codes(precheck({ contract: C, result: { ...res, validation: [] }, changedFiles: files })), ["conformance.unimplemented"]);
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
    const local = precheck({ contract: C, result: failed, changedFiles: files, repoHas: repoTracks(["src/leak/__init__.py"]), validateRuns: { V1: { rc: 1, output: "ModuleNotFoundError: No module named 'leak.core'" } } });
    assert.deepEqual(codes(local), ["conformance.unimplemented"], "a repo module the change did not create is a code defect");
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
    const k = { ...C, requirements: [C.requirements[0], { ...C.requirements[1], disposition: "defer", why: "w" }] };
    const c2 = { ...ctx, contract: k };
    const rv = (extra) => ({ ...good, requirements: [good.requirements[0], { id: "R2", status: "deferred", ...extra }] });
    assert.equal(decide(rv({}), c2).state, "review.incomplete");
    assert.equal(decide(rv({ deferral_ok: true }), c2).state, "conforms");
    assert.deepEqual(codes(decide(rv({ deferral_ok: false, note: "two lines in the same file" }), c2)), ["conformance.unjustified_deferral"]);
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
    assert.deepEqual(precheck({ contract: k, result: res, changedFiles: files, repro: { base: "FAILED", head: "RAN" } }), { ok: true, failures: [], superseded: [] });
    for (const repro of [{ base: "RAN", head: "RAN" }, { base: "SKIPPED", head: "FAILED" }, { base: "UNRUNNABLE", head: "RAN" }, { base: "SKIPPED", head: "RAN_NOTHING" }]) {
      const pc = precheck({ contract: k, result: res, changedFiles: files, repro });
      assert.deepEqual(pc.failures.map((f) => [f.code, f.kind]), [["conformance.unimplemented", "repro_red_green"]], JSON.stringify(repro));
      assert.match(pc.failures[0].detail, new RegExp(`BASE=${repro.base} HEAD=${repro.head}`));
    }
    assert.match(reproFailures(k, { base: "SKIPPED", head: "FAILED" })[0].detail, /HEAD=FAILED \(base not run: head did not pass\)$/);
    assert.doesNotMatch(reproFailures(k, { base: "RAN", head: "RAN" })[0].detail, /base not run/);
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
