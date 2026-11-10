// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { cutSnapshot, pickFixes, recut, checkChain, verifyRelease, cleanupSnapshot, parseRecord, withRecord, branchName, patternPrefix } from "./release-snapshot.mjs";

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const mk = (cwd) => (args, { env, input } = {}) => execFileSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, ...ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });

/** A bare origin and a clone with main = staging = one commit; `commit` adds a file commit on staging and pushes it. */
function repo() {
  const root = tmpDir("snap-"), origin = join(root, "origin.git"), work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { env: { ...process.env, ...ENV } });
  execFileSync("git", ["clone", "-q", origin, work], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  const git = mk(work);
  git(["checkout", "-q", "-b", "main"]);
  writeFileSync(join(work, "a.txt"), "a\n"); git(["add", "."]); git(["commit", "-qm", "init"]); git(["push", "-q", "origin", "main"]);
  git(["checkout", "-q", "-b", "staging"]); git(["push", "-q", "origin", "staging"]);
  const commit = (file, text, msg) => { writeFileSync(join(work, file), text); git(["add", "."]); git(["commit", "-qm", msg]); git(["push", "-q", "origin", "staging"]); return git(["rev-parse", "HEAD"]).trim(); };
  return { git, work, origin, commit };
}

/** gh fake: merged staging PRs (`prs`), release-blocker issue numbers, and the body of the release PR. */
function fakeGh({ prs = [], issues = [], released = [] } = {}) {
  const w = { body: "", edits: 0, prs, issues };
  const gh = async (a) => {
    const j = a.join(" ");
    if (j.startsWith("pr list") && j.includes("--json headRefName")) return JSON.stringify(released.map((headRefName) => ({ headRefName })));
    if (j.startsWith("pr list") && j.includes("closingIssuesReferences")) return JSON.stringify(w.prs);
    if (j.startsWith("issue list")) return JSON.stringify(w.issues.map((number) => ({ number })));
    if (j.startsWith("pr view") && j.includes("--json body")) return JSON.stringify({ body: w.body });
    if (j.startsWith("pr edit")) { w.body = a[a.indexOf("--body") + 1]; w.edits++; return ""; }
    if (a[0] === "api") return JSON.stringify([{ number: 9, body: w.body }]);
    throw new Error(`unexpected gh ${j}`);
  };
  return { gh, w };
}

const setup = async (opts = {}) => {
  const r = repo();
  const { gh, w } = fakeGh(opts);
  const io = { gh, now: () => Date.parse("2026-11-10T12:00:00Z") };
  const ctx = { io, git: r.git, repo: "o/r", staging: "staging", def: "main", state: { id: "r1", steps: { "release-pr": { result: { pr: 9 } } } }, save() {} };
  return { ...r, io, w, ctx };
};
const cut = async (s) => {
  const c = await cutSnapshot({ io: s.io, git: s.git, repo: "o/r", staging: "staging", def: "main", id: "r1", bundle: [{ number: 3, closingIssuesReferences: [{ number: 30 }] }] });
  s.ctx.state.release = c.record;
  return c;
};

describe("snapshot cut (#5276)", () => {
  it("branch names come from the pattern; the prefix is what counts as in flight", () => {
    assert.equal(branchName("release/{date}-{n}", Date.parse("2026-11-10T00:00:00Z"), 2), "release/20261110-2");
    assert.equal(patternPrefix("release/{date}-{n}"), "release/");
    assert.throws(() => branchName("bad name/{n}", 0, 1), /invalid branch name/);
  });

  it("R5: cuts release/<id> at the staging tip and records snapshot, range, bundle and issues; later staging commits do not move it", async () => {
    const s = await setup();
    const tip = s.commit("b.txt", "b\n", "feat: b");
    const c = await cut(s);
    assert.equal(c.branch, "release/20261110-1");
    assert.equal(c.record.snapshot, tip);
    assert.deepEqual([c.record.bundle, c.record.issues, c.record.picks], [[3], [30], []]);
    s.commit("c.txt", "c\n", "feat: c (merged during the release)");
    assert.equal(s.git(["ls-remote", "origin", "refs/heads/release/20261110-1"]).split("\t")[0], tip);
    assert.deepEqual(checkChain({ git: s.git, record: c.record, sha: tip, staging: "staging", exact: true }), { ok: true, picks: 0 });
  });

  it("R11: a second release branch in flight refuses the cut", async () => {
    const s = await setup();
    await cut(s);
    const again = await cutSnapshot({ io: s.io, git: s.git, repo: "o/r", staging: "staging", def: "main", id: "r2" });
    assert.match(again.refused, /already in flight \(release\/20261110-1\)/);
  });

  it("numbers the branch after the day's earlier release PRs", async () => {
    const s = await setup({ released: ["release/20261110-1", "release/20261109-1"] });
    assert.equal((await cut(s)).branch, "release/20261110-2");
  });
});

describe("cherry-picks and the verifier (#5276)", () => {
  const blockerWorld = async () => {
    const s = await setup();
    s.commit("b.txt", "b\n", "feat: b");
    const c = await cut(s);
    const fix = s.commit("fix.txt", "fixed\n", "fix: blocker (#31)\n\nbody line");
    s.w.prs = [{ number: 40, mergeCommit: { oid: fix }, mergedAt: "2026-11-10T13:00:00Z", labels: [{ name: "release-blocker" }], closingIssuesReferences: [] }];
    return { s, c, fix };
  };

  it("R2: a merged release-blocker fix is cherry-picked onto the branch and recorded in FORGE:RELEASE (state and PR body)", async () => {
    const { s, c, fix } = await blockerWorld();
    const out = await pickFixes(s.ctx);
    assert.deepEqual(out, { picked: [40] });
    const [pick] = s.ctx.state.release.picks;
    assert.equal(pick.orig, fix);
    assert.equal(s.git(["ls-remote", "origin", `refs/heads/${c.branch}`]).split("\t")[0], pick.sha);
    assert.match(s.git(["log", "-1", "--format=%B", pick.sha]), new RegExp(`\\(cherry picked from commit ${fix}\\)`));
    assert.equal(s.git(["show", `${pick.sha}:fix.txt`]), "fixed\n");
    assert.deepEqual(parseRecord(s.w.body).picks.map((p) => p.orig), [fix]);
    assert.deepEqual(await pickFixes(s.ctx), { picked: [] }, "idempotent: a fix already on the branch is not picked twice");
    assert.deepEqual(checkChain({ git: s.git, record: s.ctx.state.release, sha: pick.sha, staging: "staging", exact: true }), { ok: true, picks: 1 });
  });

  it("picks a fix that closes a named issue even without the label", async () => {
    const { s } = await blockerWorld();
    s.w.prs = s.w.prs.map((p) => ({ ...p, labels: [], closingIssuesReferences: [{ number: 31 }] }));
    assert.deepEqual(await pickFixes(s.ctx), { picked: [] });
    assert.deepEqual(await pickFixes(s.ctx, { issues: [31] }), { picked: [40] });
  });

  it("R3: a commit pushed to the release branch that is not a recorded cherry-pick fails the check", async () => {
    const { s } = await blockerWorld();
    await pickFixes(s.ctx);
    const rec = s.ctx.state.release;
    // a hand-pushed commit on top of the recorded head
    s.git(["checkout", "-q", "-B", "tmp", rec.picks[0].sha]);
    writeFileSync(join(s.work, "evil.txt"), "x\n"); s.git(["add", "."]); s.git(["commit", "-qm", "sneaky"]);
    const evil = s.git(["rev-parse", "HEAD"]).trim();
    assert.match(checkChain({ git: s.git, record: rec, sha: evil, staging: "staging", exact: true }).why, /1 commit\(s\)|2 commit\(s\)/);
    // a commit that names a staging commit as its source but carries other changes
    s.git(["checkout", "-q", "-B", "tmp2", rec.snapshot]);
    writeFileSync(join(s.work, "evil.txt"), "x\n"); s.git(["add", "."]); s.git(["commit", "-qm", `fix\n\n(cherry picked from commit ${rec.picks[0].orig})`]);
    const fake = s.git(["rev-parse", "HEAD"]).trim();
    const forged = { ...rec, picks: [{ ...rec.picks[0], sha: fake }] };
    assert.match(checkChain({ git: s.git, record: forged, sha: fake, staging: "staging", exact: true }).why, /differs from the cherry-pick/);
    // a recorded pick whose source is not a staging commit
    const off = { ...rec, picks: [{ ...rec.picks[0], orig: rec.picks[0].sha }] };
    assert.match(checkChain({ git: s.git, record: off, sha: rec.picks[0].sha, staging: "staging", exact: true }).why, /is not a staging commit/);
  });

  it("an earlier head is a valid prefix unless the check is exact", async () => {
    const { s } = await blockerWorld();
    await pickFixes(s.ctx);
    const rec = s.ctx.state.release;
    assert.equal(checkChain({ git: s.git, record: rec, sha: rec.snapshot, staging: "staging" }).ok, true);
    assert.match(checkChain({ git: s.git, record: rec, sha: rec.snapshot, staging: "staging", exact: true }).why, /0 of 1/);
  });

  it("a conflicting pick returns an error and leaves the branch and record alone", async () => {
    const s = await setup();
    await cut(s);
    const fix = s.commit("a.txt", "fixed\n", "fix: touches a");
    s.git(["checkout", "-q", "-B", "side", "main"]); writeFileSync(join(s.work, "a.txt"), "other\n"); s.git(["commit", "-qam", "diverge"]);
    s.ctx.state.release.snapshot = s.git(["rev-parse", "HEAD"]).trim(); // a branch head whose a.txt differs from the fix's parent
    s.w.prs = [{ number: 41, mergeCommit: { oid: fix }, mergedAt: "t", labels: [{ name: "release-blocker" }], closingIssuesReferences: [] }];
    const out = await pickFixes(s.ctx);
    assert.match(out.err, /#41 .* conflicts/);
    assert.deepEqual(s.ctx.state.release.picks, []);
  });

  it("recut moves the branch to the staging tip and resets the picks", async () => {
    const { s, c } = await blockerWorld();
    await pickFixes(s.ctx);
    const tip = s.commit("d.txt", "d\n", "feat: d");
    assert.deepEqual(await recut(s.ctx), { recut: true, snapshot: tip });
    assert.deepEqual(s.ctx.state.release.picks, []);
    assert.equal(s.git(["ls-remote", "origin", `refs/heads/${c.branch}`]).split("\t")[0], tip);
    assert.equal(parseRecord(s.w.body).snapshot, tip);
  });

  it("R10: verifyRelease reads the record from the PR that contains the sha, then checks the chain", async () => {
    const { s } = await blockerWorld();
    await pickFixes(s.ctx);
    const rec = s.ctx.state.release, head = rec.picks[0].sha;
    assert.deepEqual(await verifyRelease({ io: s.io, git: s.git, repo: "o/r", staging: "staging", sha: head }), { ok: true, picks: 1, pr: 9 });
    s.w.body = "no record";
    assert.match((await verifyRelease({ io: s.io, git: s.git, repo: "o/r", staging: "staging", sha: head })).why, /no pull request/);
  });

  it("R9: cleanup deletes the release branch and tolerates a missing one", async () => {
    const { s, c } = await blockerWorld();
    assert.deepEqual(cleanupSnapshot({ git: s.git, branch: c.branch }), { deleted: true });
    assert.equal(s.git(["ls-remote", "origin", `refs/heads/${c.branch}`]).trim(), "");
    assert.equal(cleanupSnapshot({ git: s.git, branch: c.branch }).deleted, false);
  });

  it("the record marker replaces itself instead of piling up", () => {
    const once = withRecord("body", { v: 1, a: 1 }), twice = withRecord(once, { v: 1, a: 2 });
    assert.equal(twice.match(/FORGE:RELEASE/g).length, 1);
    assert.equal(parseRecord(twice).a, 2);
  });
});
