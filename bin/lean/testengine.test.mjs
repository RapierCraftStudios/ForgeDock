// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  globRe, matchGlob, parseSuiteRule, parseTestsConfig, configHash, testFilesOf, jsSpecifiers, pyImports, buildGraph, selectTests,
  fullReason, planRun, testsFromCli, ledgerPath, RUN_ALL_DEFAULT,
} from "./testengine.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "testengine");
const walk = (dir, root = dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p, root) : [relative(root, p).split("\\").join("/")]; });
const repo = (name) => { const root = join(FIX, name), files = walk(root).sort(); return { root, files, read: (f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return null; } } }; };
const JS = repo("js-app"), PY = repo("py-app");
const cfg = (ci = {}) => parseTestsConfig({ selection: "shadow", ...ci });
const select = (r, changed, ci) => selectTests({ files: r.files, read: r.read, changed, cfg: cfg(ci) });

describe("globs", () => {
  it("matches segments, ** and basenames", () => {
    assert.ok(globRe("src/**/*.js").test("src/a.js"));
    assert.ok(globRe("src/**/*.js").test("src/x/y/a.js"));
    assert.ok(!globRe("src/*.js").test("src/x/a.js"));
    assert.ok(matchGlob("web/package.json", "package.json"), "a glob without a slash matches the basename anywhere");
    assert.ok(matchGlob(".github/workflows/ci.yml", ".github/**"));
    assert.ok(!matchGlob("src/a.test.js", "a?.test.js"));
    assert.ok(matchGlob("deploy/docker-compose.prod.yaml", "docker-compose*.y*ml"));
  });
});

describe("parseTestsConfig", () => {
  it("defaults to off, report-only quarantine and 50 runs", () => {
    const c = parseTestsConfig(undefined);
    assert.equal(c.selection, "off");
    assert.equal(c.quarantine, "report");
    assert.equal(c.graduateAfter, 50);
    assert.equal(c.graduateMinFailing, 1);
    assert.deepEqual(c.runAll, RUN_ALL_DEFAULT);
    assert.deepEqual(c.fullBranches, ["main", "master", "release/**"]);
    assert.deepEqual([c.suites, c.ignore, c.testGlobs, c.shards], [[], [], [], 0]);
  });
  it("reads the flattened ci.tests block from forge.yaml text, and junk keeps the defaults", () => {
    const y = parseForgeYaml('ci:\n  mode: local-first\n  tests:\n    selection: shadow\n    suites:\n      - "migrations/** => tests/integration/**"\n      - "broken entry"\n    ignore: ["**/*.md"]\n    graduate_after: 20\n    graduate_min_failing: 0\n    quarantine: non-blocking\n    shards: many\n');
    assert.equal(y.ci.mode, "local-first", "ci.tests keys never collide with the ci budget mode");
    const c = parseTestsConfig(y.ci);
    assert.equal(c.selection, "shadow");
    assert.deepEqual(c.suites, [{ when: ["migrations/**"], targets: ["tests/integration/**"] }]);
    assert.deepEqual(c.badSuites, ["broken entry"]);
    assert.deepEqual(c.ignore, ["**/*.md"]);
    assert.deepEqual([c.graduateAfter, c.graduateMinFailing, c.quarantine, c.shards], [20, 0, "non-blocking", 0]);
    assert.equal(parseTestsConfig({ selection: "always" }).selection, "off");
  });
  it("parses suite rules", () => {
    assert.deepEqual(parseSuiteRule("a/** b/*.sql => tests/x/** @e2e"), { when: ["a/**", "b/*.sql"], targets: ["tests/x/**", "@e2e"] });
    assert.equal(parseSuiteRule("a/** =>"), null);
    assert.equal(parseSuiteRule("a => b => c"), null);
  });
  it("hashes only what decides a selection", () => {
    assert.equal(configHash(cfg()), configHash(cfg({ graduate_after: 5, quarantine: "off", selection: "enforce" })));
    assert.notEqual(configHash(cfg()), configHash(cfg({ ignore: ["**/*.md"] })));
  });
});

describe("source scanning", () => {
  it("finds JS specifiers in every import form", () => {
    const src = 'import a from "./a.js";\nimport {\n  b,\n} from "./b";\nimport "./side.css";\nexport * from "./c";\nexport { d } from \'./d\';\nconst e = require("./e");\nconst f = await import("./f.mjs");\nvi.mock("./g");\nconst u = new URL("../h.mjs", import.meta.url);\nimport(`./${x}.js`);\nimport type { T } from "./types";';
    assert.deepEqual(jsSpecifiers(src).sort(), ["../h.mjs", "./a.js", "./b", "./c", "./d", "./e", "./f.mjs", "./g", "./side.css", "./types"]);
  });
  it("finds Python imports, relative levels and run-time string imports", () => {
    const got = pyImports('import os, a.b as ab\nfrom . import x\nfrom ..pkg.mod import (\n    one,\n    two as t,  # note\n)\nfrom a import *\nimportlib.import_module("p.q")\nmock.patch("r.s.func")\npytest_plugins = ["fix.plugin"]\n');
    const key = (i) => `${i.level}:${i.module}:${i.names.join(",")}`;
    assert.deepEqual(got.map(key).sort(), ["0:a.b:", "0:a:", "0:fix.plugin:", "0:os:", "0:p.q:", "0:r.s.func:", "1::x", "2:pkg.mod:one,two"].sort());
  });
  it("lists test files by convention or by ci.tests.test_globs", () => {
    assert.deepEqual(testFilesOf(JS.files), ["packages/shared/src/format.test.js", "test/cart.test.js", "test/legacy.spec.cjs", "test/math.test.js", "test/plugins.test.js", "test/schema.test.js", "web/__tests__/button.tsx"]);
    assert.deepEqual(testFilesOf(PY.files), ["tests/integration/test_checkout.py", "tests/integration/test_report.py", "tests/unit/store_test.py", "tests/unit/test_pricing.py", "tests/unit/test_tax.py"]);
    assert.deepEqual(testFilesOf(PY.files, { testGlobs: ["tests/integration/**/*.py"] }), ["tests/integration/conftest.py", "tests/integration/test_checkout.py", "tests/integration/test_report.py"]);
  });
});

describe("buildGraph", () => {
  const deps = (r, f) => [...(buildGraph(r).deps.get(f) ?? [])].sort();
  it("resolves JS relative, extensionless, workspace, tsconfig alias, .js -> .tsx and asset imports", () => {
    assert.deepEqual(deps(JS, "src/cart.js"), ["data/rates.json", "packages/shared/src/index.js", "src/util/math.js"]);
    assert.deepEqual(deps(JS, "src/legacy.cjs"), ["src/util/math.js"]);
    assert.deepEqual(deps(JS, "web/src/button.tsx"), ["web/src/lib/label.ts"]);
    assert.deepEqual(deps(JS, "web/__tests__/button.tsx"), ["web/src/button.tsx"]);
    assert.deepEqual(buildGraph(JS).dynamic, ["src/plugins.js"]);
  });
  it("resolves Python absolute (src layout), relative, package __init__, sibling helper and conftest chain", () => {
    assert.deepEqual(deps(PY, "src/orders/tax.py"), ["src/orders/__init__.py", "src/orders/pricing.py"]);
    assert.deepEqual(deps(PY, "src/orders/service.py"), ["src/orders/__init__.py", "src/orders/store.py", "src/orders/tax.py"]);
    assert.deepEqual(deps(PY, "tests/unit/test_tax.py"), ["src/orders/__init__.py", "src/orders/tax.py", "tests/conftest.py", "tests/helpers.py"]);
    assert.deepEqual(deps(PY, "tests/integration/test_checkout.py"), ["src/orders/__init__.py", "src/orders/service.py", "tests/conftest.py", "tests/integration/conftest.py"]);
    assert.deepEqual(deps(PY, "tests/unit/store_test.py"), ["src/orders/__init__.py", "src/orders/store.py", "tests/conftest.py"]);
    assert.deepEqual(deps(PY, "src/orders/report.py"), ["src/orders/__init__.py", "src/orders/pricing.py"]);
  });
});

describe("selectTests (JS)", () => {
  it("selects the transitive importers of a changed source file, each with a reason", () => {
    const s = select(JS, ["src/util/math.js"]);
    assert.equal(s.mode, "subset");
    assert.deepEqual(s.tests, ["test/cart.test.js", "test/legacy.spec.cjs", "test/math.test.js", "test/plugins.test.js"]);
    assert.deepEqual(s.reasons["test/math.test.js"], ["depends on src/util/math.js"]);
    assert.deepEqual(s.reasons["test/cart.test.js"], ["reaches src/util/math.js through src/cart.js"]);
    assert.equal(s.total, 7);
    assert.deepEqual(s.by_ecosystem, { js: s.tests });
  });
  it("follows a workspace package and a re-export", () => {
    assert.deepEqual(select(JS, ["packages/shared/src/format.js"]).tests, ["packages/shared/src/format.test.js", "test/cart.test.js"]);
  });
  it("follows a tsconfig alias and an imported data file", () => {
    assert.deepEqual(select(JS, ["web/src/lib/label.ts"]).tests, ["web/__tests__/button.tsx"]);
    assert.deepEqual(select(JS, ["data/rates.json"]).tests, ["test/cart.test.js"]);
  });
  it("follows a repo path quoted in a test (a file read by path, not imported)", () => {
    assert.deepEqual(select(JS, ["data/schema.sql"]).tests, ["test/schema.test.js"]);
    assert.deepEqual(select(JS, ["test/fixtures/order.json"]).tests, ["test/schema.test.js"]);
  });
  it("selects a changed test file itself", () => {
    const s = select(JS, ["./test/math.test.js"]);
    assert.deepEqual([s.mode, s.tests, s.reasons["test/math.test.js"]], ["subset", ["test/math.test.js"], ["changed test file"]]);
  });
  it("runs everything for a manifest, lockfile, CI file or runner config", () => {
    for (const f of ["package.json", "packages/shared/package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", "web/tsconfig.json", "vitest.config.ts", "forge.yaml", "Dockerfile.web", ".env.example"]) {
      const s = select(JS, [f, "src/util/math.js"]);
      assert.equal(s.mode, "all", f);
      assert.equal(s.tests.length, 7, f);
      assert.match(s.run_all[0].why, /run-everything glob/, f);
    }
  });
  it("runs everything for a file nothing maps: no importer, unknown type, deleted, or an empty diff", () => {
    assert.match(select(JS, ["src/orphan.js"]).run_all[0].why, /no test imports it/);
    assert.equal(select(JS, ["data/notes.txt"]).mode, "all");
    assert.equal(select(JS, ["README.md"]).mode, "all");
    assert.match(select(JS, ["src/removed.js"]).run_all[0].why, /deleted or unknown/);
    assert.match(select(JS, []).run_all[0].why, /no changed files/);
  });
  it("a deleted test file alone selects nothing", () => {
    assert.deepEqual([select(JS, ["test/old.test.js"]).mode, select(JS, ["test/old.test.js"]).tests], ["none", []]);
  });
  it("ci.tests.suites maps paths to test globs, named suites or everything", () => {
    const ci = { suites: ["data/*.txt => test/cart.test.js @e2e", "docs/** => *", "src/orphan.js => test/nothing/**"] };
    const s = select(JS, ["data/notes.txt"], ci);
    assert.deepEqual([s.mode, s.tests, s.suites], ["subset", ["test/cart.test.js"], ["@e2e"]]);
    assert.deepEqual(s.reasons["test/cart.test.js"], ["data/notes.txt matches data/*.txt => test/cart.test.js"]);
    assert.equal(select(JS, ["docs/guide.md"], ci).mode, "all");
    const o = select(JS, ["src/orphan.js"], ci);
    assert.equal(o.mode, "none");
    assert.match(o.warnings.join("\n"), /matches no test file/);
  });
  it("ci.tests.ignore drops files, and ci.tests.run_all adds triggers", () => {
    const s = select(JS, ["README.md", "src/util/math.js"], { ignore: ["**/*.md"] });
    assert.deepEqual([s.mode, s.ignored, s.tests.length], ["subset", ["README.md"], 4]);
    assert.equal(select(JS, ["README.md"], { ignore: ["*.md"] }).mode, "none");
    assert.equal(select(JS, ["src/util/math.js"], { run_all: ["src/util/**"] }).mode, "all");
  });
  it("warns about computed imports and bad suite entries", () => {
    const s = select(JS, ["src/util/math.js"], { suites: ["nonsense"] });
    assert.match(s.warnings.join("\n"), /computed import/);
    assert.match(s.warnings.join("\n"), /entry ignored/);
  });
});

describe("selectTests (Python)", () => {
  it("selects by module imports through the package", () => {
    const s = select(PY, ["src/orders/pricing.py"]);
    assert.deepEqual(s.tests, ["tests/integration/test_checkout.py", "tests/integration/test_report.py", "tests/unit/test_pricing.py", "tests/unit/test_tax.py"]);
    assert.deepEqual(s.by_ecosystem, { python: s.tests });
    assert.deepEqual(select(PY, ["src/orders/store.py"]).tests, ["tests/integration/test_checkout.py", "tests/unit/store_test.py"]);
  });
  it("a conftest.py change selects the tests under it; a helper selects its importers", () => {
    assert.deepEqual(select(PY, ["tests/integration/conftest.py"]).tests, ["tests/integration/test_checkout.py", "tests/integration/test_report.py"]);
    assert.equal(select(PY, ["tests/conftest.py"]).tests.length, 5);
    assert.deepEqual(select(PY, ["tests/helpers.py"]).tests, ["tests/unit/test_tax.py"]);
  });
  it("a package __init__ change selects every importer of the package", () => {
    assert.equal(select(PY, ["src/orders/__init__.py"]).tests.length, 5);
  });
  it("runs everything for pyproject.toml and for a script no test imports", () => {
    assert.equal(select(PY, ["pyproject.toml"]).mode, "all");
    assert.equal(select(PY, ["scripts/backfill.py"]).mode, "all");
  });
});

describe("fullReason / planRun", () => {
  const sel = select(JS, ["src/util/math.js"]);
  const grad = (graduated) => ({ graduated, why: graduated ? "graduated" : "3 of 50 consecutive full runs with 100% failure recall" });
  it("forces the full suite on --full, a schedule and a release branch", () => {
    const c = cfg();
    assert.match(fullReason({ flag: true, cfg: c }), /--full/);
    assert.match(fullReason({ event: "schedule", cfg: c }), /nightly/);
    assert.match(fullReason({ baseRef: "main", cfg: c }), /release branch main/);
    assert.match(fullReason({ ref: "refs/heads/release/r1", cfg: c }), /release branch release\/r1/);
    assert.equal(fullReason({ event: "pull_request", baseRef: "staging", ref: "refs/pull/7/merge", cfg: c }), null);
    assert.equal(fullReason({ baseRef: "main", cfg: cfg({ full_branches: ["prod"] }) }), null);
  });
  it("off computes nothing and runs everything", () => {
    assert.deepEqual(planRun({ cfg: parseTestsConfig({}) }), { configured: "off", effective: "off", run: "all", why: "ci.tests.selection is off" });
  });
  it("shadow always runs everything", () => {
    assert.deepEqual([planRun({ cfg: cfg(), selection: sel, graduation: grad(true) }).run, planRun({ cfg: cfg(), selection: sel, graduation: grad(true) }).effective], ["all", "shadow"]);
  });
  it("enforce is refused before graduation and stays shadow", () => {
    const p = planRun({ cfg: cfg({ selection: "enforce" }), selection: sel, graduation: grad(false) });
    assert.deepEqual([p.effective, p.run], ["shadow", "all"]);
    assert.match(p.refused, /enforce refused: 3 of 50/);
    assert.match(planRun({ cfg: cfg({ selection: "enforce" }), selection: sel, graduation: null }).refused, /no recall ledger/);
  });
  it("enforce after graduation runs the selection, unless a full run is forced or everything is selected", () => {
    const c = cfg({ selection: "enforce" });
    assert.deepEqual([planRun({ cfg: c, selection: sel, graduation: grad(true) }).run, planRun({ cfg: c, selection: sel, graduation: grad(true) }).effective], ["selection", "enforce"]);
    assert.equal(planRun({ cfg: c, selection: sel, graduation: grad(true), full: "scheduled run" }).run, "all");
    assert.equal(planRun({ cfg: c, selection: select(JS, ["package.json"]), graduation: grad(true) }).run, "all");
  });
});

describe("forgedock tests CLI", () => {
  const setup = (yaml) => {
    const dir = tmpDir("testengine-");
    cpSync(JS.root, dir, { recursive: true });
    if (yaml) writeFileSync(join(dir, "forge.yaml"), yaml);
    const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
    g("init", "-q"); g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
    writeFileSync(join(dir, "src/util/math.js"), "export const add = (a, b) => b + a;\n");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "change");
    return dir;
  };
  const run = async (dir, argv, env = {}) => { const lines = []; const code = await testsFromCli(argv, { cwd: dir, out: (l) => lines.push(l), env: { FORGEDOCK_TESTS_DIR: join(dir, ".ledger"), ...env }, now: Date.parse("2026-11-15T00:00:00Z") }); return { code, text: lines.join("\n") }; };
  const SHADOW = "ci:\n  tests:\n    selection: shadow\n";

  it("off (no ci.tests): says run everything, computes nothing, records nothing", async () => {
    const dir = setup(null);
    {
      const r = await run(dir, ["select", "--base", "HEAD~1", "--json"]);
      assert.deepEqual(JSON.parse(r.text), { plan: { configured: "off", effective: "off", run: "all", why: "ci.tests.selection is off" }, selection: null, run_tests: null, quarantined: [], graduation: null });
      assert.equal((await run(dir, ["recall", "record", "--selection", "missing.json"])).text, "tests recall: ci.tests.selection is off; nothing recorded");
      assert.equal(readdirSync(dir).includes(".ledger"), false);
    }
  });
  it("shadow: selects from the git diff, runs everything, records recall, shards, and refuses enforce", async () => {
    const dir = setup(SHADOW);
    {
      const sel = join(dir, "sel.json");
      const r = await run(dir, ["select", "--base", "HEAD~1", "--out", sel]);
      assert.match(r.text, /selection shadow; run all/);
      assert.match(r.text, /selected: 4 of 7 test file\(s\)/);
      assert.match(r.text, /test\/cart\.test\.js: reaches src\/util\/math\.js through src\/cart\.js/);
      const out = JSON.parse(readFileSync(sel, "utf8"));
      assert.equal(out.run_tests.length, 7);
      assert.equal(out.selection.tests.length, 4);

      const rep = join(FIX, "reports", "vitest-junit.xml");
      assert.match((await run(dir, ["recall", "record", "--selection", sel, "--report", rep, "--sha", "abc", "--run-id", "1"])).text, /recall: ok: 1 failing test file\(s\), 0 outside the selection/);
      const miss = await run(dir, ["recall", "record", "--selection", sel, "--failed", "web/__tests__/button.tsx", "--sha", "abd", "--json"]);
      assert.deepEqual([JSON.parse(miss.text).ok, JSON.parse(miss.text).missed], [false, ["web/__tests__/button.tsx"]]);
      const st = await run(dir, ["recall", "status"]);
      assert.match(st.text, /0 of 50 consecutive full runs with 100% failure recall since the last miss/);
      assert.match(st.text, /last miss: abd/);
      assert.equal((await run(dir, ["recall", "check"])).code, 1);

      const sh = await run(dir, ["shard", "--shards", "2", "--report", rep, "--json"]);
      const plan = JSON.parse(sh.text);
      assert.deepEqual([plan.shards.length, plan.source, plan.shards.flatMap((s) => s.files).length], [2, "durations", 7]);
      const m = JSON.parse((await run(dir, ["shard", "--shards", "3", "--from", sel, "--matrix"])).text);
      assert.deepEqual(m.include.map((i) => [i.shard, i.total]), [[1, 3], [2, 3], [3, 3]]);

      writeFileSync(join(dir, "forge.yaml"), SHADOW.replace("shadow", "enforce"));
      const e = await run(dir, ["select", "--changed", "src/util/math.js", "--json"]);
      assert.deepEqual([JSON.parse(e.text).plan.effective, JSON.parse(e.text).plan.run, JSON.parse(e.text).run_tests.length], ["shadow", "all", 7]);
      assert.match(JSON.parse(e.text).plan.refused, /enforce refused/);
    }
  });
  it("enforce after graduation returns only the selection, and the full suite on a schedule", async () => {
    const dir = setup("ci:\n  tests:\n    selection: enforce\n    graduate_after: 2\n");
    {
      const sel = join(dir, "sel.json");
      await run(dir, ["select", "--changed", "src/util/math.js", "--out", sel]);
      for (const id of ["1", "2"]) await run(dir, ["recall", "record", "--selection", sel, "--failed", "test/math.test.js", "--sha", `s${id}`, "--run-id", id]);
      assert.equal((await run(dir, ["recall", "check"])).code, 0);
      const e = JSON.parse((await run(dir, ["select", "--changed", "src/util/math.js", "--json"])).text);
      assert.deepEqual([e.plan.effective, e.plan.run, e.run_tests.length], ["enforce", "selection", 4]);
      const n = JSON.parse((await run(dir, ["select", "--changed", "src/util/math.js", "--json"], { GITHUB_EVENT_NAME: "schedule" })).text);
      assert.deepEqual([n.plan.run, n.run_tests.length], ["all", 7]);
    }
  });
  it("rejects unknown subcommands and flags", async () => {
    await assert.rejects(testsFromCli(["nope"], { out: () => {} }), /usage: forgedock tests select/);
    await assert.rejects(testsFromCli(["select", "--bogus"], { out: () => {}, cwd: FIX }), /unknown argument --bogus/);
    await assert.rejects(testsFromCli(["recall", "wat"], { out: () => {}, cwd: FIX }), /unknown tests recall subcommand/);
  });
  it("puts the default ledger outside the checkout", () => {
    assert.equal(ledgerPath({ cwd: "/x", cfg: { ledger: "" }, flag: "/a/l.jsonl", env: {} }), "/a/l.jsonl");
    assert.equal(ledgerPath({ cwd: "/x", cfg: { ledger: "/c/l.jsonl" }, env: {} }), "/c/l.jsonl");
    assert.match(ledgerPath({ cwd: tmpdir(), cfg: { ledger: "" }, env: { FORGEDOCK_TESTS_DIR: "/state" } }), /^\/state\/[^/]+\/recall\.jsonl$/);
  });
});
