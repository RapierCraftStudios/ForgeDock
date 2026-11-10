// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// `forgedock selftest --journey [--repo <owner/sandbox>] [--pr N] [--update-snapshots]` (#5305): the scripted new-user
// journey. Stage 1 runs the packed tarball in a clean environment (only node and git) and checks the not-ready output,
// the files written and the doctor output against committed snapshots. Stage 2 (needs gh auth, claude, a sandbox repo)
// takes a fresh checkout through setup, doctor and demo --run to a merged PR and records time to first merge and the
// prompts shown. Run on the host before a release, never in Actions. All process access goes through `io`.
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { StepError } from "./selftest-live.mjs";
import { parseForgeYaml } from "../forge-utils.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_DIR = join(HERE, "..", "tests", "fixtures", "journey-snapshots");
const fail = (step, msg) => { throw new StepError(step, msg); };

/** The user-visible outputs captured in the clean environment; `file` is the snapshot name. */
export const CASES = [
  { name: "banner", args: [], file: "banner.txt" },
  { name: "help", args: ["help"], file: "help.txt" },
  { name: "doctor", args: ["doctor"], file: "doctor.txt" },
  { name: "errors", args: ["nosuchcommand"], file: "errors.txt" },
];

// Success wording that must not appear while node/git are all a clean machine has (the false banner of 2026-11-10).
const FALSE_SUCCESS = /(all checks passed|you'?re all set|setup complete|✔\s+(Claude Code|gh\b|GitHub CLI)\b)/i;
const JARGON = /\b(ENOENT|EACCES|ERR_[A-Z_]+|TypeError|ReferenceError|SyntaxError|undefined|\[object Object\])\b|\n\s+at \S+ \(/;
// A placeholder VALUE in a config file the CLI wrote; `# TODO` comments are the CLI's deliberate "verify this" flags.
const PLACEHOLDER = /<owner>|<repo>|<your[^>]*>|\byour-[\w-]+|\bCHANGEME\b|\bexample\.com\b|:\s*["']?TODO\b/i;
const CONFIG_FILE = /(^|\/)forge\.yaml$/;
const uncomment = (t) => String(t).split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#.*$/, "")).join("\n");
const PROMPT = /(\[y\/n\]|\(y\/n\)|\[Y\/n\]|\[y\/N\]|\?\s*$)/i;

/** Output with ANSI, absolute paths, versions, durations and trailing blanks removed, so a snapshot only moves on wording. */
export function scrub(text) {
  return String(text ?? "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/(?:\/(?:tmp|var|root|home|Users|usr|opt|work|pkg)\b|[A-Za-z]:\\)[^\s'"`)]*/g, "<path>")
    .replace(/\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g, "<ver>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|min)\b/g, "<time>")
    .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Regression assertions on the stage 1 results: the classes of defect the 2026-11-10 clean-room run found. */
export function assertStage1(results) {
  const bad = [];
  for (const [name, r] of Object.entries(results.cases)) {
    if (r.code === 126 || r.code === 127) bad.push([name, `the packed CLI did not start (exit ${r.code}): ${scrub(r.output).slice(0, 120).trim()}`]);
    if (FALSE_SUCCESS.test(r.output)) bad.push(["banner", `${name}: success wording on a machine without gh or Claude Code`]);
    if (JARGON.test(r.output)) bad.push(["errors", `${name}: raw runtime error text shown to the user`]);
  }
  const doctor = results.cases.doctor;
  if (doctor && doctor.code === 0) bad.push(["doctor", "doctor exits 0 on a machine without gh and Claude Code"]);
  if (doctor && !/claude/i.test(doctor.output)) bad.push(["doctor", "doctor output never names Claude Code"]);
  if (doctor && !/\bgh\b|github cli/i.test(doctor.output)) bad.push(["doctor", "doctor output never names the gh CLI"]);
  const errs = results.cases.errors;
  if (errs && errs.code === 0) bad.push(["errors", "an unknown command exits 0"]);
  for (const [path, content] of Object.entries(results.files)) {
    if (CONFIG_FILE.test(path) && PLACEHOLDER.test(uncomment(content))) bad.push(["files", `${path} holds placeholder config`]);
  }
  return bad;
}

// Installed copies under ~/.forge and ~/.claude vary by version: collapse them to their directory.
const filesSummary = (files) => [...new Set(Object.keys(files).map((p) => { const seg = p.split("/"); return seg.length > 3 ? `${seg.slice(0, 3).join("/")}/` : p; }))].sort().join("\n") + "\n";

/** Compare (or with `update` write) the scrubbed outputs against the committed snapshots; returns the notes. */
export function compareSnapshots(results, { dir = SNAPSHOT_DIR, update = false } = {}) {
  const want = { ...Object.fromEntries(CASES.map((c) => [c.file, scrub(results.cases[c.name]?.output)])), "not-ready.txt": scrub(`exit codes: ${CASES.map((c) => `${c.name}=${results.cases[c.name]?.code}`).join(" ")}\nfiles written:\n${filesSummary(results.files)}`) };
  const notes = [];
  for (const [file, text] of Object.entries(want)) {
    const path = join(dir, file);
    if (update) { mkdirSync(dir, { recursive: true }); writeFileSync(path, text); notes.push(`journey: wrote snapshot ${file}`); continue; }
    if (!existsSync(path)) fail("snapshot", `no snapshot ${file}; run \`forgedock selftest --journey --update-snapshots\` and review the diff`);
    const have = readFileSync(path, "utf8");
    if (have !== text) {
      const a = have.split("\n"), b = text.split("\n"), i = a.findIndex((l, k) => l !== b[k]);
      fail("snapshot", `${file} changed at line ${i < 0 ? a.length + 1 : i + 1}: was ${JSON.stringify(a[i] ?? "")}, now ${JSON.stringify(b[i] ?? "")}; review it and re-run with --update-snapshots`);
    }
  }
  return notes;
}

/** Stage 1: pack, run every case in the clean environment, assert, snapshot. */
export async function stage1(ctx) {
  const { io } = ctx;
  const tgz = await io.pack().catch((e) => fail("pack", `npm pack failed: ${String(e.message ?? e).slice(0, 200)}`));
  const results = { cases: {}, files: {} };
  for (const c of CASES) {
    const r = await io.clean(tgz, c.args).catch((e) => fail(c.name, `clean-environment run failed: ${String(e.message ?? e).slice(0, 200)}`));
    results.cases[c.name] = r;
    Object.assign(results.files, r.files ?? {});
  }
  const bad = assertStage1(results);
  if (bad.length) fail(bad[0][0], bad.map((b) => b[1]).join("; "));
  ctx.notes.push(...compareSnapshots(results, { dir: ctx.snapshotDir, update: ctx.update }));
}

/** Stage 2: setup, doctor green and the first merged PR on the sandbox repo; time to first merge and prompts recorded. */
export async function stage2(ctx) {
  const { io, repo } = ctx;
  if (!(await io.ghAuthed())) { ctx.notes.push("journey stage 2: skipped (gh is not authenticated)"); return; }
  if (!(await io.claudeAvailable())) { ctx.notes.push("journey stage 2: skipped (Claude Code is not available)"); return; }
  const start = io.now();
  const dir = ctx.dir = await io.mkdir();
  const run = async (step, args, opts) => {
    const r = await io.cli(args, { cwd: dir, ...opts });
    ctx.prompts.push(...String(r.stdout).split("\n").filter((l) => PROMPT.test(l)).map((l) => l.trim()));
    if (r.code !== 0) fail(step, `forgedock ${args.join(" ")} exited ${r.code}: ${scrub(r.stderr || r.stdout).slice(0, 200)}`);
    return r;
  };
  await run("setup", ["demo", dir, "--repo", repo]);
  await run("doctor", ["doctor"]);
  await run("first-merge", ["demo", dir, "--repo", repo, "--run"]);
  const prs = JSON.parse(await io.gh(["pr", "list", "-R", repo, "--state", "merged", "--json", "number,mergedAt", "--limit", "20"]));
  const merged = prs.map((p) => Date.parse(p.mergedAt)).filter((t) => t >= start).sort((a, b) => a - b)[0];
  if (!merged) fail("first-merge", `no PR merged on ${repo} after the journey started`);
  ctx.ttfmMs = merged - start;
}

async function cleanup2(ctx, errors) {
  const { io, repo } = ctx;
  if (ctx.dir) try { await io.rm(ctx.dir); } catch (e) { errors.push(`remove ${ctx.dir}: ${String(e.message ?? e).slice(0, 120)}`); }
  if (ctx.startedStage2) {
    try {
      const open = JSON.parse(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--json", "number,createdAt", "--limit", "50"]));
      for (const i of open.filter((x) => Date.parse(x.createdAt) >= ctx.startedStage2)) await io.gh(["issue", "close", String(i.number), "-R", repo]);
    } catch (e) { errors.push(`close journey issues: ${String(e.message ?? e).slice(0, 120)}`); }
  }
}

/** Run both stages; the first failure stops them, cleanup always runs. */
export async function runNewUserJourney({ repo, io, snapshotDir = SNAPSHOT_DIR, update = false }) {
  const ctx = { io, repo, snapshotDir, update, notes: [], prompts: [], ttfmMs: null, dir: null, startedStage2: null };
  let out = { ok: true, step: null, message: null };
  try {
    await stage1(ctx);
    ctx.startedStage2 = io.now();
    await stage2(ctx);
  } catch (e) { out = { ok: false, step: e.step ?? "journey", message: String(e.message ?? e) }; }
  const cleanupErrors = [];
  await cleanup2(ctx, cleanupErrors);
  return { ...out, notes: ctx.notes, cleanupErrors, ttfmMs: ctx.ttfmMs, prompts: [...new Set(ctx.prompts)] };
}

// ── real io ──────────────────────────────────────────────────────────────────────────────────────────────────
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const which = (bin) => { const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const TOOLS = ["node", "npm", "npx", "git", "sh", "env", "find", "head", "mkdir", "mktemp", "cat", "dirname", "uname", "sort", "rm", "tr", "sed", "printf"];

// Runs in the clean environment: npx the tarball with `args`, then report the exit code and every file written.
const script = (tgz, args) => `W=$(mktemp -d); H=$(mktemp -d); export HOME=$H; cd "$W"; npx --yes --package ${q(tgz)} forgedock ${args.map(q).join(" ")} 2>&1 </dev/null; rc=$?
printf '\\n@@RC %s\\n' "$rc"
for r in "$W" "$H"; do find "$r" \\( -name .npm -o -name node_modules -o -name _cacache \\) -prune -o -type f -print | while read -r f; do printf '@@FILE %s\\n' "$(printf %s "$f" | sed "s#^$W#.#;s#^$H#~#")"; head -c 4000 "$f"; printf '\\n@@END\\n'; done; done`;

export function parseCleanOutput(raw) {
  const text = String(raw), at = text.indexOf("\n@@RC ");
  if (at < 0) throw new Error("clean run produced no exit marker");
  const [rcLine, ...rest] = text.slice(at + 1).split("\n");
  const files = {};
  for (const m of rest.join("\n").matchAll(/@@FILE (.*)\n([\s\S]*?)\n@@END/g)) files[m[1]] = m[2];
  return { code: Number(rcLine.slice(5)), output: text.slice(0, at), files };
}

export function realJourneyIo(env = process.env, { docker } = {}) {
  const root = join(HERE, "..", "..");
  const useDocker = docker ?? (which("docker") && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0);
  const scratch = mkdtempSync(join(env.TMPDIR || tmpdir(), "journey-"));
  const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...o });
  const cliPath = join(root, "bin", "forgedock.mjs");
  return {
    now: () => Date.now(),
    pack: async () => {
      const r = sh("npm", ["pack", "--silent", "--pack-destination", scratch], { cwd: root });
      if (r.status !== 0) throw new Error(r.stderr.trim() || `npm pack exited ${r.status}`);
      return join(scratch, r.stdout.trim().split("\n").at(-1));
    },
    clean: async (tgz, args) => {
      if (useDocker) {
        const labels = String(env.FORGE_DOCKER_LABELS ?? "").split(/[\s,]+/).filter(Boolean).flatMap((l) => ["--label", l]);
        const r = sh("docker", ["run", "--rm", ...labels, "-v", `${dirname(tgz)}:/pkg:ro`, env.FORGE_JOURNEY_IMAGE || "node:22", "sh", "-c", script(`/pkg/${tgz.split("/").at(-1)}`, args)]);
        return parseCleanOutput(r.stdout);
      }
      // Host fallback: a PATH holding only node and git (and the shell basics), a throwaway HOME.
      const bin = join(scratch, "bin"); mkdirSync(bin, { recursive: true });
      for (const t of TOOLS) { const p = which(t); if (p?.startsWith("/") && !existsSync(join(bin, t))) try { symlinkSync(p, join(bin, t)); } catch { /* already linked */ } }
      const r = sh(join(bin, "sh"), ["-c", script(tgz, args)], { env: { PATH: bin, LANG: "C", TMPDIR: scratch, NO_COLOR: "1", CI: "1" } });
      return parseCleanOutput(r.stdout);
    },
    ghAuthed: async () => sh("gh", ["auth", "status"]).status === 0,
    claudeAvailable: async () => sh("claude", ["--version"]).status === 0,
    gh: async (args) => { const r = sh("gh", args); if (r.status !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.status}`); return r.stdout; },
    mkdir: async () => mkdtempSync(join(scratch, "demo-")),
    rm: async (d) => rmSync(d, { recursive: true, force: true }),
    cli: async (args, { cwd } = {}) => { const r = sh(process.execPath, [cliPath, ...args], { cwd, env, timeout: 45 * 60 * 1000, input: "" }); return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; },
    dispose: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const val = (argv, f) => { const i = argv.indexOf(f), v = argv[i + 1]; if (i < 0) return null; if (v == null || String(v).startsWith("--")) throw new Error(`${f} needs a value`); return v; };

/** `forgedock selftest --journey [--repo o/sandbox] [--pr N] [--release-repo o/r] [--update-snapshots]`. */
export async function journeyFromCli(argv, deps = {}) {
  const cwd = deps.cwd ?? process.cwd(), env = deps.env ?? process.env, print = deps.print ?? ((l) => console.log(l));
  let cfg = {}; try { cfg = parseForgeYaml(readFileSync(join(cwd, "forge.yaml"), "utf8")) ?? {}; } catch { /* none */ }
  const repo = [val(argv, "--repo"), cfg.selftest?.sandbox_repo].map((v) => String(v ?? "").trim()).find((v) => REPO_RE.test(v));
  if (!repo) throw new Error("no sandbox repo: pass --repo owner/sandbox or set selftest.sandbox_repo in forge.yaml\nusage: forgedock selftest --journey [--repo <owner/sandbox>] [--pr <N>] [--update-snapshots]");
  const project = cfg.project?.owner && cfg.project?.repo ? `${cfg.project.owner}/${cfg.project.repo}` : null;
  if (project && project.toLowerCase() === repo.toLowerCase()) throw new Error(`refusing to run in ${repo}: it is this project's repo (forge.yaml project); use a disposable sandbox repo`);
  const io = deps.io ?? realJourneyIo(env);
  const pr = val(argv, "--pr");
  let releaseRepo = null, head = null;
  if (pr) {
    releaseRepo = val(argv, "--release-repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
    if (releaseRepo.toLowerCase() === repo.toLowerCase()) throw new Error(`refusing to run in ${repo}: it is the release repo`);
    head = String(await io.gh(["pr", "view", String(pr), "-R", releaseRepo, "--json", "headRefOid", "--jq", ".headRefOid"])).trim();
  }
  let r;
  try { r = await runNewUserJourney({ repo, io, update: argv.includes("--update-snapshots"), ...(deps.snapshotDir ? { snapshotDir: deps.snapshotDir } : {}) }); } finally { io.dispose?.(); }
  for (const n of r.notes) print(n);
  for (const e of r.cleanupErrors) print(`cleanup: ${e}`);
  if (r.ttfmMs != null) print(`journey: time to first merged PR ${Math.round(r.ttfmMs / 1000)}s; prompts shown: ${r.prompts.length ? r.prompts.join(" | ") : "none"}`);
  print(r.ok ? `selftest --journey: all stages passed on ${repo}` : `selftest --journey FAILED at step ${r.step}: ${r.message}`);
  if (pr) {
    const { postJourneyMarker } = await import("./selftest-gate.mjs");
    await postJourneyMarker((a) => io.gh(a), releaseRepo, pr, { result: r.ok ? "pass" : "fail", sha: head, step: r.step, ttfm: r.ttfmMs == null ? null : Math.round(r.ttfmMs / 1000) });
  }
  return { ok: r.ok, step: r.step, message: r.message };
}
