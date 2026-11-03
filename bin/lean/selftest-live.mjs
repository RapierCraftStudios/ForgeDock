// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// `forgedock selftest --live --repo <owner/sandbox> [--lang node|python] [--pr N]` (#4865): drives the real binaries
// (gh, git, forgedock orchestrate) against a disposable sandbox repo. The mocked unit tests missed #4859 (--add skipped
// every issue), #4860 (issue body wiped to FORGE:STATE), #4817 and #4818; each step below fails on one of those classes.
// All process access goes through `io` so the step logic is unit-tested with fakes; `realIo` is the live binding.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { batchRoot, listBatches, openBatch } from "./batch.mjs";
import { staticCheck, formatStatic, realGh } from "./selftest-static.mjs";
import { postMarker } from "./selftest-gate.mjs";
import { reportNightly } from "./selftest-nightly.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";

export class StepError extends Error {
  constructor(step, message) { super(message); this.step = step; }
}
const fail = (step, msg) => { throw new StepError(step, msg); };

/** Fixture per toolchain: base files plus the two trivial issues (a test that fails on the old code). */
export const FIXTURES = {
  node: {
    files: { "package.json": '{"name":"selftest-sandbox","private":true,"type":"module","scripts":{"test":"node --test"}}\n', "README.md": "ForgeDock selftest sandbox\n" },
    a: { title: "selftest A: add a()", body: "Create `src/a.js` exporting `a()` that returns `\"a\"`, and `src/a.test.js` (node:test) asserting it. The test must fail on the current code." },
    b: { title: "selftest B: add b()", body: "Create `src/b.js` exporting `b()` that returns `\"b\"`, and `src/b.test.js` (node:test) asserting it. The test must fail on the current code." },
  },
  python: {
    files: { "pyproject.toml": '[project]\nname = "selftest-sandbox"\nversion = "0.0.0"\n', "README.md": "ForgeDock selftest sandbox\n" },
    a: { title: "selftest A: add a()", body: "Create `a.py` with `def a(): return \"a\"` and `test_a.py` (pytest) asserting it. The test must fail on the current code." },
    b: { title: "selftest B: add b()", body: "Create `b.py` with `def b(): return \"b\"` and `test_b.py` (pytest) asserting it. The test must fail on the current code." },
  },
};

/** The issue body with its FORGE:STATE annotation removed. */
export const stripState = (body) => String(body ?? "").replace(/<!--\s*FORGE:STATE[\s\S]*?-->/g, "").trim();

const num = (out) => { const m = /\/issues\/(\d+)/.exec(String(out)) ?? /^(\d+)$/m.exec(String(out)); if (!m) throw new Error(`no issue number in: ${String(out).slice(0, 120)}`); return Number(m[1]); };

async function waitFor(ctx, step, what, cond, onTick) {
  const { io, timeoutMs } = ctx, t0 = io.now();
  for (;;) {
    if (onTick) await onTick();
    const v = await cond();
    if (v) return v;
    if (io.now() - t0 > timeoutMs) fail(step, `timed out waiting for ${what}`);
    await io.sleep(ctx.pollMs);
  }
}

/** Step "body": every issue body still holds its creation text (#4860). */
async function checkBodies(ctx, step = "body") {
  for (const [name, n] of Object.entries(ctx.issues)) {
    const now = JSON.parse(await ctx.io.gh(["issue", "view", String(n), "-R", ctx.repo, "--json", "body"])).body;
    if (!stripState(now).includes(ctx.bodies[n])) fail(step, `issue ${name} (#${n}) lost its body text; now: ${JSON.stringify(stripState(now).slice(0, 80))}`);
  }
}

export const STEPS = [
  { name: "create", run: async (ctx) => {
    const { io, repo, fx } = ctx;
    for (const [path, content] of Object.entries(fx.files)) {
      await io.gh(["api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=selftest fixture ${path}`, "-f", `content=${Buffer.from(content).toString("base64")}`]).catch(() => { /* already present */ });
    }
    const mk = async (t, body) => num(await io.gh(["issue", "create", "-R", repo, "--title", t, "--body", body]));
    const a = await mk(fx.a.title, fx.a.body);
    const b = await mk(fx.b.title, `${fx.b.body}\n\n**Depends on**: #${a}`);
    ctx.issues = { A: a, B: b };
    ctx.bodies = { [a]: fx.a.body, [b]: fx.b.body };
    ctx.created.push(a, b);
  } },
  { name: "add", run: async (ctx) => {
    const { io, repo, issues } = ctx;
    ctx.run = await io.orchestrate.start(repo, [issues.A], 2);
    const r = await io.cli(["orchestrate", "--add", ctx.run.id, String(issues.B)]);
    if (r.code !== 0) fail("add", `orchestrate --add exited ${r.code}: ${String(r.stderr || r.stdout).slice(0, 200)}`);
    if (/unreadable|skipped/i.test(`${r.stdout}\n${r.stderr}`)) fail("add", `--add skipped #${issues.B}: ${String(r.stdout || r.stderr).slice(0, 200)}`);
    const st = await waitFor(ctx, "add", `#${issues.B} in the batch`, async () => { const s = await io.orchestrate.state(ctx.run.id); return s?.order?.includes(issues.B) ? s : null; });
    if (!(st.deps?.[issues.B] ?? []).includes(issues.A)) fail("add", `#${issues.B} does not wait on #${issues.A} in the DAG (deps: ${JSON.stringify(st.deps?.[issues.B] ?? [])})`);
  } },
  { name: "body", run: (ctx) => checkBodies(ctx) },
  { name: "resume", run: async (ctx) => {
    const { io, issues } = ctx;
    const pid = async () => (await io.orchestrate.state(ctx.run.id))?.running?.[issues.A]?.pid ?? null;
    const before = await waitFor(ctx, "resume", `a live lane for #${issues.A}`, pid);
    await ctx.run.kill();
    ctx.run = await io.orchestrate.resume(ctx.run.id);
    await io.sleep(ctx.pollMs);
    const st = await io.orchestrate.state(ctx.run.id), after = st?.running?.[issues.A]?.pid ?? null;
    const done = st?.results?.[issues.A];
    if (!done && after !== before) fail("resume", `#${issues.A} was launched again after --resume (pid ${before} -> ${after}), not re-adopted`);
    await checkBodies(ctx, "body");
  } },
  { name: "merge", run: async (ctx) => {
    const { io, repo, issues } = ctx;
    const res = await waitFor(ctx, "merge", "both lanes to finish", async () => {
      const s = await io.orchestrate.state(ctx.run.id);
      return s?.results?.[issues.A] && s?.results?.[issues.B] ? s.results : null;
    }, () => checkBodies(ctx, "body"));
    const merged = {};
    for (const [k, n] of Object.entries(issues)) {
      if (res[n].outcome !== "merged" || !res[n].pr) fail("merge", `#${n} ended ${res[n].outcome}, not merged`);
      const pr = JSON.parse(await io.gh(["pr", "view", String(res[n].pr), "-R", repo, "--json", "mergedAt,state"]));
      if (pr.state !== "MERGED") fail("merge", `PR #${res[n].pr} for ${k} is ${pr.state}`);
      const is = JSON.parse(await io.gh(["issue", "view", String(n), "-R", repo, "--json", "state,labels"]));
      if (is.state !== "CLOSED") fail("merge", `#${n} is not closed`);
      if (!is.labels.some((l) => l.name === "workflow:merged")) fail("merge", `#${n} lacks the workflow:merged label`);
      merged[k] = Date.parse(pr.mergedAt);
    }
    if (!(merged.A <= merged.B)) fail("merge", `B merged before A (${merged.B} < ${merged.A})`);
  } },
  { name: "remote", run: async (ctx) => {
    const { io } = ctx;
    if (!io.remote) { ctx.notes.push("remote: skipped (pool not configured)"); return; }
    const c = num(await io.gh(["issue", "create", "-R", ctx.repo, "--title", `${ctx.fx.a.title.replace("A:", "C:")}`, "--body", ctx.fx.a.body]));
    ctx.created.push(c);
    const r = await io.remote.run({ repo: ctx.repo, issue: c, timeoutMs: ctx.timeoutMs, pollMs: ctx.pollMs });
    if (r.where !== "remote") fail("remote", `#${c} ran ${r.where ?? "unknown"}, not in the pool`);
    if (!r.authenticated) fail("remote", "the remote lane did not authenticate");
    const cli = await io.cliVersion();
    if (r.engineVersion !== cli) fail("remote", `sandbox engine ${r.engineVersion} != CLI ${cli}`);
  } },
];

/**
 * Run the steps in order; the first failure stops them, cleanup always runs.
 * @returns {{ok:boolean, step:string|null, message:string|null, notes:string[], cleanupErrors:string[]}}
 */
export async function runSelftestLive({ repo, lang = "node", io, timeoutMs = 45 * 60 * 1000, pollMs = 5000 }) {
  const fx = FIXTURES[lang];
  if (!fx) return { ok: false, step: "setup", message: `unknown fixture language ${lang} (node|python)`, notes: [], cleanupErrors: [] };
  const ctx = { io, repo, fx, timeoutMs, pollMs, issues: {}, bodies: {}, created: [], notes: [], run: null };
  let out = { ok: true, step: null, message: null };
  for (const s of STEPS) {
    try { await s.run(ctx); } catch (e) { out = { ok: false, step: e.step ?? s.name, message: String(e.message ?? e) }; break; }
  }
  const cleanupErrors = [];
  const tryC = async (what, f) => { try { await f(); } catch (e) { cleanupErrors.push(`${what}: ${String(e.message ?? e).slice(0, 120)}`); } };
  if (ctx.run) await tryC("stop orchestrate", () => ctx.run.kill());
  for (const n of ctx.created) {
    await tryC(`close #${n}`, () => io.gh(["issue", "close", String(n), "-R", repo]));
    await tryC(`delete branches of #${n}`, async () => {
      const refs = String(await io.gh(["api", `repos/${repo}/git/matching-refs/heads/forge/issue-${n}`, "--jq", ".[].ref"])).split("\n").filter(Boolean);
      for (const ref of refs) await io.gh(["api", "-X", "DELETE", `repos/${repo}/git/${ref}`]);
    });
    await tryC(`close PRs of #${n}`, async () => {
      const prs = String(await io.gh(["pr", "list", "-R", repo, "--search", `#${n} in:title,body`, "--state", "open", "--json", "number", "--jq", ".[].number"])).split("\n").filter(Boolean);
      for (const p of prs) await io.gh(["pr", "close", p, "-R", repo, "--delete-branch"]);
    });
  }
  return { ...out, notes: ctx.notes, cleanupErrors };
}

// ── real io + CLI ───────────────────────────────────────────────────────────────────────────────────────────
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "forgedock.mjs");

export function realIo(env = process.env, { pool = false } = {}) {
  let self;
  const root = batchRoot(env);
  const detached = (args) => { const p = spawn(process.execPath, [CLI, ...args], { detached: true, windowsHide: true, stdio: "ignore", env }); p.unref(); return { kill: async () => { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } } }; };
  const waitBatch = async (before) => { for (let i = 0; i < 60; i++) { const id = listBatches(root).find((b) => !before.has(b)); if (id) return id; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("orchestrate did not create a batch within 60s"); };
  return (self = {
    now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    gh: async (args) => { const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.status}`); return r.stdout; },
    cli: async (args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env }); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; },
    cliVersion: async () => JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8")).version,
    orchestrate: {
      start: async (repo, issues, parallel) => {
        const before = new Set(listBatches(root)), h = detached(["orchestrate", ...issues.map(String), "--parallel", String(parallel), "--repo", repo]);
        return { id: await waitBatch(before), kill: h.kill };
      },
      resume: async (id) => ({ id, ...detached(["orchestrate", "--resume", id]) }),
      state: async (id) => openBatch(root, id).store.load(),
    },
    // Step 6: one lane through the pool. The issue's FORGE:STATE records the placement and the lane's FORGE:TELEMETRY rows
    // carry the engine's forge_version (the sandbox's, not the CLI's: the #4818 stale-image defect).
    remote: pool ? { run: async ({ repo, issue, timeoutMs, pollMs }) => {
      const run = await self.orchestrate.start(repo, [issue], 1), t0 = Date.now();
      let row = null;
      try {
        while (!row && Date.now() - t0 < timeoutMs) { row = (await self.orchestrate.state(run.id))?.results?.[issue] ?? null; if (!row) await self.sleep(pollMs); }
      } finally { await run.kill(); }
      if (!row) throw new Error(`#${issue} produced no result within ${Math.round(timeoutMs / 1000)}s`);
      const v = JSON.parse(await self.gh(["issue", "view", String(issue), "-R", repo, "--json", "body,comments"]));
      const text = `${v.body}\n${v.comments.map((c) => c.body).join("\n")}`;
      const versions = [...text.matchAll(/"forge_version":"([^"]+)"/g)].map((m) => m[1]);
      return { where: /"placement":\{"where":"(\w+)"/.exec(text)?.[1] ?? null, authenticated: versions.length > 0 && !/^env\./.test(String(row.code ?? row.outcome ?? "")), engineVersion: versions.at(-1) ?? null };
    } } : null,
  });
}

/** The value after flag `f`, or null when absent. A flag with no value (end of argv, or another `--flag` next) throws. */
const flag = (argv, f) => {
  const i = argv.indexOf(f);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v == null || String(v).startsWith("--") || !String(v).trim()) throw new Error(`${f} needs a value`);
  return v;
};
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const repoOrNull = (v) => (REPO_RE.test(String(v ?? "").trim()) ? String(v).trim() : null);

/** `forgedock selftest [--static] | --live --repo <o/sandbox> [--lang node|python] [--pr N]`; non-zero exit names the failed step. */
export async function selftestFromCli(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env, print = deps.print ?? ((l) => console.log(l));
  const usage = "usage: forgedock selftest [--static] | --live [--repo <owner/sandbox>] [--lang node|python] [--pr <staging->main PR>]  (sandbox repo from --repo or forge.yaml selftest.sandbox_repo)";
  if (!argv.includes("--live") && !argv.includes("--static")) throw new Error(usage);
  const nightlyRepo = argv.includes("--nightly-report") ? flag(argv, "--nightly-report") : null;
  if (nightlyRepo) {
    // #4894: the detached nightly run. Any failure, including one before the harness starts (no sandbox repo), is filed.
    const rest = argv.filter((a, i) => a !== "--nightly-report" && argv[i - 1] !== "--nightly-report");
    const lines = [];
    let r;
    try { r = await selftestFromCli(rest, { ...deps, print: (l) => { lines.push(l); print(l); } }); } catch (e) { r = { ok: false, step: "config", message: String(e?.message ?? e) }; }
    if (!r.ok) await reportNightly({ repo: nightlyRepo, io: { gh: async (a) => (deps.io?.gh ?? realGh)(a) }, result: { step: r.step, message: r.message ?? lines.filter((l) => /FAILED|FAIL/.test(l)).join("\n") } });
    return r;
  }
  const gh = deps.io?.gh ?? realGh;
  const st = staticCheck({ root: deps.binRoot ?? join(dirname(CLI)), io: { gh: (a) => gh(a) } });
  print(formatStatic(st));
  let exitCode = st.ok ? 0 : 1, step = st.ok ? null : "static";
  if (argv.includes("--live")) {
    let cfg = {}; try { cfg = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8")) ?? {}; } catch { /* none */ }
    const repo = repoOrNull(flag(argv, "--repo") ?? cfg.selftest?.sandbox_repo);
    if (!repo) throw new Error(`no sandbox repo: pass --repo owner/sandbox or set selftest.sandbox_repo in forge.yaml\n${usage}`);
    const project = cfg.project?.owner && cfg.project?.repo ? `${cfg.project.owner}/${cfg.project.repo}` : null;
    if (project && project.toLowerCase() === repo.toLowerCase()) throw new Error(`refusing to run in ${repo}: it is this project's repo (forge.yaml project), and the harness creates, merges, closes and deletes there; use a disposable sandbox repo`);
    const lang = flag(argv, "--lang") ?? cfg.selftest?.fixture ?? "node";
    const io = deps.io ?? realIo(env, { pool: ["remote", "hybrid"].includes(String(cfg.execution?.mode ?? "")) });
    // The marker binds the head that was tested: read it (from the release repo) before the run, never after.
    const pr = flag(argv, "--pr");
    let releaseRepo = null, head = null;
    if (pr) {
      releaseRepo = flag(argv, "--release-repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
      if (releaseRepo.toLowerCase() === repo.toLowerCase()) throw new Error(`refusing to run in ${repo}: it is the release repo`);
      head = String(await io.gh(["pr", "view", String(pr), "-R", releaseRepo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim();
    }
    const r = await runSelftestLive({ repo, lang, io, ...(deps.timing ?? {}) });
    for (const n of r.notes) print(n);
    for (const e of r.cleanupErrors) print(`cleanup: ${e}`);
    if (r.ok) print(`selftest --live: all steps passed on ${repo}`);
    else { print(`selftest --live FAILED at step ${r.step}: ${r.message}`); exitCode = 1; step = r.step; }
    if (pr) await postMarker((a) => io.gh(a), releaseRepo, pr, { result: exitCode === 0 ? "pass" : "fail", sha: head, step });
    if (!r.ok) return { ok: false, step, message: r.message };
  }
  return { ok: exitCode === 0, step };
}
