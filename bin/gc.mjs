// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock gc` reaper (#4180). Dry-run by default. It only reclaims what ForgeDock provably owns:
 *   - resources listed in a stale lane ledger (#4179: owner pid dead on this host, or expired on another host),
 *   - docker containers/volumes labelled `forgedock.owner=1`,
 *   - `lean-*` / `agent-*` dirs under the worktree root and `feat/issue-<n>-lean` branches,
 *   - ForgeDock's own scratch under `~/.forge/tmp` (run dirs with the owner marker, runner scratch `<repoKey>/<issue>`).
 * Everything else is reported, never touched. Unpushed or uncommitted work, protected branches, branches with an open
 * PR and live lanes are always reported instead of reclaimed. Any probe failure degrades to "report", never to a reclaim.
 * All effects go through injected probes (docker, git, gh, /proc, fs, kill) so the planner is testable without a host.
 */
import * as nodeFs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { makeLedger, ledgerRoot as defaultLedgerRoot, LEDGER_TTL_MS } from "./lean/ledger.mjs";
import { makeRunTmp, procsInDir, killLedgerPid } from "./lean/effects.mjs";
import { readBranches } from "./lean/lane.mjs";
import { parseForgeYaml } from "./forge-utils.mjs";

const pexec = promisify(execFile);
export const GC_TYPES = Object.freeze(["container", "volume", "worktree", "branch", "tmp", "process"]);
const SCOPE_OF = { container: "docker", volume: "docker", worktree: "worktrees", branch: "branches", tmp: "tmp", process: "processes" };
const TYPE_OF_KIND = { worktree: "worktree", branch: "branch", tmp: "tmp", pid: "process", container: "container", volume: "volume" };
export const GC_SCOPES = Object.freeze(["docker", "worktrees", "branches", "tmp", "processes"]);
const LANE_BRANCH_RE = /^feat\/issue-(\d+)-lean$/;
const WORKTREE_DIR_RE = /^(lean|agent)-/;
const RUN_OWNER = ".forge-run-owner";

/** "30m", "6h", "2d" (or bare minutes) -> ms. Throws on anything else. */
export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)([mhd]?)$/.exec(String(s ?? "").trim());
  if (!m) throw new Error(`invalid --older-than value: ${s} (use e.g. 30m, 6h, 2d)`);
  return Math.round(Number(m[1]) * { "": 60e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2]]);
}

export function parseGcArgs(argv = []) {
  let apply = false, dry = false, olderThanMs = LEDGER_TTL_MS, olderThanGiven = false;
  const scopes = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") dry = true;
    else if (a === "--older-than") { if (i + 1 >= argv.length) throw new Error("--older-than needs a value"); olderThanMs = parseDuration(argv[++i]); olderThanGiven = true; }
    else if (a.startsWith("--older-than=")) { olderThanMs = parseDuration(a.slice("--older-than=".length)); olderThanGiven = true; }
    else if (GC_SCOPES.includes(a.slice(2)) && a.startsWith("--")) scopes.add(a.slice(2));
    else throw new Error(`unknown gc argument: ${a}`);
  }
  if (apply && dry) throw new Error("--apply and --dry-run are mutually exclusive");
  return { apply, olderThanMs, olderThanGiven, scopes: scopes.size ? scopes : new Set(GC_SCOPES) };
}

/** forge.yaml `hygiene:` defaults (#4183). TTLs in hours; `max_host_load_ratio` is the near-ceiling trigger for orchestrate GC. */
export const HYGIENE_DEFAULTS = Object.freeze({ container_ttl_hours: 6, worktree_ttl_hours: 24, tmp_ttl_hours: 6, delete_merged_branches: true, max_host_load_ratio: 0.8, auto_gc: true });

/** Top-level forge.yaml `hygiene:` block (block form only); each missing or invalid value falls back to its default. */
export function readHygiene(cwd = process.cwd(), { fs = nodeFs } = {}) {
  let h = {};
  try { h = parseForgeYaml(fs.readFileSync(join(cwd, "forge.yaml"), "utf8"))?.hygiene ?? {}; } catch { h = {}; }
  if (!h || typeof h !== "object") h = {};
  const hours = (k) => { const v = h[k], n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : HYGIENE_DEFAULTS[k]; };
  const bool = (k) => { const v = String(h[k] ?? "").trim().toLowerCase(); return v === "true" ? true : v === "false" ? false : HYGIENE_DEFAULTS[k]; };
  const ratio = Number(h.max_host_load_ratio);
  return {
    container_ttl_hours: hours("container_ttl_hours"), worktree_ttl_hours: hours("worktree_ttl_hours"), tmp_ttl_hours: hours("tmp_ttl_hours"),
    delete_merged_branches: bool("delete_merged_branches"), auto_gc: bool("auto_gc"),
    max_host_load_ratio: h.max_host_load_ratio !== undefined && h.max_host_load_ratio !== "" && ratio > 0 && ratio <= 1 ? ratio : HYGIENE_DEFAULTS.max_host_load_ratio,
  };
}

/** Per-type TTL in ms from hygiene settings: containers/volumes, worktrees/branches, tmp/processes. */
export function hygieneTtls(h = HYGIENE_DEFAULTS) {
  const ms = (x) => Math.round(Number(x) * 3600e3);
  const c = ms(h.container_ttl_hours ?? HYGIENE_DEFAULTS.container_ttl_hours), w = ms(h.worktree_ttl_hours ?? HYGIENE_DEFAULTS.worktree_ttl_hours), t = ms(h.tmp_ttl_hours ?? HYGIENE_DEFAULTS.tmp_ttl_hours);
  return { container: c, volume: c, worktree: w, branch: w, tmp: t, process: t };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== "ESRCH"; } };
const ppidFromProc = (pid, procRoot = "/proc") => {
  try { const st = nodeFs.readFileSync(join(procRoot, String(pid), "stat"), "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || 0; } catch { return 0; }
};
/** Bytes under `p` (lstat, no symlink following), capped so a huge tree cannot stall the report. null when unreadable. */
export function dirSize(p, { fs = nodeFs, maxEntries = 200000 } = {}) {
  let total = 0, n = 0;
  const walk = (d) => {
    let st; try { st = fs.lstatSync(d); } catch { return; }
    total += st.size; if (++n > maxEntries || !st.isDirectory()) return;
    let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const x of names) walk(join(d, x));
  };
  try { fs.lstatSync(p); } catch { return null; }
  walk(p);
  return total;
}

/** Real probes. Every one may be replaced in tests. */
export function makeGcProbes({ cwd = process.cwd(), home = homedir() } = {}) {
  const run = (bin) => async (args, opts = {}) => (await pexec(bin, args, { cwd: opts.cwd ?? cwd, maxBuffer: 64 * 1024 * 1024, timeout: 120000 })).stdout;
  const b = readBranches(cwd);
  return {
    cwd, host: hostname(), fs: nodeFs,
    ledgerRoot: home === homedir() ? defaultLedgerRoot() : join(home, ".forge", "ledger"),
    forgeTmpRoot: join(home, ".forge", "tmp"),
    worktreeRoot: join(cwd, ".claude", "worktrees"),
    protectedBranches: ["main", "master", "staging", b.default, b.staging].filter(Boolean),
    alive: pidAlive, ppid: (pid) => ppidFromProc(pid), procsInDir: (d) => procsInDir(d),
    killPid: async (pid, marker) => killLedgerPid(pid, marker),
    docker: run("docker"), git: run("git"), gh: run("gh"),
    dirSize: (p) => dirSize(p),
  };
}

const parseLabels = (s) => {
  if (s && typeof s === "object") return s;
  const out = {};
  for (const kv of String(s ?? "").split(",")) { const i = kv.indexOf("="); if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
  return out;
};
/** docker's "2026-10-18 10:00:00 +0200 CEST" (or RFC3339) -> ms; NaN when unparseable. */
export const parseDockerTime = (s) => {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)? ([+-])(\d\d)(\d\d)/.exec(String(s ?? ""));
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`) : Date.parse(String(s ?? ""));
};
const parseSize = (s) => {
  const m = /^([\d.]+)\s*([kKMGT]?i?B)/.exec(String(s ?? "").trim());
  if (!m) return null;
  const mult = { B: 1, kB: 1e3, KB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824, TB: 1e12, TiB: 1099511627776 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * mult);
};
const jsonLines = (s) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const isInside = (root, p) => { const r = resolve(root), x = resolve(p); return x.startsWith(r + sep); };
const isDirectChild = (root, p) => dirname(resolve(p)) === resolve(root) && !!basename(p);
const errText = (e) => String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 160);

/**
 * Build the gc plan. Returns {items, summary, notes, ledgers}. `items[]`: {type, id, sizeBytes, ageMs, owned, action, reason, ...ctx}.
 * Only items with owned && action === "reclaim" are ever acted on by applyGc.
 */
export async function planGc({ probes, scopes = new Set(GC_SCOPES), olderThanMs = LEDGER_TTL_MS, ttlMs = null, deleteMergedBranches = true, now = Date.now() } = {}) {
  const P = probes, fs = P.fs ?? nodeFs;
  const items = [], notes = [], seen = new Set(), liveIds = new Set(), ledgers = [];
  const want = (type) => scopes.has(SCOPE_OF[type]);
  const ttl = (type) => (Number.isFinite(ttlMs?.[type]) ? ttlMs[type] : olderThanMs); // forge.yaml hygiene TTLs, else --older-than
  const add = (it) => { const k = `${it.type}:${it.id}`; if (seen.has(k)) return; seen.add(k); items.push(it); };
  const age = (t) => (Number.isFinite(t) ? Math.max(0, now - t) : null);
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return NaN; } };
  const git = (args, cwd) => P.git(args, { cwd: cwd ?? P.cwd });

  /** Uncommitted or unpushed work in a checkout; null when git cannot inspect `dir` as its own top level. */
  const workIn = async (dir) => {
    try {
      const top = String(await git(["rev-parse", "--show-toplevel"], dir)).trim();
      if (!top || resolve(top) !== resolve(dir)) return null; // not its own checkout (git would walk up to the parent repo)
      if (String(await git(["status", "--porcelain"], dir)).trim()) return "uncommitted work";
      if (String(await git(["rev-list", "HEAD", "--not", "--remotes"], dir)).trim()) return "unpushed work";
      return "";
    } catch { return null; }
  };
  const nonEmpty = (d) => { try { return fs.readdirSync(d).length > 0; } catch { return false; } };

  // ---- worktree list (registered dirs and checked-out branches) ----
  let registered = new Set(), checkedOut = new Set(), worktreeListOk = false;
  if (want("worktree") || want("branch")) {
    try {
      let cur = null;
      for (const l of String(await git(["worktree", "list", "--porcelain"])).split("\n")) {
        if (l.startsWith("worktree ")) { cur = l.slice(9); registered.add(resolve(cur)); }
        else if (l.startsWith("branch refs/heads/")) checkedOut.add(l.slice(18));
      }
      worktreeListOk = true;
    } catch (e) { notes.push(`git worktree list failed: ${errText(e)}`); }
  }

  // ---- open PR heads and issue states (branches) ----
  let openHeads = null;
  const openPrHeads = async () => {
    if (openHeads) return openHeads;
    try { openHeads = new Set(JSON.parse(String(await P.gh(["pr", "list", "--state", "open", "--limit", "1000", "--json", "headRefName"]))).map((p) => p.headRefName)); }
    catch (e) { openHeads = false; notes.push(`gh pr list failed: ${errText(e)}`); }
    return openHeads;
  };
  const issueStates = new Map();
  const issueState = async (n) => {
    if (issueStates.has(n)) return issueStates.get(n);
    let s;
    try { s = String(JSON.parse(String(await P.gh(["issue", "view", String(n), "--json", "state"]))).state ?? "").toUpperCase() || null; }
    catch (e) { s = /could not resolve|not found|no issue/i.test(errText(e)) ? "INVALID" : null; }
    issueStates.set(n, s);
    return s;
  };
  const isProtected = (b) => (P.protectedBranches ?? ["main", "master", "staging"]).includes(b) || /^milestone\//.test(b) || !LANE_BRANCH_RE.test(b);
  /** Shared branch safety: never protected, never with an open PR, never with local-only commits. Returns a report reason or "". */
  const branchBlock = async (b, { local }) => {
    if (isProtected(b)) return "protected branch";
    const heads = await openPrHeads();
    if (heads === false) return "cannot verify open PRs";
    if (heads.has(b)) return "open PR";
    if (local) {
      if (checkedOut.has(b)) return "checked out in a worktree";
      try { if (String(await git(["rev-list", `refs/heads/${b}`, "--not", "--remotes"])).trim()) return "unpushed work"; }
      catch { return "cannot inspect branch"; }
    }
    return "";
  };

  // ---- 1. lane ledgers (#4179) ----
  let batches = [];
  try { batches = fs.readdirSync(P.ledgerRoot); } catch { /* no ledgers */ }
  for (const bdir of batches) {
    let files = [];
    try { files = fs.readdirSync(join(P.ledgerRoot, bdir)).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const path = join(P.ledgerRoot, bdir, f);
      let j; try { j = JSON.parse(fs.readFileSync(path, "utf8")); } catch { notes.push(`unreadable ledger ${path}`); continue; }
      if (!j || !Array.isArray(j.resources)) continue;
      const sameHost = j.host === P.host;
      // A live owner on this host is a running lane, even past `expires` (long CI waits refresh it only on register).
      const stale = sameHost ? !(Number.isSafeInteger(j.pid) && P.alive(j.pid)) : Number(j.expires) < now;
      ledgers.push({ path, batch: j.batch, lane: j.lane, stale });
      for (const r of j.resources) {
        const type = TYPE_OF_KIND[r.kind];
        if (!type) continue;
        const id = String(r.value);
        if (!stale) { liveIds.add(`${type}:${type === "worktree" || type === "tmp" ? resolve(id) : id}`); if (want(type)) add({ type, id, sizeBytes: null, ageMs: age(r.registered), owned: true, action: "report", reason: `live lane ${j.lane}`, ledger: path }); continue; }
        if (!want(type)) continue;
        const it = { type, id, sizeBytes: null, ageMs: age(r.registered), owned: true, action: "reclaim", reason: `stale ledger ${j.lane} (owner ${j.pid}@${j.host} gone)`, ledger: path, kind: r.kind, value: r.value, marker: r.marker ?? null };
        if (type === "worktree") {
          it.id = resolve(id);
          it.registered = registered.has(it.id);
          if (fs.existsSync(id)) {
            it.sizeBytes = P.dirSize?.(id) ?? null;
            const w = await workIn(id);
            if ((P.procsInDir?.(id) ?? []).length) { it.action = "report"; it.reason = "live process inside"; }
            else if (w) { it.action = "report"; it.reason = w; }
            else if (w === null && nonEmpty(id)) { it.action = "report"; it.reason = it.registered ? "cannot inspect worktree" : "unpushed work (cannot inspect)"; }
          }
        } else if (type === "branch") {
          it.local = true; it.branch = id;
          let exists = true;
          try { await git(["rev-parse", "--verify", "--quiet", `refs/heads/${id}`]); } catch { exists = false; }
          if (!exists) { it.gone = true; it.reason += ", branch already gone"; }
          else { const why = await branchBlock(id, { local: true }); if (why) { it.action = "report"; it.reason = why; } }
        } else if (type === "tmp") {
          it.id = resolve(id);
          if (!isInside(P.forgeTmpRoot, id)) { it.action = "report"; it.reason = "outside ForgeDock tmp"; }
          else it.sizeBytes = P.dirSize?.(id) ?? null;
        } else if (type === "process") {
          const pid = Number(id);
          if (!sameHost) { it.action = "report"; it.reason = "process on another host"; }
          else if (!Number.isSafeInteger(pid) || pid <= 1) { it.action = "report"; it.reason = "invalid pid"; }
          else if (P.alive(pid) && P.ppid(pid) !== 1) { it.action = "report"; it.reason = "not orphaned (parent alive)"; }
        }
        add(it);
      }
    }
  }

  // ---- 2. docker: labelled forgedock.owner=1 is owned; everything else is "not owned" ----
  if (want("container") || want("volume")) {
    const ownedBy = (labels, createdMs, type) => {
      if (labels["forgedock.owner"] !== "1") return { owned: false, action: "report", reason: "not owned" };
      let exp = Number(labels["forgedock.expires"]);
      if (Number.isFinite(exp) && exp > 0 && exp < 1e12) exp *= 1000;
      if (Number.isFinite(exp) && exp > 0 && exp < now) return { owned: true, action: "reclaim", reason: "forgedock label, expired" };
      if (Number.isFinite(createdMs) && now - createdMs >= ttl(type)) return { owned: true, action: "reclaim", reason: "forgedock label, older than TTL" };
      return { owned: true, action: "report", reason: "forgedock label, younger than TTL" };
    };
    if (want("container")) {
      try {
        for (const c of jsonLines(await P.docker(["ps", "-a", "--size", "--no-trunc", "--format", "{{json .}}"]))) {
          const name = String(c.Names ?? c.ID ?? "").split(",")[0];
          if (!name || seen.has(`container:${name}`)) continue;
          if (liveIds.has(`container:${name}`)) continue;
          const created = parseDockerTime(c.CreatedAt);
          add({ type: "container", id: name, sizeBytes: parseSize(c.Size), ageMs: age(created), ...ownedBy(parseLabels(c.Labels), created, "container") });
        }
      } catch (e) { notes.push(`docker containers unavailable: ${errText(e)}`); }
    }
    if (want("volume")) {
      try {
        const vols = jsonLines(await P.docker(["volume", "ls", "--format", "{{json .}}"]));
        const created = new Map();
        const labelled = vols.filter((v) => parseLabels(v.Labels)["forgedock.owner"] === "1").map((v) => v.Name);
        if (labelled.length) {
          try { for (const l of String(await P.docker(["volume", "inspect", "--format", "{{.Name}}\t{{.CreatedAt}}", ...labelled])).split("\n")) { const [n, t] = l.split("\t"); if (n) created.set(n, Date.parse(t)); } }
          catch { /* age unknown: kept unless expired */ }
        }
        for (const v of vols) {
          if (!v.Name || seen.has(`volume:${v.Name}`) || liveIds.has(`volume:${v.Name}`)) continue;
          add({ type: "volume", id: v.Name, sizeBytes: null, ageMs: age(created.get(v.Name)), ...ownedBy(parseLabels(v.Labels), created.get(v.Name), "volume") });
        }
      } catch (e) { notes.push(`docker volumes unavailable: ${errText(e)}`); }
    }
  }

  // ---- 3. worktrees: lean-* / agent-* under the worktree root ----
  if (want("worktree") && worktreeListOk) {
    let names = [];
    try { names = fs.readdirSync(P.worktreeRoot); } catch { /* no worktree root */ }
    for (const n of names) {
      const dir = resolve(join(P.worktreeRoot, n));
      if (seen.has(`worktree:${dir}`) || liveIds.has(`worktree:${dir}`)) continue;
      try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
      const reg = registered.has(dir);
      const it = { type: "worktree", id: dir, sizeBytes: P.dirSize?.(dir) ?? null, ageMs: age(mtime(dir)), owned: WORKTREE_DIR_RE.test(n), action: "report", reason: "", registered: reg };
      if (!it.owned) { it.reason = "not a ForgeDock worktree name"; add(it); continue; }
      const procs = P.procsInDir?.(dir) ?? [];
      const w = await workIn(dir);
      if (procs.length) it.reason = "live process inside";
      else if (reg && !(it.ageMs >= ttl("worktree"))) it.reason = "younger than TTL";
      else if (w) it.reason = w;
      else if (w === null && (reg || nonEmpty(dir))) it.reason = reg ? "cannot inspect worktree" : "unpushed work (cannot inspect)";
      else { it.action = "reclaim"; it.reason = reg ? "stale worktree, clean and pushed" : "unregistered leftover dir"; }
      add(it);
    }
  }

  // ---- 4. branches: feat/issue-<n>-lean, local and origin, abandoned (closed or invalid issue) and older than TTL ----
  if (want("branch")) {
    const scan = async (ref, local) => {
      let out = "";
      try { out = String(await git(["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", ref])); }
      catch (e) { notes.push(`git for-each-ref ${ref} failed: ${errText(e)}`); return; }
      for (const line of out.split("\n").filter(Boolean)) {
        let [name, ts] = line.split("\t");
        if (!local) { if (!name.startsWith("origin/")) continue; name = name.slice(7); }
        const m = LANE_BRANCH_RE.exec(name);
        if (!m) continue; // never consider non-lane branches (main, staging, milestone/*, user branches)
        const id = local ? name : `origin/${name}`;
        if (seen.has(`branch:${id}`) || liveIds.has(`branch:${name}`)) continue;
        const it = { type: "branch", id, branch: name, local, sizeBytes: null, ageMs: age(Number(ts) * 1000), owned: true, action: "report", reason: "" };
        const why = await branchBlock(name, { local });
        if (why) it.reason = why;
        else if (!(it.ageMs >= ttl("branch"))) it.reason = "younger than TTL";
        else {
          const st = await issueState(Number(m[1]));
          if (st === "CLOSED" || st === "INVALID") { it.action = "reclaim"; it.reason = `abandoned (issue #${m[1]} ${st.toLowerCase()})`; }
          else it.reason = st ? `issue #${m[1]} ${st.toLowerCase()}` : "cannot read issue state";
        }
        add(it);
      }
    };
    await scan("refs/heads/", true);
    await scan("refs/remotes/origin/", false);
  }

  // ---- 5. tmp: ~/.forge/tmp/runs (#4104 rule) and runner scratch ~/.forge/tmp/<repoKey>/<issue> ----
  if (want("tmp")) {
    const root = P.forgeTmpRoot;
    let top = [];
    try { top = fs.readdirSync(root); } catch { /* none */ }
    for (const n of top) {
      const p = join(root, n);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (n === "runs" && st.isDirectory()) {
        let runs = []; try { runs = fs.readdirSync(p); } catch { /* none */ }
        for (const r of runs) {
          const dir = resolve(join(p, r));
          if (seen.has(`tmp:${dir}`) || liveIds.has(`tmp:${dir}`)) continue;
          try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
          const it = { type: "tmp", id: dir, sizeBytes: P.dirSize?.(dir) ?? null, ageMs: null, owned: false, action: "report", reason: "no owner marker", runDir: true };
          try {
            const own = JSON.parse(fs.readFileSync(join(dir, RUN_OWNER), "utf8"));
            it.owned = true; it.ageMs = age(Number(own.created));
            // Same rule as makeRunTmp().prune (#4104): marker, older than the TTL, owner dead on this host.
            if (!(it.ageMs >= ttl("tmp"))) it.reason = "younger than TTL";
            else if (own.host !== P.host) it.reason = "owner on another host";
            else if (Number.isSafeInteger(own.pid) && P.alive(own.pid)) it.reason = "owner alive";
            else { it.action = "reclaim"; it.reason = "stale run tmp, owner dead"; }
          } catch { /* not ours */ }
          add(it);
        }
        continue;
      }
      if (!st.isDirectory()) { add({ type: "tmp", id: resolve(p), sizeBytes: st.size, ageMs: age(st.mtimeMs), owned: false, action: "report", reason: "unrecognised entry" }); continue; }
      let kids = []; try { kids = fs.readdirSync(p); } catch { /* unreadable */ }
      const scratch = kids.length > 0 && kids.every((k) => /^\d+$/.test(k));
      if (!scratch) { add({ type: "tmp", id: resolve(p), sizeBytes: P.dirSize?.(p) ?? null, ageMs: age(st.mtimeMs), owned: false, action: "report", reason: "unrecognised entry" }); continue; }
      for (const k of kids) {
        const dir = resolve(join(p, k));
        if (seen.has(`tmp:${dir}`) || liveIds.has(`tmp:${dir}`)) continue;
        const it = { type: "tmp", id: dir, sizeBytes: P.dirSize?.(dir) ?? null, ageMs: age(mtime(dir)), owned: true, action: "report", reason: "" };
        if (!(it.ageMs >= ttl("tmp"))) it.reason = "younger than TTL";
        else if ((P.procsInDir?.(dir) ?? []).length) it.reason = "owner alive (process inside)";
        else { it.action = "reclaim"; it.reason = "stale runner scratch, no live process"; }
        add(it);
      }
    }
  }

  if (!deleteMergedBranches) {
    for (const it of items) if (it.type === "branch" && it.action === "reclaim") { it.action = "report"; it.reason = "delete_merged_branches: false"; }
  }
  const summary = {};
  for (const t of GC_TYPES) {
    const of = items.filter((i) => i.type === t);
    summary[t] = {
      count: of.length,
      sizeBytes: of.reduce((s, i) => s + (i.sizeBytes ?? 0), 0),
      oldestMs: of.reduce((m, i) => (i.ageMs != null && i.ageMs > m ? i.ageMs : m), 0),
      reclaimable: of.filter((i) => i.owned && i.action === "reclaim").length,
      notOwned: of.filter((i) => !i.owned).length,
    };
  }
  return { items, summary, notes, ledgers, scopes: [...scopes], olderThanMs, ...(ttlMs ? { ttlMs } : {}) };
}

/** Reclaim every owned item marked "reclaim"; release ledger entries that were reclaimed. Never touches anything else. */
export async function applyGc(plan, probes) {
  const P = probes, fs = P.fs ?? nodeFs;
  const reclaimed = [], failed = [];
  const git = (args) => P.git(args, { cwd: P.cwd });
  let prune = false;
  for (const it of plan.items) {
    if (!(it.owned === true && it.action === "reclaim")) continue;
    try {
      switch (it.type) {
        case "container": await P.docker(["rm", "-f", it.id]); break;
        case "volume": await P.docker(["volume", "rm", it.id]); break;
        case "process": if (P.alive(Number(it.id)) && !(await P.killPid(Number(it.id), it.marker))) throw new Error("kill refused"); break;
        case "tmp":
          if (!isInside(P.forgeTmpRoot, it.id)) throw new Error("outside ForgeDock tmp");
          if (it.runDir) { if (!(await makeRunTmp({ root: dirname(it.id), host: P.host, alive: P.alive }).remove(it.id))) throw new Error("run marker missing"); }
          else fs.rmSync(it.id, { recursive: true, force: true });
          break;
        case "worktree":
          if (it.registered) await git(["worktree", "remove", "--force", it.id]);
          else if (fs.existsSync(it.id)) {
            if (!isDirectChild(P.worktreeRoot, it.id)) throw new Error("not a direct child of the worktree root");
            fs.rmSync(it.id, { recursive: true, force: true });
          }
          prune = true;
          break;
        case "branch":
          if (it.gone) break;
          if (it.local) await git(["branch", "-D", it.branch]);
          else await git(["push", "origin", "--delete", it.branch]);
          break;
        default: throw new Error(`unknown type ${it.type}`);
      }
      reclaimed.push(it);
      if (it.ledger) {
        const l = plan.ledgers.find((x) => x.path === it.ledger);
        if (l) { const led = makeLedger({ root: dirname(dirname(l.path)), batch: l.batch, lane: l.lane, fs }); if (led.path === l.path) led.release(it.kind, it.value); }
      }
    } catch (e) { failed.push({ ...it, error: errText(e) }); }
  }
  if (prune) { try { await git(["worktree", "prune"]); } catch { /* best effort */ } }
  for (const l of plan.ledgers.filter((x) => x.stale)) {
    const led = makeLedger({ root: dirname(dirname(l.path)), batch: l.batch, lane: l.lane, fs });
    if (led.path === l.path && led.read() && led.entries().length === 0) led.remove();
  }
  return { reclaimed, failed };
}

const fmtSize = (b) => (b == null ? "?" : b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}G` : b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : b >= 1024 ? `${Math.round(b / 1024)}K` : `${b}B`);
const fmtAge = (ms) => (ms == null ? "?" : ms >= 86400e3 ? `${Math.floor(ms / 86400e3)}d` : ms >= 3600e3 ? `${Math.floor(ms / 3600e3)}h` : `${Math.floor(ms / 60e3)}m`);

export function formatGcReport(plan, { applied = null } = {}) {
  const L = [];
  const ttlText = plan.ttlMs ? `TTL docker ${fmtAge(plan.ttlMs.container)}, worktrees ${fmtAge(plan.ttlMs.worktree)}, tmp ${fmtAge(plan.ttlMs.tmp)}` : `older than ${fmtAge(plan.olderThanMs)}`;
  L.push(`forgedock gc ${applied ? "--apply" : "(dry-run)"}: ${ttlText}, scopes ${plan.scopes.join(",")}`);
  L.push(`  ${"type".padEnd(10)} ${"count".padStart(5)} ${"size".padStart(7)} ${"oldest".padStart(6)} ${"reclaimable".padStart(11)} ${"not owned".padStart(9)}`);
  for (const t of GC_TYPES) {
    if (!plan.scopes.includes(SCOPE_OF[t])) continue;
    const s = plan.summary[t];
    L.push(`  ${t.padEnd(10)} ${String(s.count).padStart(5)} ${fmtSize(s.sizeBytes).padStart(7)} ${fmtAge(s.oldestMs).padStart(6)} ${String(s.reclaimable).padStart(11)} ${String(s.notOwned).padStart(9)}`);
  }
  for (const it of plan.items) {
    const tag = !it.owned ? "not owned" : it.action === "reclaim" ? (applied ? (applied.failed.some((f) => f.type === it.type && f.id === it.id) ? "FAILED" : "reclaimed") : "reclaim") : "report";
    L.push(`  ${tag.padEnd(9)} ${it.type.padEnd(9)} ${fmtSize(it.sizeBytes).padStart(7)} ${fmtAge(it.ageMs).padStart(5)}  ${it.id}  (${it.reason})`);
  }
  for (const n of plan.notes) L.push(`  note: ${n}`);
  for (const f of applied?.failed ?? []) L.push(`  failed: ${f.type} ${f.id}: ${f.error}`);
  const n = plan.items.filter((i) => i.owned && i.action === "reclaim").length;
  L.push(applied ? `gc: reclaimed ${applied.reclaimed.length} of ${n} item(s)` : `gc: ${n} item(s) reclaimable; run with --apply to reclaim`);
  return L.join("\n") + "\n";
}

/** CLI entry: returns the exit code (0 ok, 1 apply failures, 2 bad flags). */
export async function runGc(argv = [], { probes, hygiene = null, now = Date.now(), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  let opts;
  try { opts = parseGcArgs(argv); } catch (e) { err(`gc: ${e.message}\n`); return 2; }
  const P = probes ?? makeGcProbes();
  const h = hygiene ?? readHygiene(P.cwd ?? process.cwd(), { fs: P.fs ?? nodeFs });
  // An explicit --older-than overrides every forge.yaml hygiene TTL.
  const plan = await planGc({ probes: P, scopes: opts.scopes, olderThanMs: opts.olderThanMs, ...(opts.olderThanGiven ? {} : { ttlMs: hygieneTtls(h) }), deleteMergedBranches: h.delete_merged_branches, now });
  if (!opts.apply) { out(formatGcReport(plan)); return 0; }
  const applied = await applyGc(plan, P);
  out(formatGcReport(plan, { applied }));
  return applied.failed.length ? 1 : 0;
}

/**
 * Plan + apply with forge.yaml hygiene settings (orchestrate preflight/admission GC, #4183). Never throws: a failure
 * becomes a note. Returns {plan, applied, reclaimed, bytes}.
 */
export async function runOwnedGc({ probes, hygiene = HYGIENE_DEFAULTS, scopes = new Set(GC_SCOPES), now = Date.now() } = {}) {
  let plan = null, applied = { reclaimed: [], failed: [] };
  try {
    plan = await planGc({ probes, scopes, ttlMs: hygieneTtls(hygiene), deleteMergedBranches: hygiene.delete_merged_branches !== false, now });
    applied = await applyGc(plan, probes);
  } catch (e) {
    plan = plan ?? { items: [], summary: {}, notes: [], ledgers: [], scopes: [...scopes], olderThanMs: LEDGER_TTL_MS };
    plan.notes.push(`gc failed: ${errText(e)}`);
  }
  return { plan, applied, reclaimed: applied.reclaimed.length, bytes: applied.reclaimed.reduce((s, i) => s + (i.sizeBytes ?? 0), 0) };
}

/**
 * doctor's "Resource hygiene" line (#4183): owned counts/sizes per type, reclaimable count, and unowned items older than
 * their type TTL (reported only, never touched). warn when something is reclaimable (and not applied) or unowned-stale.
 */
export function hygieneCheck(plan, { applied = null, ttlMs = plan?.ttlMs ?? hygieneTtls() } = {}) {
  const items = plan?.items ?? [];
  const parts = [];
  for (const t of GC_TYPES) {
    const owned = items.filter((i) => i.type === t && i.owned);
    if (owned.length) parts.push(`${owned.length} ${t}${owned.length === 1 ? "" : "s"} ${fmtSize(owned.reduce((s, i) => s + (i.sizeBytes ?? 0), 0))}`);
  }
  const reclaimable = items.filter((i) => i.owned && i.action === "reclaim").length;
  const stale = items.filter((i) => !i.owned && i.ageMs != null && i.ageMs >= (ttlMs?.[i.type] ?? LEDGER_TTL_MS)).length;
  const bits = [`owned: ${parts.length ? parts.join(", ") : "none"}`];
  if (applied) bits.push(`reclaimed ${applied.reclaimed.length} of ${reclaimable}${applied.failed.length ? ` (${applied.failed.length} failed)` : ""}`);
  else bits.push(`${reclaimable} reclaimable`);
  if (stale) bits.push(`${stale} unowned stale (report only)`);
  const pending = applied ? applied.failed.length : reclaimable;
  const status = pending > 0 || stale > 0 ? "warn" : "pass";
  let detail = bits.join("; ");
  if (!applied && reclaimable > 0) detail += ". Run: npx forgedock doctor --fix  (or: npx forgedock gc --apply)";
  return { status, detail, reclaimable, stale };
}
