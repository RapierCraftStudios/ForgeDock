// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileLive, formatReconcileSummary, liveReleaseCommand, checkIdsOf, hasHandOff } from "./live-reconcile.mjs";
import { REMEDIATION_TRACKED_MARKER } from "./issuewatch-reconcile.mjs";

const BOT = { author_association: "NONE", user: { login: "forgedock[bot]", type: "Bot" } };
const LIVE = "1111111111111111111111111111111111111111";
const FIX = "abcdef1234567890abcdef1234567890abcdef12";
const traj = { ...BOT, body: `<!-- FORGE:TRAJECTORY -->\n| Merge | merge commit | merged at ${FIX} |` };
const RELEASE_YAML = "version: 1\ndeploy:\n  live_release_command: ./live.sh\n";
const config = { env: [], timeoutS: 30, sweepDays: 30, enabled: true };

/**
 * A fake gh/git world. `ancestor` says whether the fix is in the live SHA; `liveOut` is the live-release command output (null: it fails);
 * `checks` the checks file on origin/main; `runs` maps a check command to its exit code.
 */
function world({ body = "Fix.", comments = [traj], labels = ["workflow:merged"], ancestor = true, liveOut = LIVE, checks = null, runs = {}, releaseYaml = RELEASE_YAML } = {}) {
  const w = { calls: [], comments: [], closed: [], edits: [], ran: [], state: "open", labels: [...labels], issueComments: [...comments] };
  w.io = {
    async rehearse(cmd) { w.ran.push(cmd); return liveOut == null ? { ok: false, output: "" } : { ok: true, output: `${liveOut}\n` }; },
    async gh(a) {
      w.calls.push(a);
      if (a[0] === "api" && /\/comments$/.test(a[1])) return w.issueComments.map((c) => JSON.stringify(c)).join("\n");
      if (a[0] === "api") return JSON.stringify({ number: 7, state: w.state, body, labels: w.labels.map((name) => ({ name })) });
      if (a[0] === "issue" && a[1] === "list" && a.includes("--label")) return JSON.stringify(w.state === "open" && w.labels.includes(a[a.indexOf("--label") + 1]) ? [{ number: 7 }] : []);
      if (a[0] === "issue" && a[1] === "list") return JSON.stringify([{ number: 90, body: "<!-- FORGE:POSTDEPLOY_ROLLUP: x -->\n- [ ] `R1` — post-deploy: [check:smoke] #7" }]);
      if (a[0] === "issue" && a[1] === "comment") { const b = a[a.indexOf("--body") + 1]; w.comments.push(b); w.issueComments.push({ ...BOT, body: b }); return ""; }
      if (a[0] === "issue" && a[1] === "close") { w.closed.push(a[2]); w.state = "closed"; return ""; }
      if (a[0] === "issue" && a[1] === "edit") {
        w.edits.push(a.slice(3).filter((x) => x !== "-R" && x !== "o/r"));
        const add = a.indexOf("--add-label"), rm = a.indexOf("--remove-label");
        if (add > 0) w.labels.push(a[add + 1]);
        if (rm > 0) w.labels = w.labels.filter((l) => l !== a[rm + 1]);
        return "";
      }
      if (a[0] === "label") return "";
      if (a[0] === "pr") return "[]";
      throw new Error(`unexpected gh ${a.join(" ")}`);
    },
    async git(a) {
      w.calls.push(["git", ...a]);
      if (a[0] === "show" && a[1] === "origin/main:.forge/release.yaml") { if (releaseYaml == null) throw new Error("no file"); return releaseYaml; }
      if (a[0] === "show" && a[1] === "origin/main:forge.yaml") throw new Error("no file");
      if (a[0] === "show" && a[1] === "origin/main:.forge/post-deploy-checks.json") { if (!checks) throw new Error("no file"); return JSON.stringify(checks); }
      if (a[0] === "rev-parse") return "ok\n";
      if (a[0] === "merge-base") { if (!ancestor) throw new Error("exit 1"); return ""; }
      throw new Error(`unexpected git ${a.join(" ")}`);
    },
  };
  w.spawn = async ({ run }) => { w.ran.push(run); return { code: runs[run] ?? 0, stdout: `out:${run}`, stderr: "", timedOut: false }; };
  return w;
}
const reconcile = (w, extra = {}) => reconcileLive({ repo: "o/r", io: w.io, cwd: "/nonexistent-5704", defaultBranch: "main", config, env: { PATH: "/bin" }, spawn: w.spawn, ...extra });

describe("live reconcile (#5704)", () => {
  it("main ahead of a failed deploy: the fix is not in the live SHA, so the issue stays open with awaiting-promotion", async () => {
    const w = world({ ancestor: false, checks: { smoke: "./smoke.sh" }, body: "- [ ] `R1` — post-deploy: [check:smoke]" });
    const r = await reconcile(w);
    assert.equal(r.live, LIVE);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["awaiting-promotion"]);
    assert.deepEqual(w.closed, []);
    assert.deepEqual(w.comments, []);
    assert.ok(w.labels.includes("awaiting-promotion"));
    assert.ok(!w.ran.includes("./smoke.sh"), "no check runs before the fix is live");
    assert.ok(w.calls.some((c) => c[0] === "git" && c[1] === "merge-base" && c.includes(LIVE)), "ancestry is against the live SHA, not origin/main");
  });

  it("unknown live SHA is a no-op (fail closed): command fails, or no command configured", async () => {
    for (const w of [world({ liveOut: null }), world({ releaseYaml: null })]) {
      const r = await reconcile(w);
      assert.equal(r.live, null);
      assert.deepEqual(r.rows, []);
      assert.equal(w.calls.filter((c) => c[0] === "issue").length, 0);
      assert.match(formatReconcileSummary(r), /nothing reconciled/);
    }
  });

  it("a check that fails after going live is never closed: post-deploy-failed added, awaiting-promotion removed, output commented", async () => {
    const w = world({ labels: ["workflow:merged", "awaiting-promotion"], checks: { smoke: "./smoke.sh" }, runs: { "./smoke.sh": 1 }, body: "- [ ] `R1` — post-deploy: [check:smoke]" });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["failed"]);
    assert.deepEqual(w.closed, []);
    assert.ok(w.labels.includes("post-deploy-failed") && !w.labels.includes("awaiting-promotion"));
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0], /verification failed[\s\S]*out:\.\/smoke\.sh/);
    assert.ok(!w.comments[0].includes("FORGE:VERIFIED"));
    // the next pass does not re-run or re-comment
    const again = await reconcile(w);
    assert.deepEqual(again.rows.map((x) => x.outcome), ["failed-earlier"]);
    assert.equal(w.comments.length, 1);
  });

  it("a passing run with a failing expect (positive evidence) is a fail, never a close", async () => {
    const w = world({ checks: { quiet: { run: "./no-alert.sh", expect: "./rule-loaded.sh" } }, runs: { "./rule-loaded.sh": 1 }, body: "[check:quiet]" });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["failed"]);
    assert.deepEqual(w.closed, []);
    assert.match(w.comments[0], /expect \(positive evidence\) failed/);
  });

  it("all checks pass: FORGE:VERIFIED <live sha> posted, the issue closed and the rollup line ticked; a rerun repeats nothing", async () => {
    const w = world({ labels: ["workflow:merged", "awaiting-promotion"], checks: { smoke: "./smoke.sh" }, body: "- [ ] `R1` — post-deploy: [check:smoke]" });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["verified"]);
    assert.deepEqual(w.closed, ["7"]);
    assert.equal(w.comments.length, 1);
    assert.ok(w.comments[0].startsWith(`<!-- FORGE:VERIFIED ${LIVE} -->`));
    assert.ok(!w.labels.includes("awaiting-promotion"));
    const bodies = w.edits.filter((e) => e[0] === "--body").map((e) => e[1]);
    assert.ok(bodies.some((b) => b.includes("- [x] `R1` — post-deploy: [check:smoke] #7") && b.includes("ROLLUP")), "rollup ticked");
    const again = await reconcile(w);
    assert.deepEqual(again.rows, []);
    assert.equal(w.comments.length, 1);
    assert.deepEqual(w.closed, ["7"]);
  });

  it("an open issue already carrying FORGE:VERIFIED for the live SHA is closed without a second marker or check run", async () => {
    const w = world({ comments: [traj, { ...BOT, body: `<!-- FORGE:VERIFIED ${LIVE} -->` }], checks: { smoke: "./smoke.sh" }, body: "[check:smoke]" });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["verified"]);
    assert.equal(w.comments.length, 0);
    assert.ok(!w.ran.includes("./smoke.sh"));
    assert.deepEqual(w.closed, ["7"]);
  });

  it("orphan: no checks and no hand-off closes once live with a note; a remediation-only TRACKED note is not a hand-off", async () => {
    for (const comments of [[traj], [traj, { ...BOT, body: `${REMEDIATION_TRACKED_MARKER}\n## Merged by remediation` }]]) {
      const w = world({ comments });
      const r = await reconcile(w);
      assert.deepEqual(r.rows.map((x) => x.outcome), ["verified"]);
      assert.match(w.comments[0], /No post-deploy checks and no hand-off/);
      assert.deepEqual(w.closed, ["7"]);
    }
  });

  it("a FORGE:TRACKED hand-off with no checks stays open", async () => {
    const w = world({ comments: [traj, { ...BOT, body: "<!-- FORGE:TRACKED -->\n## Left open: partial" }] });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["tracked"]);
    assert.deepEqual(w.closed, []);
    assert.deepEqual(w.comments, []);
  });

  it("a windowed check leaves the issue open under the monitoring label", async () => {
    const w = world({ checks: { soak: { run: "./soak.sh", for: "7d" } }, body: "[check:soak]" });
    const r = await reconcile(w);
    assert.deepEqual(r.rows.map((x) => x.outcome), ["monitoring"]);
    assert.deepEqual(w.closed, []);
    assert.ok(w.labels.includes("post-deploy-monitoring"));
  });

  it("an unresolvable fix commit is skipped and reported; a named check missing from the file is not closed", async () => {
    const w = world({ comments: [] });
    assert.deepEqual((await reconcile(w)).rows.map((x) => x.outcome), ["unresolved"]);
    const m = world({ body: "[check:ghost]", checks: { smoke: "./s" } });
    assert.deepEqual((await reconcile(m)).rows.map((x) => x.outcome), ["missing-check"]);
    assert.deepEqual(m.closed, []);
  });

  it("dry run writes nothing", async () => {
    const w = world({ checks: { smoke: "./smoke.sh" }, body: "[check:smoke]" });
    const r = await reconcile(w, { dryRun: true });
    assert.deepEqual(r.rows.map((x) => x.outcome), ["verified"]);
    assert.equal(w.calls.filter((c) => c[0] === "issue" && ["comment", "close", "edit"].includes(c[1])).length, 0);
  });

  it("helpers: live command from release.yaml, check ids, hand-off, summary", async () => {
    assert.equal(await liveReleaseCommand({ io: world().io, cwd: "/nonexistent-5704", defaultBranch: "main" }), "./live.sh");
    assert.deepEqual(checkIdsOf("[check:a] x [check:b] [check:a]"), ["a", "b"]);
    assert.equal(hasHandOff([{ body: "<!-- FORGE:TRACKED -->" }]), true);
    assert.equal(hasHandOff([{ body: REMEDIATION_TRACKED_MARKER }]), false);
    assert.equal(formatReconcileSummary({ live: LIVE, rows: [{ outcome: "verified" }, { outcome: "awaiting-promotion" }] }), "live reconcile at 111111111111: verified and closed 1, awaiting promotion 1");
  });
});
