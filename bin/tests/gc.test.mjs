// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forgedock gc reaper (#4180): injected docker/git/gh/ps/fs probes; real temp dirs, never real docker/git/gh/kill.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { parseGcArgs, parseDuration, planGc, applyGc, runGc, parseDockerTime, GC_SCOPES } from "../gc.mjs";

const H = 3600e3, NOW = Date.parse("2026-10-20T12:00:00Z"), HOST = "testhost";
const DESTRUCTIVE = /^(rm|volume rm|worktree remove|branch -D|push origin --delete)/;

/**
 * World: temp home + repo dir, and fake probes. `git.toplevel[dir]`, `git.dirty[dir]`, `git.unpushed[dir]` drive work
 * checks; `branches.local/remote` = [[name, unixSeconds]]; `issues[n]` = state or "INVALID"; `openPrs` = head names.
 */
function world(over = {}) {
  const base = tmpDir("gc-test-");
  const home = join(base, "home"), repo = join(base, "repo");
  const wtRoot = join(repo, ".claude", "worktrees");
  mkdirSync(wtRoot, { recursive: true }); mkdirSync(join(home, ".forge", "tmp"), { recursive: true });
  const w = {
    base, home, repo, wtRoot, ledgerRoot: join(home, ".forge", "ledger"), tmpRoot: join(home, ".forge", "tmp"),
    calls: { docker: [], git: [], gh: [], kill: [] },
    containers: [], volumes: [], registered: [], checkedOut: [], toplevel: {}, dirty: {}, unpushed: {}, unpushedBranch: {},
    branches: { local: [], remote: [] }, issues: {}, openPrs: [], alive: new Set(), ppid: {}, procs: {}, dockerDown: false,
    ...over,
  };
  w.probes = {
    cwd: repo, host: HOST, ledgerRoot: w.ledgerRoot, forgeTmpRoot: w.tmpRoot, worktreeRoot: wtRoot,
    protectedBranches: ["main", "master", "staging"],
    alive: (pid) => w.alive.has(Number(pid)),
    ppid: (pid) => w.ppid[pid] ?? 0,
    procsInDir: (d) => w.procs[resolve(d)] ?? [],
    killPid: async (pid, marker) => { w.calls.kill.push([pid, marker]); w.alive.delete(Number(pid)); return true; },
    dirSize: () => 1024,
    async docker(args) {
      w.calls.docker.push(args.join(" "));
      if (w.dockerDown) throw new Error("docker: command not found");
      if (args[0] === "ps") return w.containers.map((c) => JSON.stringify(c)).join("\n");
      if (args[0] === "volume" && args[1] === "ls") return w.volumes.map((v) => JSON.stringify(v)).join("\n");
      if (args[0] === "volume" && args[1] === "inspect") return args.slice(4).map((n) => `${n}\t${w.volumes.find((v) => v.Name === n)?.CreatedAt ?? ""}`).join("\n");
      return "";
    },
    async git(args, { cwd } = {}) {
      w.calls.git.push(`${args.join(" ")} @${cwd}`);
      const a = args.join(" ");
      if (a === "worktree list --porcelain") return [`worktree ${repo}`, ...w.registered.flatMap((d) => [`worktree ${d}`, ...(w.checkedOut[d] ? [`branch refs/heads/${w.checkedOut[d]}`] : [])])].join("\n");
      if (a === "rev-parse --show-toplevel") { if (!w.toplevel[resolve(cwd)]) throw new Error("fatal: not a git repository"); return resolve(cwd) + "\n"; }
      if (a === "status --porcelain") return w.dirty[resolve(cwd)] ? " M file\n" : "";
      if (a === "rev-list HEAD --not --remotes") return w.unpushed[resolve(cwd)] ? "abc123\n" : "";
      if (args[0] === "rev-parse" && args[1] === "--verify") { const b = args[3].slice(11); if (!w.branches.local.some(([n]) => n === b)) throw new Error("missing"); return "sha\n"; }
      if (args[0] === "rev-list" && args[1].startsWith("refs/heads/")) return w.unpushedBranch[args[1].slice(11)] ? "abc\n" : "";
      if (args[0] === "for-each-ref") {
        const list = args[2] === "refs/heads/" ? w.branches.local : w.branches.remote.map(([n, t]) => [`origin/${n}`, t]);
        return list.map(([n, t]) => `${n}\t${t}`).join("\n");
      }
      return "";
    },
    async gh(args) {
      w.calls.gh.push(args.join(" "));
      if (args[0] === "pr") return JSON.stringify(w.openPrs.map((h) => ({ headRefName: h })));
      if (args[0] === "issue") { const st = w.issues[args[2]]; if (!st || st === "INVALID") throw new Error("GraphQL: Could not resolve to an issue"); return JSON.stringify({ state: st }); }
      return "";
    },
  };
  return w;
}
const destructive = (w) => [...w.calls.docker, ...w.calls.git.map((g) => g.replace(/ @.*$/, ""))].filter((c) => DESTRUCTIVE.test(c));
const find = (plan, type, id) => plan.items.find((i) => i.type === type && (i.id === id || i.id === resolve(id)));
const old = (ms = 48 * H) => Math.floor((NOW - ms) / 1000);
const dockerTime = (ms) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000 UTC");
function writeLedger(w, { batch = "b1", lane = "lean-77", pid = 999999, host = HOST, expires = NOW + H, resources = [] } = {}) {
  const dir = join(w.ledgerRoot, batch); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${lane}.json`);
  writeFileSync(path, JSON.stringify({ v: 1, owner: "core_1", batch, lane, issue: 77, host, pid, created: NOW - 10 * H, expires, resources }));
  return path;
}
const run = async (w, argv) => { let out = ""; const code = await runGc(argv, { probes: w.probes, now: NOW, out: (s) => { out += s; }, err: (s) => { out += s; } }); return { code, out }; };

describe("forgedock gc args (#4180)", () => {
  it("defaults to dry-run, all scopes, 6h; parses --older-than and scope flags; rejects bad input", () => {
    const d = parseGcArgs([]);
    assert.equal(d.apply, false); assert.equal(d.olderThanMs, 6 * H); assert.deepEqual([...d.scopes], GC_SCOPES);
    const a = parseGcArgs(["--apply", "--older-than", "2d", "--docker", "--tmp"]);
    assert.equal(a.apply, true); assert.equal(a.olderThanMs, 48 * H); assert.deepEqual([...a.scopes].sort(), ["docker", "tmp"]);
    assert.equal(parseGcArgs(["--older-than=30m"]).olderThanMs, 30 * 60e3);
    assert.equal(parseDuration("6h"), 6 * H);
    assert.throws(() => parseDuration("soon")); assert.throws(() => parseGcArgs(["--older-than", "-1h"]));
    assert.throws(() => parseGcArgs(["--apply", "--dry-run"])); assert.throws(() => parseGcArgs(["--everything"]));
    assert.equal(parseDockerTime("2026-10-18 10:00:00 +0200 CEST"), Date.parse("2026-10-18T08:00:00Z"));
  });
  it("scope flags restrict the plan to the chosen types", async () => {
    const w = world({ containers: [{ Names: "c1", Labels: "", CreatedAt: dockerTime(NOW - H), Size: "1MB" }] });
    mkdirSync(join(w.wtRoot, "lean-1"));
    const plan = await planGc({ probes: w.probes, scopes: new Set(["docker"]), now: NOW });
    assert.deepEqual([...new Set(plan.items.map((i) => i.type))], ["container"]);
    assert.equal(w.calls.git.length + w.calls.gh.length, 0);
    const r = await run(w, ["--tmp"]);
    assert.doesNotMatch(r.out, /^  container\s/m); assert.match(r.out, /^  tmp\s/m);
  });
  it("bad flags exit 2 without probing anything", async () => {
    const w = world();
    const r = await run(w, ["--nope"]);
    assert.equal(r.code, 2); assert.equal(w.calls.git.length + w.calls.docker.length, 0);
  });
});

describe("forgedock gc docker ownership (#4180)", () => {
  const setup = () => world({
    containers: [
      { Names: "lean7-testpg", Labels: "forgedock.owner=1,forgedock.lane=7", CreatedAt: dockerTime(NOW - 30 * H), Size: "12MB (virtual 300MB)" },
      { Names: "lean8-fresh", Labels: `forgedock.owner=1,forgedock.expires=${Math.floor((NOW + H) / 1000)}`, CreatedAt: dockerTime(NOW - H), Size: "1MB" },
      { Names: "lean9-expired", Labels: `forgedock.owner=1,forgedock.expires=${NOW - H}`, CreatedAt: dockerTime(NOW - H), Size: "1MB" },
      { Names: "sqv-postgres", Labels: "", CreatedAt: dockerTime(NOW - 900 * H), Size: "50MB" },
    ],
    volumes: [
      { Name: "fd_vol", Labels: "forgedock.owner=1", CreatedAt: new Date(NOW - 30 * H).toISOString() },
      { Name: "user_data", Labels: "com.docker.compose.project=sqv", CreatedAt: new Date(NOW - 900 * H).toISOString() },
    ],
  });
  it("dry-run (the default) reports every type with count/size/age and calls nothing destructive", async () => {
    const w = setup();
    const r = await run(w, []);
    assert.equal(r.code, 0);
    assert.deepEqual(destructive(w), []);
    for (const t of ["container", "volume", "worktree", "branch", "tmp", "process"]) assert.match(r.out, new RegExp(`^  ${t}\\s+\\d+\\s+\\S+\\s+\\S+\\s+\\d+\\s+\\d+$`, "m"), t);
    assert.match(r.out, /not owned\s+container .*sqv-postgres/);
    assert.match(r.out, /reclaim\s+container .*lean7-testpg/);
    assert.match(r.out, /run with --apply/);
  });
  it("--apply removes only labelled, stale containers/volumes; unlabelled ones are never touched", async () => {
    const w = setup();
    const r = await run(w, ["--apply", "--docker"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(destructive(w).sort(), ["rm -f lean7-testpg", "rm -f lean9-expired", "volume rm fd_vol"]);
    assert.ok(!w.calls.docker.some((c) => /sqv-postgres|user_data|lean8-fresh/.test(c) && /^(rm|volume rm)/.test(c)));
    assert.equal(w.calls.git.length, 0, "--docker scope never touches git");
  });
  it("docker unavailable degrades to a note, never a failure", async () => {
    const w = setup(); w.dockerDown = true;
    const r = await run(w, ["--apply", "--docker"]);
    assert.equal(r.code, 0); assert.match(r.out, /docker containers unavailable/);
  });
});

describe("forgedock gc simulated lane crash (#4180)", () => {
  it("a dead-owner ledger's resources are reclaimable in dry-run and removed by --apply; the ledger is cleared", async () => {
    const w = world();
    const wt = join(w.wtRoot, "lean-77"); mkdirSync(wt); writeFileSync(join(wt, "f.txt"), "x");
    w.registered.push(wt); w.toplevel[resolve(wt)] = true;
    const runTmp = join(w.tmpRoot, "runs", "77-1"); mkdirSync(runTmp, { recursive: true });
    w.branches.local.push(["feat/issue-77-lean", old()]);
    w.alive.add(4242); w.ppid[4242] = 1; // orphaned builder, re-parented to init
    w.containers.push({ Names: "lean77-pg", Labels: "", CreatedAt: dockerTime(NOW - H), Size: "5MB" }); // unlabelled but ledger-registered
    w.volumes.push({ Name: "lean77-vol", Labels: "" });
    const path = writeLedger(w, { resources: [
      { kind: "worktree", value: wt, registered: NOW - 2 * H }, { kind: "branch", value: "feat/issue-77-lean", registered: NOW - 2 * H },
      { kind: "tmp", value: runTmp, registered: NOW - 2 * H }, { kind: "pid", value: 4242, marker: "claude", registered: NOW - 2 * H },
      { kind: "container", value: "lean77-pg", registered: NOW - H }, { kind: "volume", value: "lean77-vol", registered: NOW - H },
    ] });
    const dry = await run(w, ["--dry-run"]);
    assert.deepEqual(destructive(w), []);
    const plan = await planGc({ probes: w.probes, now: NOW });
    for (const [t, id] of [["worktree", wt], ["branch", "feat/issue-77-lean"], ["tmp", runTmp], ["process", "4242"], ["container", "lean77-pg"], ["volume", "lean77-vol"]]) {
      const it = find(plan, t, id);
      assert.ok(it, `${t} listed`); assert.equal(it.action, "reclaim", `${t}: ${it.reason}`); assert.equal(it.owned, true);
    }
    assert.match(dry.out, /stale ledger lean-77/);

    const r = await run(w, ["--apply"]);
    assert.equal(r.code, 0, r.out);
    const d = destructive(w);
    for (const c of [`worktree remove --force ${resolve(wt)}`, "branch -D feat/issue-77-lean", "rm -f lean77-pg", "volume rm lean77-vol"]) assert.ok(d.includes(c), `${c} in ${d}`);
    assert.deepEqual(w.calls.kill, [[4242, "claude"]]);
    assert.equal(existsSync(runTmp), false);
    assert.ok(w.calls.git.some((g) => g.startsWith("worktree prune")));
    assert.equal(existsSync(path), false, "ledger cleared once every entry is reclaimed");
  });
  it("a ledger whose owner is alive on this host (a running lane) is never touched", async () => {
    const w = world();
    w.alive.add(5000); w.alive.add(4243); w.ppid[4243] = 1;
    w.branches.local.push(["feat/issue-78-lean", old()]); w.issues["78"] = "CLOSED";
    const path = writeLedger(w, { lane: "lean-78", pid: 5000, expires: NOW - H, resources: [
      { kind: "pid", value: 4243, registered: NOW }, { kind: "branch", value: "feat/issue-78-lean", registered: NOW },
    ] });
    const r = await run(w, ["--apply"]);
    assert.equal(r.code, 0);
    assert.deepEqual(w.calls.kill, []); assert.deepEqual(destructive(w), []);
    assert.ok(existsSync(path));
  });
  it("a ledger worktree with unpushed work is reported and stays listed", async () => {
    const w = world();
    const wt = join(w.wtRoot, "lean-79"); mkdirSync(wt); writeFileSync(join(wt, "f"), "x");
    w.registered.push(wt); w.toplevel[resolve(wt)] = true; w.unpushed[resolve(wt)] = true;
    const path = writeLedger(w, { lane: "lean-79", resources: [{ kind: "worktree", value: wt, registered: NOW }] });
    await run(w, ["--apply"]);
    assert.deepEqual(destructive(w), []);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).resources.length, 1);
  });
  it("a ledger pid that is not orphaned (parent alive) is never signalled", async () => {
    const w = world();
    w.alive.add(4244); w.ppid[4244] = 3000;
    writeLedger(w, { lane: "lean-80", resources: [{ kind: "pid", value: 4244, registered: NOW }] });
    await run(w, ["--apply", "--processes"]);
    assert.deepEqual(w.calls.kill, []);
  });
});

describe("forgedock gc worktrees (#4180, #4103)", () => {
  it("unregistered leftover lean-*/agent-* dirs are removed; dirs with work, live processes or other names are not", async () => {
    const w = world();
    const mk = (n, files = true) => { const d = join(w.wtRoot, n); mkdirSync(d); if (files) writeFileSync(join(d, "f"), "x"); return d; };
    const leftover = mk("lean-90"); w.toplevel[resolve(leftover)] = true; // clean, pushed, unregistered
    const emptyLeft = mk("agent-abc", false); // empty, git cannot inspect
    const broken = mk("agent-def"); // git cannot inspect, has files: may hold work
    const dirty = mk("lean-91"); w.toplevel[resolve(dirty)] = true; w.dirty[resolve(dirty)] = true;
    const unpushed = mk("lean-92"); w.toplevel[resolve(unpushed)] = true; w.unpushed[resolve(unpushed)] = true;
    const busy = mk("lean-93"); w.toplevel[resolve(busy)] = true; w.procs[resolve(busy)] = [{ pid: 1, cmd: "node" }];
    const other = mk("my-own-wt"); w.toplevel[resolve(other)] = true;
    const stale = mk("agent-old"); w.toplevel[resolve(stale)] = true; w.registered.push(stale);
    const young = mk("lean-94"); w.toplevel[resolve(young)] = true; w.registered.push(young);
    for (const d of [stale]) utimesSync(d, new Date(NOW - 48 * H), new Date(NOW - 48 * H));
    utimesSync(young, new Date(NOW - H), new Date(NOW - H));

    const plan = await planGc({ probes: w.probes, scopes: new Set(["worktrees"]), now: NOW });
    const act = (d) => find(plan, "worktree", d);
    assert.equal(act(leftover).action, "reclaim");
    assert.equal(act(emptyLeft).action, "reclaim");
    assert.equal(act(broken).action, "report"); assert.match(act(broken).reason, /unpushed work/);
    assert.equal(act(dirty).reason, "uncommitted work");
    assert.equal(act(unpushed).reason, "unpushed work");
    assert.equal(act(busy).reason, "live process inside");
    assert.equal(act(other).owned, false);
    assert.equal(act(stale).action, "reclaim");
    assert.equal(act(young).reason, "younger than TTL");

    const r = await applyGc(plan, w.probes);
    assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
    assert.equal(existsSync(leftover), false); assert.equal(existsSync(emptyLeft), false);
    for (const d of [broken, dirty, unpushed, busy, other, young]) assert.ok(existsSync(d), d);
    assert.ok(destructive(w).includes(`worktree remove --force ${resolve(stale)}`));
    assert.ok(w.calls.git.some((g) => g.startsWith("worktree prune")));
  });
});

describe("forgedock gc branches (#4180)", () => {
  it("abandoned lane branches (closed/invalid issue, older than TTL) are deleted; protected, open-PR, young, open-issue and unpushed ones are not", async () => {
    const w = world({
      branches: {
        local: [["main", old()], ["staging", old()], ["milestone/x", old()], ["feat/issue-1-lean", old()], ["feat/issue-6-lean", old()], ["user/topic", old()]],
        remote: [["main", old()], ["staging", old()], ["milestone/x", old()], ["feat/issue-1-lean", old()], ["feat/issue-2-lean", old()], ["feat/issue-3-lean", old()],
          ["feat/issue-4-lean", old(H)], ["feat/issue-5-lean", old()]],
      },
      issues: { 1: "CLOSED", 2: "INVALID", 3: "CLOSED", 4: "CLOSED", 5: "OPEN", 6: "CLOSED" },
      openPrs: ["feat/issue-3-lean"], unpushedBranch: { "feat/issue-6-lean": true },
    });
    const r = await run(w, ["--apply", "--branches"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(destructive(w).sort(), ["branch -D feat/issue-1-lean", "push origin --delete feat/issue-1-lean", "push origin --delete feat/issue-2-lean"]);
    assert.match(r.out, /feat\/issue-3-lean  \(open PR\)/);
    assert.match(r.out, /feat\/issue-6-lean  \(unpushed work\)/);
    assert.ok(!/main|staging|milestone|user\/topic/.test(destructive(w).join(" ")));
  });
  it("when open PRs cannot be listed nothing is deleted", async () => {
    const w = world({ branches: { local: [], remote: [["feat/issue-1-lean", old()]] }, issues: { 1: "CLOSED" } });
    w.probes.gh = async () => { throw new Error("gh: not logged in"); };
    const r = await run(w, ["--apply", "--branches"]);
    assert.deepEqual(destructive(w), []); assert.match(r.out, /cannot verify open PRs/);
  });
});

describe("forgedock gc tmp (#4180, #4104 parity)", () => {
  it("run tmp: only marker dirs older than the TTL with a dead owner on this host; runner scratch without a live process", async () => {
    const w = world();
    const runs = join(w.tmpRoot, "runs");
    const mkRun = (n, own) => { const d = join(runs, n); mkdirSync(d, { recursive: true }); if (own) writeFileSync(join(d, ".forge-run-owner"), JSON.stringify(own)); return d; };
    const stale = mkRun("1-a", { issue: 1, pid: 111, host: HOST, created: NOW - 10 * H });
    const young = mkRun("2-b", { issue: 2, pid: 111, host: HOST, created: NOW - H });
    const live = mkRun("3-c", { issue: 3, pid: 222, host: HOST, created: NOW - 10 * H }); w.alive.add(222);
    const foreign = mkRun("4-d", { issue: 4, pid: 111, host: "other", created: NOW - 10 * H });
    const nomark = mkRun("5-e", null);
    const scratch = join(w.tmpRoot, "repo-0e11c8a4", "4100"); mkdirSync(scratch, { recursive: true });
    const busyScratch = join(w.tmpRoot, "repo-0e11c8a4", "4101"); mkdirSync(busyScratch, { recursive: true }); w.procs[resolve(busyScratch)] = [{ pid: 9, cmd: "python" }];
    for (const d of [scratch, busyScratch]) utimesSync(d, new Date(NOW - 10 * H), new Date(NOW - 10 * H));
    writeFileSync(join(w.tmpRoot, "build0.log"), "log");
    const r = await run(w, ["--apply", "--tmp"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(stale), false); assert.equal(existsSync(scratch), false);
    for (const d of [young, live, foreign, nomark, busyScratch, join(w.tmpRoot, "build0.log")]) assert.ok(existsSync(d), d);
    assert.match(r.out, /not owned\s+tmp .*build0\.log/);
  });
});

// ---- #4183: forge.yaml hygiene settings, doctor check, near-ceiling predicate, orchestrate hook ----
import { readHygiene, hygieneTtls, hygieneCheck, runOwnedGc, HYGIENE_DEFAULTS } from "../gc.mjs";
import { nearCeiling } from "../lean/admission.mjs";
import { orchestrate } from "../lean/orchestrate.mjs";

describe("forge.yaml hygiene (#4183)", () => {
  it("defaults when absent; block values honoured; invalid values fall back; auto_gc can be disabled", () => {
    const d = tmpDir("hyg-");
    assert.deepEqual(readHygiene(d), { ...HYGIENE_DEFAULTS });
    writeFileSync(join(d, "forge.yaml"), "project:\n  repo: r\nhygiene:\n  container_ttl_hours: 2\n  worktree_ttl_hours: nope\n  tmp_ttl_hours: 1.5\n  delete_merged_branches: false\n  max_host_load_ratio: 3\n  auto_gc: false\n");
    const h = readHygiene(d);
    assert.equal(h.container_ttl_hours, 2); assert.equal(h.worktree_ttl_hours, 24); assert.equal(h.tmp_ttl_hours, 1.5);
    assert.equal(h.delete_merged_branches, false); assert.equal(h.max_host_load_ratio, 0.8); assert.equal(h.auto_gc, false);
    assert.deepEqual(hygieneTtls(h), { container: 2 * H, volume: 2 * H, worktree: 24 * H, branch: 24 * H, tmp: 1.5 * H, process: 1.5 * H });
  });

  it("per-type TTLs: a 10h-old clean worktree is kept under the 24h worktree TTL, reclaimed with --older-than 6h", async () => {
    const w = world();
    const wt = join(w.wtRoot, "lean-9"); mkdirSync(wt); writeFileSync(join(wt, "f"), "x");
    w.registered.push(resolve(wt)); w.toplevel[resolve(wt)] = true;
    utimesSync(wt, new Date(NOW - 10 * H), new Date(NOW - 10 * H));
    let r = await run(w, ["--worktrees"]);
    assert.match(r.out, /TTL docker 6h, worktrees 1d, tmp 6h/);
    assert.match(r.out, /lean-9  \(younger than TTL\)/);
    r = await run(w, ["--worktrees", "--older-than", "6h"]);
    assert.match(r.out, /older than 6h/); assert.match(r.out, /reclaim .*lean-9/);
  });

  it("forge.yaml hygiene is read from the repo: container TTL and delete_merged_branches: false", async () => {
    const w = world({
      containers: [{ Names: "lean1-pg", CreatedAt: dockerTime(NOW - 3 * H), Labels: "forgedock.owner=1", Size: "1kB" }],
      branches: { local: [], remote: [["feat/issue-1-lean", old()]] }, issues: { 1: "CLOSED" },
    });
    writeFileSync(join(w.repo, "forge.yaml"), "hygiene:\n  container_ttl_hours: 2\n  delete_merged_branches: false\n");
    const r = await run(w, ["--apply", "--docker", "--branches"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(destructive(w), ["rm -f lean1-pg"]);
    assert.match(r.out, /feat\/issue-1-lean  \(delete_merged_branches: false\)/);
  });

  it("doctor Resource hygiene check: counts/sizes of owned leftovers, warns on reclaimable and unowned stale; --fix applies", async () => {
    const w = world({
      containers: [
        { Names: "lean1-pg", CreatedAt: dockerTime(NOW - 10 * H), Labels: "forgedock.owner=1", Size: "1kB" },
        { Names: "users-db", CreatedAt: dockerTime(NOW - 30 * H), Labels: "", Size: "1kB" },
      ],
    });
    const plan = await planGcFor(w);
    const c = hygieneCheck(plan);
    assert.equal(c.status, "warn"); assert.equal(c.reclaimable, 1); assert.equal(c.stale, 1);
    assert.match(c.detail, /owned: 1 container/); assert.match(c.detail, /1 reclaimable/); assert.match(c.detail, /1 unowned stale \(report only\)/); assert.match(c.detail, /doctor --fix/);
    const res = await runOwnedGc({ probes: w.probes, hygiene: HYGIENE_DEFAULTS, now: NOW });
    assert.equal(res.reclaimed, 1); assert.deepEqual(destructive(w), ["rm -f lean1-pg"]);
    const after = hygieneCheck(res.plan, { applied: res.applied });
    assert.match(after.detail, /reclaimed 1 of 1/);
    const clean = hygieneCheck(await planGcFor(world()));
    assert.equal(clean.status, "pass"); assert.match(clean.detail, /owned: none; 0 reclaimable/);
  });

  it("runOwnedGc never throws", async () => {
    const w = world(); w.probes.git = async () => { throw new Error("boom"); }; w.probes.fs = { readdirSync() { throw new Error("x"); } };
    const r = await runOwnedGc({ probes: w.probes, now: NOW });
    assert.equal(r.reclaimed, 0);
  });
});

async function planGcFor(w) {
  const { planGc: plan } = await import("../gc.mjs");
  return plan({ probes: w.probes, ttlMs: hygieneTtls(), now: NOW });
}

describe("near the admission ceiling (#4183)", () => {
  const host = (o) => ({ loadAvg1: () => o.load ?? 0, cores: () => o.cores ?? 4, memAvailableMb: () => o.mem ?? 64000, tmpPaths: () => ["/t"], freeMb: () => o.tmp ?? 64000 });
  it("true within the ratio of any threshold, false otherwise, on disabled admission or failed probes", async () => {
    assert.equal(await nearCeiling({ host: host({ load: 13 }) }), true); // 3.25/core >= 0.8*4
    assert.equal(await nearCeiling({ host: host({ load: 12 }) }), false);
    assert.equal(await nearCeiling({ host: host({ mem: 2500 }) }), true); // <= 2048/0.8
    assert.equal(await nearCeiling({ host: host({ tmp: 1200 }) }), true);
    assert.equal(await nearCeiling({ host: host({ load: 13 }), ratio: 1 }), false);
    assert.equal(await nearCeiling({ host: host({ load: 13 }), cfg: { enabled: false } }), false);
    assert.equal(await nearCeiling({ host: { loadAvg1: () => { throw new Error("x"); }, memAvailableMb: () => NaN } }), false);
    assert.equal(await nearCeiling({}), false);
  });
});

describe("orchestrate beforeAdmit hook (#4183)", () => {
  it("runs before admissions while issues are ready; its errors never stop the batch", async () => {
    let calls = 0;
    const rows = await orchestrate({ issues: [1, 2], parallel: 1, readBody: async () => "", runOne: async () => ({ terminalReason: "merged", pr: 1 }),
      beforeAdmit: async () => { calls++; throw new Error("gc down"); } });
    assert.deepEqual(rows.map((r) => r.outcome), ["merged", "merged"]);
    assert.equal(calls, 2);
  });
});
