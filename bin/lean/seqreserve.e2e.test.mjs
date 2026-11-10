// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5235 end-to-end replay of the AlterLab 0616/v23 collisions (batch b20261107-065813-1951070) through runCore on a
 * disposable REAL git repo (bare origin, clone, lane worktree, real commits, real --no-ff merge). GitHub is in-memory.
 * While the lane builds, a sibling lane merges its own 0616 migration and v23 backup-contracts into staging; the lane
 * must be renumbered (0617 / v24, companion rewritten), re-validated and merged without needs-human.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";
import { runCore } from "./lean.mjs";
import { makeLeanIo } from "./effects.mjs";
import { reserveForBuild } from "./seqreserve.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV });
const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;
const writeAll = (root, files) => { for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };

const ISSUE = { number: 7, title: "Add a backup contract and a migration", body: "## Requirements\n1. Add a new migration and a new backup-contracts version.\n" };
const BASE = { "package.json": '{ "name": "f", "type": "module", "private": true }\n', "db/0614_z.sql": "select 0;\n", "db/0615_a.sql": "select 1;\n", "scripts/backup-contracts/v22/c.json": "{}\n", "src/version.ts": "export const VERSION = 22;\n" };
const VERSIONED = [{ dir: "scripts/backup-contracts", pattern: "scripts/backup-contracts/v{N}", companions: ["src/version.ts=VERSION = {N}"] }];
const V1 = "node -e \"process.exit(require('fs').readdirSync('db').some((f)=>f.endsWith('_lane.sql'))?0:1)\""; // numbering-independent: it must pass before and after the renumber

function makeWorld(dir) {
  const origin = path.join(dir, "origin.git"), repo = path.join(dir, "repo"), merger = path.join(dir, "merger");
  git(["init", "-q", "--bare", "-b", "main", origin], dir);
  git(["clone", "-q", origin, repo], dir);
  writeAll(repo, BASE);
  git(["add", "-A"], repo); git(["commit", "-q", "-m", "base"], repo);
  git(["push", "-q", "origin", "main"], repo); git(["push", "-q", "origin", "main:staging"], repo); git(["fetch", "-q", "origin"], repo);
  git(["clone", "-q", origin, merger], dir);
  const gh = { issue: { ...ISSUE, state: "OPEN", labels: new Set(), comments: [] }, prs: [] };
  const sibling = () => {
    git(["checkout", "-q", "-B", "staging", "origin/staging"], merger);
    writeAll(merger, { "db/0616_sibling.sql": "select 3;\n", "scripts/backup-contracts/v23/c.json": '{"sib":1}\n', "src/version.ts": "export const VERSION = 23;\n" });
    git(["add", "-A"], merger); git(["commit", "-q", "-m", "sibling lane merged"], merger); git(["push", "-q", "origin", "staging"], merger);
  };
  let n = 0;
  const io = {
    gh: async (a) => {
      const k = a.slice(0, 2).join(" "), val = (f) => a[a.indexOf(f) + 1];
      if (a[0] === "api") return "";
      if (k === "repo view") return "main\n";
      if (k === "issue view" && a.includes("milestone")) return JSON.stringify({ milestone: null });
      if (k === "issue view") return JSON.stringify({ number: 7, title: ISSUE.title, body: ISSUE.body, state: gh.issue.state, comments: [] });
      if (k === "issue comment") { gh.issue.comments.push(val("--body")); return "https://github.com/o/r/issues/7#c1\n"; }
      if (k === "issue edit") { for (let i = 0; i < a.length; i++) { if (a[i] === "--add-label") a[i + 1].split(",").forEach((l) => gh.issue.labels.add(l)); if (a[i] === "--remove-label") a[i + 1].split(",").forEach((l) => gh.issue.labels.delete(l)); } return ""; }
      if (k === "issue close") { gh.issue.state = "CLOSED"; return ""; }
      if (k === "pr list") return "[]";
      if (k === "pr create") { const p = { number: 300, base: val("--base"), head: val("--head"), state: "OPEN" }; gh.prs.push(p); return "https://github.com/o/r/pull/300\n"; }
      if (k === "pr view") { // GitHub's answer, computed from the real branches: the sibling's v23 makes the lane CONFLICTING
        git(["fetch", "-q", "origin"], merger);
        const p = gh.prs[0];
        const clean = spawnSync("git", ["merge-tree", "--write-tree", `origin/${p.base}`, `origin/${p.head}`], { cwd: merger, env: GIT_ENV }).status === 0;
        return JSON.stringify(clean ? { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } : { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
      }
      if (k === "pr merge") {
        const p = gh.prs[0];
        git(["fetch", "-q", "origin"], merger);
        git(["checkout", "-q", "-B", p.base, `origin/${p.base}`], merger);
        git(["merge", "-q", "--no-ff", "-m", "Merge PR #300", `origin/${p.head}`], merger);
        git(["push", "-q", "origin", p.base], merger);
        p.state = "MERGED"; return "";
      }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    git: async (args, { cwd } = {}) => git(args, cwd ?? repo),
    runner: async (c) => {
      n++;
      if (c.role !== "builder") {
        const rv = { verdict: "CONFORMS", summary: "ok", issue_coverage: [{ quote: "Add a new migration and a new backup-contracts version.", status: "covered" }],
          requirements: [{ id: "R1", status: "implemented", evidence: "src/version.ts:1", validated_by: "V1" }],
          scope: ["db/0617_lane.sql", "scripts/backup-contracts/v24/c.json", "src/version.ts"].map((f) => ({ file: f, authorized_by: "D1" })), preserve: [], regressions: [] };
        return { text: "```json\n" + JSON.stringify({ ...rv, fixes_issue: true, regression: false, reason: "ok", verdict_pass: true }) + "\n```", sessionId: "s", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0, durationMs: 1, turns: 1, model: "m" };
      }
      const lean = (name, v) => writeAll(c.cwd, { [`.forge-lean/${name}`]: typeof v === "string" ? v : JSON.stringify(v) });
      const nb = ++io.builders;
      if (nb === 1) {
        lean("investigation.md", "**Verdict**: CONFIRMED\n**Confidence**: high\n**Severity**: high\n**Task Type**: feature\n\n### Root Cause\nmissing");
        lean("contract.json", { requirements: [{ id: "R1", quote: "Add a new migration and a new backup-contracts version.", disposition: "deliver" }],
          deliverables: [{ id: "D1", path: "db/0616_lane.sql", change: "migration", requirements: ["R1"] }, { id: "D2", path: "scripts/backup-contracts/v23/c.json", change: "contract", requirements: ["R1"] }, { id: "D3", path: "src/version.ts", change: "bump", requirements: ["R1"] }],
          preserve: [], validate: [{ id: "V1", command: V1 }] });
      } else if (nb === 2) {
        writeAll(c.cwd, { "db/0616_lane.sql": "select 2;\n", "scripts/backup-contracts/v23/c.json": '{"lane":1}\n', "src/version.ts": "export const VERSION = 23;\n" });
        git(["add", "-A"], c.cwd); git(["commit", "-q", "-m", "feat: migration + contract"], c.cwd);
        sibling(); // the sibling lane merges the same 0616 / v23 while this lane builds
        lean("implementation.md", "### Approach\nadd\n\n### Changes\n- db/0616_lane.sql\n\n### Acceptance Criteria Status\n- R1\n\n### Verification\n- none\n\n### Notes\nnone");
        lean("result.json", { status: "fixed", summary: "added", requirements: [{ id: "R1", status: "implemented", evidence: "db/0616_lane.sql:1" }], validation: [{ id: "V1", command: V1, exit: 0 }], amendments: [] });
      }
      return { text: "done", sessionId: "s", usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0, durationMs: 1, turns: 1, model: "m" };
    },
    builders: 0,
    reservations: [],
    // the real build-start reservation (reserveForBuild on the lane worktree's git); only the host lease store is an in-memory counter
    sequenceReserveBuild: async ({ cwd, base, deliverables, versioned }) => {
      const rs = await reserveForBuild({ git: async (a) => git(a, cwd), base, deliverables, versioned, reserve: async ({ floor, count }) => ({ numbers: Array.from({ length: count }, (_, i) => floor + 1 + i) }) });
      io.reservations.push(...rs); return rs;
    },
    // the engine's real sequence effects (check, snapshot, renumber, verify, base-sync resolve); the host lease store stays out of the test
    ...Object.fromEntries(Object.entries(makeLeanIo({ repo: "o/r" })).filter(([k]) => /^sequence(Check|Snapshot|Verify|Renumber|Resolve)$/.test(k))),
    transitionLabel: async () => {},
    requiredChecks: async () => [],
    fileFollowups: async () => ({}),
    fs: { read: async (p) => fs.readFileSync(p, "utf8"), stat: async (p) => fs.statSync(p), append: async (p, t) => fs.appendFileSync(p, t), write: async (p, t) => fs.writeFileSync(p, t),
      exists: async (p) => fs.existsSync(p), rmdir: async (p) => fs.rmSync(p, { recursive: true, force: true }) },
  };
  return { io, repo, merger, gh };
}

describe("#5235 e2e: 0616/v23 replay through runCore (real git)", { skip: !HAVE_GIT && "git not available" }, () => {
  it("renumbers to 0617/v24, revalidates, merges without needs-human", async () => {
    // the engine's real effects spawn git with process.env, so a CI host without a global git identity needs it there too
    const saved = {}; for (const k of Object.keys(GIT_ENV)) if (/^GIT_/.test(k)) { saved[k] = process.env[k]; process.env[k] = GIT_ENV[k]; }
    const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    try {
    const dir = tmpDir("seq-e2e-"), w = makeWorld(dir);
    const ret = await runCore({ issue: 7, repo: "o/r", lane: "staging", cwd: w.repo, worktreeRoot: path.join(dir, "wt"), dir: path.join(dir, "runs"), io: w.io, random: () => 0.5, stableMs: 0, livePollMs: 20, sequenceVersioned: VERSIONED });
    assert.equal(ret.terminalReason, "merged", JSON.stringify(ret));
    assert.ok(!w.gh.issue.labels.has("needs-human"));
    assert.ok(w.io.reservations.some((r) => r.kind === "numbered" && r.numbers.includes(616)) && w.io.reservations.some((r) => r.kind === "versioned" && r.numbers.includes(23)), JSON.stringify(w.io.reservations));
    git(["fetch", "-q", "origin"], w.merger);
    const at = (p) => git(["show", `origin/staging:${p}`], w.merger);
    assert.equal(at("scripts/backup-contracts/v23/c.json"), '{"sib":1}\n');
    assert.equal(at("scripts/backup-contracts/v24/c.json"), '{"lane":1}\n');
    assert.match(at("src/version.ts"), /VERSION = 24/);
    assert.equal(at("db/0617_lane.sql"), "select 2;\n");
    assert.equal(at("db/0616_sibling.sql"), "select 3;\n");
    } finally { restore(); }
  });
});
