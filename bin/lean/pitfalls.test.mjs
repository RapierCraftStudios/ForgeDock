// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { failureLine, normaliseFailure, signatureOf, lessonOf, fixGlobs, pendingPitfall, pitfallRecord, foldPitfalls, selectPitfalls, failureLog,
  makePitfallStore, pitfallsFile, pitfallsDir, DEFAULT_PITFALL_LANES, LESSON_MAX } from "./pitfalls.mjs";

// Two ecosystems' failure output (#4375: the mechanism is generic, the data is each repo's own).
const NODE_ESLINT = (file, line) => `> app@1.0.0 lint\n> eslint .\n\n/home/u/wt/${file}\n  ${line}:5  error  'unused' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)`;
const NODE_TSC = "src/api/client.ts(41,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
const NODE_DOCS = "devdocs freshness: bin/lean/lean.mjs changed but devdocs/modules/lean.md did not (stale dossier)";
const PY_RUFF = (file, line) => `${file}:${line}:1: F401 [*] \`os\` imported but unused\nFound 1 error.\n[*] 1 fixable with the \`--fix\` option.`;
const PY_PYTEST = "============ FAILURES ============\n____ test_create_user ____\nE       AssertionError: assert 404 == 201\ntests/test_users.py:22: AssertionError\n==== 1 failed, 12 passed in 0.91s ====";
const PY_MIGRATION = "sequence number collision: migrations/0042_add_index.py already taken by migrations/0042_user_email.py";

describe("#4375 pitfall signatures and lessons", () => {
  it("picks the first error-like line, skipping banners and ANSI codes", () => {
    assert.match(failureLine(NODE_ESLINT("src/a.ts", 12)), /error 'unused' is defined but never used no-unused-vars/);
    assert.match(failureLine(`\x1b[31m${PY_RUFF("app/models.py", 3)}\x1b[0m`), /^app\/models\.py:3:1: F401/);
    assert.match(failureLine(PY_PYTEST), /AssertionError: assert 404 == 201/);
    assert.equal(failureLine("only info\nmore info"), "only info", "no error-like line: the first line");
    assert.equal(failureLine("\n \n"), "");
  });

  it("the same rule on another file or line gives the same signature; another rule or trigger does not", () => {
    assert.equal(signatureOf("precheck", NODE_ESLINT("src/a.ts", 12)), signatureOf("precheck", NODE_ESLINT("lib/b/c.ts", 380)));
    assert.equal(signatureOf("precheck", PY_RUFF("app/models.py", 3)), signatureOf("precheck", PY_RUFF("svc/api/views.py", 17)));
    assert.notEqual(signatureOf("precheck", PY_RUFF("app/models.py", 3)), signatureOf("precheck", PY_RUFF("app/models.py", 3).replace("F401", "E501")), "rule codes are kept");
    assert.notEqual(signatureOf("precheck", NODE_TSC), signatureOf("ci_red", NODE_TSC));
    assert.match(signatureOf("ci_red", NODE_TSC), /^ci_red:[0-9a-f]{12}$/);
    assert.equal(normaliseFailure("Error at src/x.ts:1:2 in deadbeefcafe after 30 s: \"foo\""), "error at <path> in <hex> after <n> s: <str>");
    assert.equal(signatureOf("sequence", PY_MIGRATION), signatureOf("sequence", PY_MIGRATION.replaceAll("0042", "0107")));
  });

  it("the lesson is one line from the failure output, prefixed with the trigger and capped", () => {
    assert.equal(lessonOf("docs", NODE_DOCS), `docs: ${NODE_DOCS}`);
    const long = lessonOf("precheck", `error ${"x".repeat(400)}\nsecond line`);
    assert.ok(long.length <= LESSON_MAX && !long.includes("\n") && long.endsWith("…"), long);
  });

  it("fix globs: dir/*.ext, root files by name, .forge-lean left out, at most five", () => {
    assert.deepEqual(fixGlobs(["src/a.ts", "src/b.ts", "package.json", ".forge-lean/result.json", "alembic/versions/0003_x.py", "Makefile", "docs/README"]),
      ["src/*.ts", "package.json", "alembic/versions/*.py", "Makefile", "docs/*"]);
    assert.equal(fixGlobs(Array.from({ length: 9 }, (_, i) => `d${i}/f.go`)).length, 5);
  });

  it("only rework triggers with failure text become pending pitfalls", () => {
    assert.deepEqual(Object.keys(pendingPitfall("precheck", NODE_TSC)), ["trigger", "sig", "lesson"]);
    for (const t of ["plan", "build", "block_correction", "ci_unavailable", "recovery", "timeout_restart"]) assert.equal(pendingPitfall(t, NODE_TSC), null, t);
    assert.equal(pendingPitfall("docs", ""), null);
    assert.match(failureLog([{ job: "lint", log: PY_RUFF("a.py", 1) }, { code: "review.finding", detail: "src/x.ts:3 misses the null check" }, "plain"]), /F401[\s\S]*review\.finding src\/x\.ts:3[\s\S]*plain/);
  });
});

describe("#4375 pitfall ledger: dedup, aging, selection", () => {
  const lane = (run) => ({ t: "lane", run, ts: `2026-10-${String(10 + (Number(String(run).replace(/\D/g, "")) % 20)).padStart(2, "0")}T00:00:00Z` });
  const pit = (run, trigger, text, files, ts = "2026-10-20T00:00:00Z") => pitfallRecord({ pending: pendingPitfall(trigger, text), files, run, ts });

  it("deduplicates by signature with a count (one per lane), union of globs, latest lesson", () => {
    const recs = [lane("r1"), pit("r1", "precheck", NODE_ESLINT("src/a.ts", 1), ["src/a.ts"]), pit("r1", "precheck", NODE_ESLINT("src/a.ts", 9), ["src/a.ts"]),
      lane("r2"), pit("r2", "precheck", NODE_ESLINT("web/b.tsx", 4), ["web/b.tsx"], "2026-10-21T00:00:00Z"), lane("r3"), pit("r3", "docs", NODE_DOCS, ["devdocs/modules/lean.md"])];
    const f = foldPitfalls(recs);
    assert.equal(f.length, 2);
    assert.deepEqual([f[0].trigger, f[0].count, f[0].globs, f[0].lastTs], ["precheck", 2, ["src/*.ts", "web/*.tsx"], "2026-10-21T00:00:00Z"]);
    assert.deepEqual([f[1].trigger, f[1].count, f[1].globs], ["docs", 1, ["devdocs/modules/*.md"]]);
    assert.equal(foldPitfalls([{ t: "pitfall" }, null, "x", { t: "pitfall", sig: "" }]).length, 0, "malformed rows are skipped");
  });

  it("a pitfall not seen in N lanes (default 50) ages out; a recurring one stays", () => {
    assert.equal(DEFAULT_PITFALL_LANES, 50);
    const recs = [lane("r0"), pit("r0", "precheck", PY_RUFF("app/m.py", 3), ["app/m.py"]), pit("r0", "ci_red", PY_PYTEST, ["tests/test_users.py"])];
    for (let i = 1; i <= 49; i++) recs.push(lane(`r${i}`));
    assert.equal(foldPitfalls(recs).length, 2, "49 lanes since: kept");
    recs.push(pit("r49", "ci_red", PY_PYTEST, ["tests/test_users.py"]), lane("r50"));
    const f = foldPitfalls(recs);
    assert.deepEqual(f.map((p) => p.trigger), ["ci_red"], "50 lanes without a recurrence: aged out; the recurring one stays");
    assert.equal(foldPitfalls(recs, { maxAge: 100 }).length, 2, "custom N");
    assert.equal(foldPitfalls(recs, { maxAge: 1 }).length, 0);
  });

  it("selects file matches first, then repo-wide, each by count then recency, up to the limit", () => {
    const recs = [lane("a"), pit("a", "docs", NODE_DOCS, ["devdocs/modules/lean.md"]), lane("b"), pit("b", "docs", NODE_DOCS, ["devdocs/modules/lean.md"]),
      lane("c"), pit("c", "precheck", PY_RUFF("app/models.py", 3), ["app/models.py"], "2026-10-01T00:00:00Z"),
      lane("d"), pit("d", "ci_red", PY_PYTEST, ["app/views.py"], "2026-10-05T00:00:00Z"), pit("d", "sequence", PY_MIGRATION, ["migrations/0042_add_index.py"])];
    const f = foldPitfalls(recs);
    const s = selectPitfalls(f, { paths: ["app/models.py", "app/serializers.py"] });
    assert.deepEqual(s.map((p) => [p.trigger, p.match]), [["ci_red", "files"], ["precheck", "files"], ["docs", "repo"], ["sequence", "repo"]]);
    assert.deepEqual(selectPitfalls(f, { paths: [], limit: 2 }).map((p) => p.trigger), ["docs", "sequence"], "no likely files: repo-wide by count, then recency (sequence 10-20 is newer than ci_red 10-05)");
    assert.equal(selectPitfalls([], { paths: ["x"] }).length, 0);
  });
});

describe("#4375 local file store", () => {
  it("is per repo under the pitfalls dir, appends one line per record and skips corrupt lines", () => {
    const dir = tmpDir("pitfalls-");
    const st = makePitfallStore({ dir });
    assert.deepEqual(st.read("o/r"), [], "missing file: empty");
    st.append("o/r", { t: "lane", run: "1" });
    st.append("o/r", { t: "pitfall", run: "1", sig: "docs:abc", trigger: "docs", globs: [], lesson: "docs: x" });
    st.append("acme/py-app", { t: "lane", run: "9" });
    appendFileSync(pitfallsFile("o/r", dir), "{not json\n");
    assert.equal(pitfallsFile("o/r", dir), join(dir, "o__r.jsonl"));
    assert.deepEqual(st.read("o/r").map((r) => r.t), ["lane", "pitfall"]);
    assert.deepEqual(st.read("acme/py-app"), [{ t: "lane", run: "9" }]);
    assert.ok(existsSync(join(dir, "acme__py-app.jsonl")));
    assert.equal(readFileSync(pitfallsFile("o/r", dir), "utf8").split("\n").filter(Boolean).length, 3);
    assert.equal(pitfallsFile("../../etc/x", dir).startsWith(dir), true, "the repo name cannot escape the dir");
  });

  it("defaults to ~/.forge/pitfalls with a FORGE_PITFALLS_DIR override", () => {
    assert.match(pitfallsDir({}), /[/\\]\.forge[/\\]pitfalls$/);
    assert.equal(pitfallsDir({ FORGE_PITFALLS_DIR: "/x/p" }), "/x/p");
  });
});
