// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReviewFields, writeReviewFields, collectManifestFacts, detectStale, supersededDecisionIds, contextAge,
  checkContext, proposeRefresh, refreshContextFlow, countMergedSince,
} from "../review-context.mjs";

const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "revctx-"));
const pkg = (deps) => JSON.stringify({ name: "x", dependencies: deps });
const YAML = `project:\n  name: Demo\nreview:\n  tech_stack: "Next.js 15, FastAPI, Docker"\n  context: |\n    Repo is docs-only; no product code exists until D-12 lands.\n    Reviewers must check auth.\n  domains:\n    auth: "jwt"\nbranches:\n  default: main\n`;

describe("review block read/write", () => {
  it("reads quoted and block scalars, ignores nested keys", () => {
    const f = readReviewFields(YAML);
    assert.equal(f.tech_stack, "Next.js 15, FastAPI, Docker");
    assert.equal(f.context, "Repo is docs-only; no product code exists until D-12 lands.\nReviewers must check auth.");
    assert.equal(f.auth, undefined);
  });
  it("replaces keys, keeps every other line, and adds a review block when missing", () => {
    const out = writeReviewFields(YAML, { tech_stack: "React", context_generated_at: "2026-02-01" });
    assert.match(out, /tech_stack: "React"/);
    assert.match(out, /context_generated_at: "2026-02-01"/);
    assert.match(out, /    Reviewers must check auth\./);
    assert.match(out, /  domains:\n    auth: "jwt"\nbranches:/);
    assert.equal(readReviewFields(out).tech_stack, "React");
    assert.equal(readReviewFields(writeReviewFields("project:\n  name: a\n", { tech_stack: "Go" })).tech_stack, "Go");
  });
});

describe("detectStale", () => {
  const code = (root) => collectManifestFacts(root);
  it("flags tech_stack frameworks absent from every manifest", () => {
    const d = tmp(); writeFileSync(join(d, "package.json"), pkg({ react: "1", "next-auth": "1" }));
    const r = detectStale({ techStack: "Next.js 15, React", context: "", manifests: code(d) });
    assert.deepEqual(r.map((x) => x.code), ["tech_stack_absent"]);
    assert.match(r[0].detail, /Next\.js/);
    assert.doesNotMatch(r[0].detail, /React/);
    rmSync(d, { recursive: true });
  });
  it("is fresh when every named framework is in a manifest (monorepo subdir, python)", () => {
    const d = tmp(); mkdirSync(join(d, "services/api"), { recursive: true });
    writeFileSync(join(d, "package.json"), pkg({ next: "15" }));
    writeFileSync(join(d, "services/api/requirements.txt"), "fastapi==0.1\n");
    assert.deepEqual(detectStale({ techStack: "Next.js, FastAPI, Docker", context: "ok", manifests: code(d) }), []);
    rmSync(d, { recursive: true });
  });
  it("flags docs-only / no code phrasing only while source manifests exist", () => {
    const d = tmp();
    assert.deepEqual(detectStale({ context: "docs-only repo", manifests: code(d) }), []);
    writeFileSync(join(d, "package.json"), pkg({ react: "1" }));
    assert.equal(detectStale({ context: "There is no code yet", manifests: code(d) })[0].code, "docs_only_phrasing");
    assert.deepEqual(detectStale({ context: "Has code and docs", manifests: code(d) }), []);
    rmSync(d, { recursive: true });
  });
  it("a package.json without dependencies is not a source manifest", () => {
    const d = tmp(); writeFileSync(join(d, "package.json"), JSON.stringify({ name: "docs" }));
    assert.deepEqual(detectStale({ techStack: "Next.js", context: "docs-only", manifests: code(d) }), []);
    rmSync(d, { recursive: true });
  });
  it("flags cited decision IDs the log marks superseded; skips without a log", () => {
    const log = "## D-12 Use Hugo\nStatus: superseded by D-15\n\n## D-15 Use Next\nStatus: accepted\n- ADR-3 supersedes ADR-1\n";
    assert.deepEqual([...supersededDecisionIds(log)].sort(), ["ADR-1", "D-12"]);
    const r = detectStale({ context: "Per D-12 and D-15 we ship docs", decisionLogText: log });
    assert.equal(r[0].code, "superseded_decision");
    assert.match(r[0].detail, /D-12/);
    assert.doesNotMatch(r[0].detail, /D-15/);
    assert.deepEqual(detectStale({ context: "Per D-12", decisionLogText: "" }), []);
    assert.deepEqual(detectStale({ context: "Per D-15 only", decisionLogText: log }), []);
  });
});

describe("contextAge", () => {
  it("is advisory only past N merged PRs, and unknown counts or dates are not advisory", () => {
    assert.equal(contextAge({ generatedAt: "2026-01-01", mergedSince: 51 }).advisory, true);
    assert.equal(contextAge({ generatedAt: "2026-01-01", mergedSince: 50 }).advisory, false);
    assert.equal(contextAge({ generatedAt: "2026-01-01", mergedSince: 5, maxMergedPrs: 3 }).advisory, true);
    assert.equal(contextAge({ generatedAt: "2026-01-01", mergedSince: null }).advisory, false);
    assert.equal(contextAge({ generatedAt: "", mergedSince: 999 }).advisory, false);
  });
  it("countMergedSince returns null on gh failure or a bad date", () => {
    assert.equal(countMergedSince("o/r", "2026-01-01", () => { throw new Error("no gh"); }), null);
    assert.equal(countMergedSince("o/r", "garbage", () => "[]"), null);
    assert.equal(countMergedSince("o/r", "2026-01-01", () => '[{"number":1},{"number":2}]'), 2);
  });
});

describe("checkContext", () => {
  it("combines the rules, reads the decision log and the generation date", () => {
    const d = tmp(); mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "package.json"), pkg({ react: "1" }));
    writeFileSync(join(d, "docs/decisions.md"), "## D-12\nStatus: superseded\n");
    writeFileSync(join(d, "forge.yaml"), writeReviewFields(YAML, { context_generated_at: "2026-01-01", context_max_merged_prs: "10" }));
    const r = checkContext({ configPath: join(d, "forge.yaml"), root: d, repo: "o/r", mergedCount: () => 11 });
    assert.equal(r.stale, true);
    assert.deepEqual(r.reasons.map((x) => x.code).sort(), ["docs_only_phrasing", "superseded_decision", "tech_stack_absent"]);
    assert.equal(r.advisory, true);
    assert.equal(r.generated_at, "2026-01-01");
    rmSync(d, { recursive: true });
  });
  it("a config without review keys or manifests is fresh (no false positive)", () => {
    const d = tmp(); writeFileSync(join(d, "forge.yaml"), "project:\n  name: a\n");
    const r = checkContext({ configPath: join(d, "forge.yaml"), root: d, repo: "o/r", mergedCount: () => 999 });
    assert.deepEqual([r.stale, r.advisory, r.generated_at], [false, false, ""]);
    assert.equal(checkContext({ configPath: join(d, "missing.yaml"), root: d }).stale, false);
    rmSync(d, { recursive: true });
  });
});

describe("refresh", () => {
  const setup = () => {
    const d = tmp();
    writeFileSync(join(d, "package.json"), pkg({ react: "1" }));
    writeFileSync(join(d, "forge.yaml"), YAML);
    return d;
  };
  it("proposeRefresh rebuilds tech_stack, prunes stale sentences, stamps the date and diffs", async () => {
    const d = setup();
    const r = await proposeRefresh({ yamlText: YAML, root: d, now: new Date("2026-03-04T00:00:00Z"), mergedTotal: 42 });
    const f = readReviewFields(r.next);
    assert.equal(f.tech_stack, "React");
    assert.equal(f.context, "Reviewers must check auth.");
    assert.equal(f.context_generated_at, "2026-03-04");
    assert.equal(f.context_generated_pr_count, "42");
    assert.match(r.diff, /^- /m);
    assert.match(r.diff, /^\+ .*React/m);
    assert.equal(checkContext({ configPath: join(d, "forge.yaml"), root: d, mergedCount: () => null }).stale, true);
    writeFileSync(join(d, "forge.yaml"), r.next);
    assert.equal(checkContext({ configPath: join(d, "forge.yaml"), root: d, mergedCount: () => null }).stale, false);
    rmSync(d, { recursive: true });
  });
  it("flow writes only on approval, backs up, and never writes non-interactively", async () => {
    const d = setup(); const buf = []; const out = { write: (s) => buf.push(s) };
    const writes = [];
    const deps = (o) => ({ interactive: true, confirm: async () => true, backup: () => ({ backupName: "forge.yaml.bak" }), write: (p, c) => writes.push([p, c]), ...o });
    assert.equal(await refreshContextFlow({ cwd: d, out, deps: deps({ interactive: false }) }), 1);
    assert.equal(await refreshContextFlow({ cwd: d, out, deps: deps({ confirm: async () => false }) }), 1);
    assert.equal(writes.length, 0);
    assert.equal(await refreshContextFlow({ cwd: d, out, deps: deps() }), 0);
    assert.equal(writes.length, 1);
    assert.match(writes[0][1], /tech_stack: "React"/);
    assert.match(buf.join(""), /Backed up/);
    assert.equal(readFileSync(join(d, "forge.yaml"), "utf8"), YAML);
    assert.equal(await refreshContextFlow({ cwd: join(d, "nope"), out, deps: deps() }), 1);
    rmSync(d, { recursive: true });
  });
});
