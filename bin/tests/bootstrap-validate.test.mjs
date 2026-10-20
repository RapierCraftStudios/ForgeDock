import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validatePlan,
  resolvePlaceholders,
  isNeedsHuman,
  formatErrors,
} from "../../scripts/bootstrap-validate.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/bootstrap-validate.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/bootstrap-validate/", import.meta.url));
const ECOSYSTEMS = ["nextjs", "python", "go"];

const load = (name) => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8"));
const cli = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input });
const codes = (r) => [...new Set(r.errors.map((e) => e.code))].sort();
const issue = (plan, key) => plan.issues.find((i) => i.key === key);

// Each rejection class: its failing fixture, the offending issue, and the valid base it was mutated from.
const CLASSES = [
  { code: "cycle", key: "PKG", base: "python" },
  { code: "forward-milestone-dep", key: "STORE", base: "go" },
  { code: "depends-on-mismatch", key: "ROUTES", base: "python" },
  { code: "unresolved-placeholder", key: "AUTH", base: "nextjs" },
  { code: "missing-section", key: "MODELS", base: "python" },
  { code: "missing-type-tag", key: "MOD", base: "go" },
  { code: "missing-parent", key: "ROUTES", base: "python" },
  { code: "missing-labels", key: "SYNC", base: "go" },
  { code: "code-depends-on-needs-human", key: "AUTH", base: "nextjs" },
];

for (const eco of ECOSYSTEMS) {
  test(`valid-${eco}: validatePlan passes and the CLI exits 0`, () => {
    const r = validatePlan(load(`valid-${eco}`));
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    const run = cli([`${FIXTURES}valid-${eco}.json`]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /bootstrap-validate: OK/);
  });
}

for (const { code, key, base } of CLASSES) {
  test(`invalid-${code}: rejected with only [${code}] on ${key}; its base valid-${base} passes`, () => {
    const r = validatePlan(load(`invalid-${code}`));
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), [code]);
    assert.ok(r.errors.some((e) => e.issue === key && e.code === code), formatErrors(r.errors));
    assert.equal(validatePlan(load(`valid-${base}`)).ok, true);

    const run = cli([`${FIXTURES}invalid-${code}.json`]);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes(`${key}: [${code}]`), run.stderr);
  });
}

test("needs-human may depend on code, and code may reference (not depend on) needs-human", () => {
  const next = load("valid-nextjs");
  assert.ok(isNeedsHuman(issue(next, "GOOGLE_OAUTH")));
  assert.deepEqual(issue(next, "GOOGLE_OAUTH").deps, ["SCAFFOLD"]);
  assert.match(issue(next, "AUTH").body, /see #\{\{GOOGLE_OAUTH\}\}/);
  assert.ok(!issue(next, "AUTH").deps.includes("GOOGLE_OAUTH"));
  assert.equal(validatePlan(next).ok, true);
  // needs-human by label alone (no needsHuman flag) still counts.
  const py = load("valid-python");
  assert.equal(issue(py, "STRIPE_KEYS").needsHuman, true);
  delete issue(py, "STRIPE_KEYS").needsHuman;
  assert.ok(isNeedsHuman(issue(py, "STRIPE_KEYS")));
});

test("code issue depending on a label-only needs-human issue is rejected", () => {
  const p = load("invalid-code-depends-on-needs-human");
  delete issue(p, "GOOGLE_OAUTH").needsHuman;
  assert.deepEqual(codes(validatePlan(p)), ["code-depends-on-needs-human"]);
});

test("missing Dependencies section is rejected even when the issue has no deps", () => {
  const p = load("valid-go");
  const spike = issue(p, "SPIKE");
  spike.body = spike.body.replace(/## Dependencies[\s\S]*$/, "");
  const r = validatePlan(p);
  assert.deepEqual(codes(r), ["missing-section"]);
  assert.match(formatErrors(r.errors), /SPIKE: \[missing-section\] missing `## Dependencies` section/);
});

test("Root Cause heading is accepted with or without '(if known)'; headings inside code fences do not count", () => {
  const p = load("valid-go");
  const mod = issue(p, "MOD");
  mod.body = mod.body.replace("## Root Cause (if known)", "## Root Cause");
  assert.equal(validatePlan(p).ok, true);
  mod.body = mod.body.replace("## Problem", "```md\n## Problem\n```");
  assert.deepEqual(codes(validatePlan(p)), ["missing-section"]);
});

test("Acceptance Criteria without checklist items is a missing section", () => {
  const p = load("valid-python");
  const m = issue(p, "MODELS");
  m.body = m.body.replace(/- \[ \] Migration.*\n/, "Migrations work.\n");
  assert.deepEqual(codes(validatePlan(p)), ["missing-section"]);
});

test("a self-dependency is a cycle; an unknown dep key is unknown-dep", () => {
  const p = load("valid-go");
  const s = issue(p, "STORE");
  s.deps = ["MOD", "STORE"];
  s.body = s.body.replace("Depends on #{{MOD}}", "Depends on #{{MOD}}, #{{STORE}}");
  assert.deepEqual(codes(validatePlan(p)), ["cycle"]);

  const q = load("valid-go");
  issue(q, "STORE").deps = ["MOD", "NOPE"];
  assert.ok(codes(validatePlan(q)).includes("unknown-dep"));
});

test("a literal #N in a Depends on line that is not a planned dep is a mismatch", () => {
  const p = load("valid-go");
  const s = issue(p, "STORE");
  s.body = s.body.replace("Depends on #{{MOD}}", "Depends on #{{MOD}}, #42");
  const r = validatePlan(p);
  assert.deepEqual(codes(r), ["depends-on-mismatch"]);
  assert.match(r.errors[0].message, /declared but not planned: #42/);
});

test("real issue numbers in plan.numbers resolve and match planned deps", () => {
  const p = load("valid-go");
  p.numbers = { SPIKE: 10, MOD: 11, STORE: 12 };
  assert.equal(validatePlan(p).ok, true);
  assert.equal(resolvePlaceholders("Depends on #{{MOD}} and #{{X}}", p.numbers), "Depends on #11 and #{{X}}");
  assert.equal(resolvePlaceholders("#{{MOD}}", new Map([["MOD", 7]])), "#7");
});

test("labels outside the plan's declared label set are unknown-label", () => {
  const p = load("valid-go");
  issue(p, "SYNC").labels = ["backnd"];
  assert.deepEqual(codes(validatePlan(p)), ["unknown-label"]);
  delete p.labels; // no declared set: any non-empty label is fine
  assert.equal(validatePlan(p).ok, true);
});

test("structural problems are invalid-plan errors, never throws", () => {
  assert.deepEqual(codes(validatePlan(null)), ["invalid-plan"]);
  assert.deepEqual(codes(validatePlan({ milestones: [], issues: [] })), ["invalid-plan"]);
  const dup = load("valid-go");
  dup.issues.push({ ...issue(dup, "MOD") });
  assert.deepEqual(codes(validatePlan(dup)), ["invalid-plan"]);
  const badMs = load("valid-go");
  issue(badMs, "SYNC").milestone = "m9";
  const r = validatePlan(badMs);
  assert.deepEqual(codes(r), ["invalid-plan"]);
  assert.equal(r.errors[0].issue, "SYNC");
});

test("CLI: stdin '-' works; bad JSON, a missing file and no argument exit 2", () => {
  const ok = cli(["-"], readFileSync(`${FIXTURES}valid-python.json`, "utf8"));
  assert.equal(ok.status, 0, ok.stderr);
  const bad = cli(["-"], "{not json");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid JSON/);
  assert.equal(cli([`${FIXTURES}does-not-exist.json`]).status, 2);
  assert.equal(cli([]).status, 2);
});

// #4176: UI issues carry the full design spec, hero surfaces route to /design, needs-human issues explain the setup.
const DESIGN_SPEC = "\n- Breakpoints: 360/768/1280\n- States: empty, loading, error, offline\n- Motion: fades\n- Accessibility: AA\n- Dark mode: tokens\n";

test("ui issues need every design-spec item; hero issues must route to /design", () => {
  const p = load("valid-nextjs");
  const dash = issue(p, "DASHBOARD");
  dash.ui = true;
  const r = validatePlan(p);
  assert.deepEqual(codes(r), ["missing-design-spec"]);
  assert.match(formatErrors(r.errors), /DASHBOARD: \[missing-design-spec\] .*breakpoints.*dark mode/);
  dash.body = dash.body.replace("## Context", `${DESIGN_SPEC}\n## Context`);
  assert.equal(validatePlan(p).ok, true);
  dash.body = dash.body.replace(", offline", "");
  assert.match(formatErrors(validatePlan(p).errors), /lacks: offline state$/m);
  dash.body = dash.body.replace("error", "error, offline");
  dash.hero = true;
  assert.deepEqual(codes(validatePlan(p)), ["hero-not-routed"]);
  dash.body += "\nHero surface: route to `/design` first.\n";
  assert.equal(validatePlan(p).ok, true);
  // A path that merely contains /design is not a routing line.
  dash.body = dash.body.replace("`/design`", "docs/design");
  assert.deepEqual(codes(validatePlan(p)), ["hero-not-routed"]);
});

test("needs-human issues need setup steps, env var names and secret handling", () => {
  const p = load("valid-python");
  const keys = issue(p, "STRIPE_KEYS");
  assert.equal(validatePlan(p).ok, true);
  for (const [heading, part] of [["### Setup steps", "setup steps"], ["### Environment variables", "environment variables"], ["### Secret handling", "secret handling"]]) {
    const q = load("valid-python");
    issue(q, "STRIPE_KEYS").body = issue(q, "STRIPE_KEYS").body.replace(heading, "Notes:");
    const r = validatePlan(q);
    assert.deepEqual(codes(r), ["missing-needs-human-section"], part);
    assert.match(formatErrors(r.errors), new RegExp(`STRIPE_KEYS: .*${part}`));
  }
  keys.body = keys.body.replace(/`[A-Z_]+`/g, "the key");
  assert.match(formatErrors(validatePlan(p).errors), /STRIPE_KEYS: \[missing-needs-human-section\] .*env var name/);
});

test("non-boolean ui / hero flags are invalid-plan", () => {
  const p = load("valid-go");
  issue(p, "SYNC").ui = "yes";
  assert.deepEqual(codes(validatePlan(p)), ["invalid-plan"]);
});
