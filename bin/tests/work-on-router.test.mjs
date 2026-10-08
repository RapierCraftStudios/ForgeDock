// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards the /work-on phase-delivery architecture: work-on.md is a thin router and every phase
// runs as a forked sub-skill. Field evidence (2026-10-07): when work-on.md carried an inline copy
// of every phase AND invoked the phase sub-skills, orchestrated workers received two conflicting
// versions of each phase (230k–360k tokens of overlapping spec) and took shortcuts.
// Nesting rule (forge#3398, docs/WORK-ON-RUNTIME.md): Claude Code grants the Agent tool only down to
// a fixed depth, so the phases that spawn sub-agents (review, remediate) are invoked only by the
// router; every fork declares `background: false` so the caller receives its RESULT in-turn.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const frontmatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? m[1] : "";
};

const PHASES = {
  investigate: "commands/work-on/investigate.md",
  decompose: "commands/work-on/decompose.md",
  build: "commands/work-on/build.md",
  review: "commands/work-on/review.md",
  close: "commands/work-on/close.md",
  remediate: "commands/work-on/remediate.md",
};
const BUILD_CHILDREN = {
  "build:context": "commands/work-on/build/context.md",
  "build:architect": "commands/work-on/build/architect.md",
  "build:implement": "commands/work-on/build/implement.md",
  "build:validate": "commands/work-on/build/validate.md",
};

test("work-on.md stays a thin router (no inline phase bodies)", () => {
  const router = read("commands/work-on.md");
  const lines = router.split("\n").length;
  assert.ok(lines < 900, `work-on.md has ${lines} lines; phase logic belongs in the phase sub-skills`);
  // Former inline sub-phase headings must not come back.
  for (const h of [/^### 3C\.5:/m, /^### 3G:/m, /^### 3H:/m, /^### 6A:/m, /^### 7B:/m, /^### 1B:/m, /^### 4D:/m]) {
    assert.doesNotMatch(router, h, `inline phase heading ${h} reintroduced into work-on.md`);
  }
  assert.doesNotMatch(router, /Canonical path\*\*: Sub-phases 3A–3M run \*\*inline\*\*/);
});

test("the router dispatches every phase via Skill and never merges", () => {
  const router = read("commands/work-on.md");
  for (const phase of ["investigate", "decompose", "build", "review", "close", "remediate"]) {
    assert.match(router, new RegExp(`Skill\\(skill="\\{FORGE_SKILL_PREFIX\\}work-on:${phase}"`), `router never dispatches work-on:${phase}`);
  }
  assert.doesNotMatch(router, /^\s*gh pr merge /m, "the router must not merge; review owns the CI-gated merge");
});

test("every phase sub-skill and build child is forked and ends in a RESULT block", () => {
  const results = {
    investigate: "INVESTIGATE_RESULT", decompose: "DECOMPOSE_RESULT", build: "BUILD_RESULT",
    review: "REVIEW_RESULT", close: "CLOSE_RESULT", remediate: "REMEDIATE_RESULT",
    "build:context": "CONTEXT_RESULT", "build:architect": "ARCHITECT_RESULT",
    "build:implement": "IMPLEMENT_RESULT", "build:validate": "VALIDATE_RESULT",
  };
  for (const [name, path] of Object.entries({ ...PHASES, ...BUILD_CHILDREN })) {
    const text = read(path);
    assert.match(frontmatter(text), /^context: fork$/m, `${path} must declare context: fork`);
    assert.match(frontmatter(text), /^background: false$/m, `${path} must declare background: false (synchronous RESULT)`);
    assert.ok(text.includes(results[name]), `${path} must emit ${results[name]}`);
  }
  assert.match(frontmatter(read("commands/quality-gate.md")), /^context: fork$/m);
  assert.match(frontmatter(read("commands/quality-gate.md")), /^background: false$/m);
});

test("dispatching phases (review, remediate) are invoked only by the router", () => {
  const invoke = /Skill\(skill="\{FORGE_SKILL_PREFIX\}work-on:(review|remediate)"/;
  for (const path of [...Object.values(PHASES), ...Object.values(BUILD_CHILDREN), "commands/quality-gate.md", "commands/review-pr.md"]) {
    assert.doesNotMatch(read(path), invoke, `${path} invokes a dispatching phase; return status: NEXT to the router instead`);
  }
  const router = read("commands/work-on.md");
  assert.match(router, /### Phase 4R: Remediation handoff from review/);
  assert.match(router, /`NEXT`, `next: remediate`/, "router must route REVIEW_RESULT NEXT to remediation");
  assert.match(read("commands/work-on/review.md"), /status: COMPLETE \| ALREADY_MERGED \| NEXT \| BLOCKED/);
});

test("Phase 4R routes github-unavailable blockers to retry before the generic BLOCKED row", () => {
  const router = read("commands/work-on.md");
  const start = router.indexOf("### Phase 4R");
  const end = router.indexOf("## Phase 5", start);
  assert.ok(start >= 0 && end > start, "Phase 4R section not found");
  const rows = router.slice(start, end).split("\n").filter((l) => l.startsWith("|"));
  const retry = rows.findIndex((l) => l.includes("github-unavailable:") && l.includes("`status: BLOCKED`"));
  const generic = rows.findIndex((l) => l.startsWith("| `status: BLOCKED` (any kind)"));
  assert.ok(retry >= 0, "no github-unavailable: row in Phase 4R");
  assert.ok(generic >= 0, "no generic BLOCKED row in Phase 4R");
  assert.ok(retry < generic, "github-unavailable: retry row must precede the generic BLOCKED row");
});

test("router runs the spawn-depth preflight", () => {
  const router = read("commands/work-on.md");
  assert.match(router, /scripts\/spawn-depth-check\.sh" --router-layer "\$ROUTER_LAYER"/);
  assert.doesNotMatch(router, /\| 5 \| Quality gate/, "stale five-layer Depth Budget table reintroduced");
});

test("build dispatches its children as skills, never inline", () => {
  const build = read("commands/work-on/build.md");
  for (const child of Object.keys(BUILD_CHILDREN)) {
    assert.match(build, new RegExp(`Skill\\(skill="\\{FORGE_SKILL_PREFIX\\}work-on:${child}"`), `build never dispatches work-on:${child}`);
  }
  assert.doesNotMatch(build, /Default execution model: inline/);
});
