// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBuilderRouting, classifyPath, routeBuilder, shouldEscalate, ESCALATE_TRIGGERS, DEFAULT_MID_MODEL } from "./routing.mjs";

const contract = (...paths) => ({ deliverables: paths.map((path, i) => ({ id: `D${i + 1}`, path, change: "x", requirements: ["R1"] })) });

describe("parseBuilderRouting (#4394)", () => {
  it("defaults to on with the default mid model; unknown modes are on; invalid ids fall back", () => {
    assert.deepEqual(parseBuilderRouting(), { mode: "on", midModel: DEFAULT_MID_MODEL });
    assert.equal(DEFAULT_MID_MODEL, "claude-sonnet-5-5");
    assert.equal(parseBuilderRouting({ mode: "OFF" }).mode, "off");
    assert.equal(parseBuilderRouting({ mode: "shadow" }).mode, "on");
    assert.equal(parseBuilderRouting({ midModel: "claude-haiku-5-5" }).midModel, "claude-haiku-5-5");
    assert.equal(parseBuilderRouting({ midModel: "openai/gpt[1m]" }).midModel, DEFAULT_MID_MODEL);
    assert.equal(parseBuilderRouting({ midModel: "sonnet; rm -rf /" }).midModel, DEFAULT_MID_MODEL);
    assert.equal(parseBuilderRouting({ midModel: "opus[1m]" }).midModel, "opus[1m]");
  });
});

describe("classifyPath (#4394)", () => {
  it("classifies tests across ecosystems", () => {
    for (const p of ["src/a.test.ts", "web/b.spec.tsx", "pkg/c_test.go", "tests/test_d.py", "app/test_e.py", "crates/x/tests/it.rs", "src/__tests__/f.js", "spec/models/user_spec.rb", "src/test/java/FooTest.java"]) {
      assert.equal(classifyPath(p), "test", p);
    }
  });
  it("classifies docs, config and code; lockfiles are code", () => {
    for (const p of ["README.md", "docs/guide.mdx", "devdocs/modules/lean.md", "CHANGES.rst", "notes.txt", "docs/img/arch.svg"]) assert.equal(classifyPath(p), "docs", p);
    for (const p of ["forge.yaml", ".github/workflows/ci.yml", "pyproject.toml", "setup.cfg", "tsconfig.json", ".env.example", ".eslintrc", "Cargo.toml"]) assert.equal(classifyPath(p), "config", p);
    for (const p of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "go.sum", "src/main.rs", "lib/x.py", "cmd/main.go", "src/foo.ts", "Makefile"]) assert.equal(classifyPath(p), "code", p);
  });
});

describe("routeBuilder (#4394)", () => {
  it("risk: a built-in risk word or a declared review.risk_paths glob routes to the top model", () => {
    const r = routeBuilder({ contract: contract("src/auth/session.ts", "README.md"), topModel: "opus" });
    assert.deepEqual(r, { mode: "on", class: "risk", tier: "top", model: "opus", risk: ["src/auth/session.ts"] });
    const g = routeBuilder({ contract: contract("detect/rules.py"), riskPaths: ["detect/**"] });
    assert.deepEqual([g.class, g.tier, g.model, g.risk], ["risk", "top", null, ["detect/rules.py"]]);
    assert.equal(routeBuilder({ contract: contract("detect/rules.py") }).class, "small", "detection is not a built-in risk word");
  });
  it("docs-config-test, small and large classes", () => {
    assert.deepEqual(routeBuilder({ contract: contract("docs/a.md", "forge.yaml", "test/a.test.js"), topModel: "opus" }),
      { mode: "on", class: "docs-config-test", tier: "mid", model: DEFAULT_MID_MODEL, risk: [] });
    const s = routeBuilder({ contract: contract("src/a.js", "src/b.js", "test/a.test.js", "test/b.test.js"), cfg: { midModel: "haiku" } });
    assert.deepEqual([s.class, s.tier, s.model], ["small", "mid", "haiku"]);
    const l = routeBuilder({ contract: contract("src/a.js", "src/b.js", "src/c.js"), topModel: "opus" });
    assert.deepEqual([l.class, l.tier, l.model], ["large", "top", "opus"]);
    const lock = routeBuilder({ contract: contract("package.json", "package-lock.json") });
    assert.equal(lock.class, "small", "a lockfile change is code, not config");
  });
  it("no deliverables is large; mode off keeps the top tier but still reports the class", () => {
    assert.deepEqual([routeBuilder({ contract: { deliverables: [] } }).class, routeBuilder({}).tier], ["large", "top"]);
    const off = routeBuilder({ contract: contract("docs/a.md"), cfg: { mode: "off" }, topModel: "opus" });
    assert.deepEqual([off.mode, off.class, off.tier, off.model], ["off", "docs-config-test", "top", "opus"]);
  });
  it("escalates once, on validate rounds only, from the mid tier", () => {
    assert.deepEqual(ESCALATE_TRIGGERS, ["precheck", "ci_red", "merge_ci"]);
    const mid = { tier: "mid" };
    for (const t of ESCALATE_TRIGGERS) assert.equal(shouldEscalate(mid, false, t), true, t);
    for (const t of ["conformance", "review", "build", "recovery"]) assert.equal(shouldEscalate(mid, false, t), false, t);
    assert.equal(shouldEscalate(mid, true, "precheck"), false);
    assert.equal(shouldEscalate({ tier: "top" }, false, "precheck"), false);
    assert.equal(shouldEscalate(null, false, "precheck"), false);
  });
});
