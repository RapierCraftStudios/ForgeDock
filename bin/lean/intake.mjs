// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Intake pause read from GitHub truth (#5555, epic #5549 Phase 0, invariant I18). `forgedock intake pause|resume|status`
 * writes `_active.intake` on the ledger control branch (audit line in controls.jsonl) and the `forge:intake-paused` label on
 * the tracker issue; the issue watch reads `_active`, the active ledger entry and the open `release/*|train/*|hotfix/*` PR
 * heads, so every host honours the pause with no local state. Only used when forge.yaml `release.managed` is on.
 */
import { updateActive, ACTIVE, LEDGER_PREFIX } from "./release-ledger.mjs";

export const INTAKE_LABEL = "forge:intake-paused";
export const RELEASE_HEAD_RE = /^(release|train|hotfix)\//;
const isMissing = (e) => e?.status === 404 || /HTTP 404|Not Found/i.test(String(e?.message ?? e));

/** `get(path)→parsed JSON` that returns null on a 404; `gh` is a runner `(args)→string`. */
export const ghGet = (gh) => async (path) => {
  try { return JSON.parse(String(await gh(["api", path])) || "null"); } catch (e) { if (isMissing(e) || /HTTP 404|Not Found/i.test(String(e?.stderr ?? ""))) return null; throw e; }
};

async function readJsonFile(get, repo, branch, file) {
  const r = await get(`repos/${repo}/contents/${file}?ref=${encodeURIComponent(branch)}`);
  if (!r) return null;
  try { return JSON.parse(Buffer.from(r.content ?? "", "base64").toString("utf8")); } catch { return null; }
}
/** `_active.active.json` or `{}` when the control branch does not exist. */
export const readActive = async (get, repo) => (await readJsonFile(get, repo, ACTIVE, "active.json")) ?? {};

/**
 * Why claims must stop, from GitHub only: `{paused: false}` or `{paused: true, reason, source, resume?}`. Checks, in order,
 * `_active.intake.paused`, an active ledger entry (the lease's release has a ledger without an end `status`) and an open PR
 * whose head is `release/*|train/*|hotfix/*`. `resume` is set when the pause names a release whose ledger has ended and
 * `autoResume` (freeze.intake_auto_resume) is on: the caller clears the pause (WAVE_DONE).
 */
export async function githubPause({ get, repo, autoResume = false }) {
  const active = await readActive(get, repo);
  const ended = async (id) => { const st = await readJsonFile(get, repo, `${LEDGER_PREFIX}${id}`, "state.json"); return st ? !!st.status : null; };
  const relId = active.lease?.release;
  const live = relId ? (await ended(relId)) !== true : false;
  if (active.intake?.paused) {
    const rel = active.intake.release;
    const done = autoResume && rel ? (await ended(rel)) === true : false;
    if (!done) return { paused: true, source: "intake", reason: `intake paused${active.intake.reason ? `: ${active.intake.reason}` : ""}${active.intake.by ? ` (by ${active.intake.by})` : ""}` };
    if (!live) return { paused: false, resume: true, reason: `release ${rel} ended` };
  }
  if (live) return { paused: true, source: "ledger", reason: `release ${relId} active in the ledger` };
  const prs = (await get(`repos/${repo}/pulls?state=open&per_page=100`)) ?? [];
  const pr = prs.find((p) => RELEASE_HEAD_RE.test(String(p?.head?.ref ?? "")));
  if (pr) return { paused: true, source: "pr", reason: `open release PR #${pr.number} (${pr.head.ref})` };
  return { paused: false };
}

/** Pause or resume intake: key-scoped `_active.intake` write with an audit entry, then the tracker label. */
export async function setIntake({ io, repo, paused, reason = null, by = null, tracker = null, release = null, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const r = await updateActive({ io, repo, credential: "driver" }, ["intake"], () => ({
    patch: { intake: paused ? { paused: true, reason, by, at, ...(release ? { release } : {}) } : { paused: false, by, at } },
    control: { at, verb: paused ? "intake-pause" : "intake-resume", by, ...(reason ? { reason } : {}), ...(release ? { release } : {}) },
  }));
  if (!r.ok) return r;
  let label = null;
  if (tracker) {
    try {
      if (paused) await io.api("POST", `repos/${repo}/issues/${tracker}/labels`, { labels: [INTAKE_LABEL] });
      else await io.api("DELETE", `repos/${repo}/issues/${tracker}/labels/${encodeURIComponent(INTAKE_LABEL)}`);
      label = true;
    } catch (e) { if (!(!paused && isMissing(e))) label = String(e?.message ?? e); }
  }
  return { ...r, label };
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const USAGE = "usage: forgedock intake pause|resume|status [--reason <text>] [--tracker <issue>] [--release <id>] [--repo owner/repo]";

/** `forgedock intake pause|resume|status`. */
export async function intakeFromCli(argv, deps = {}) {
  const [op] = argv;
  if (!["pause", "resume", "status"].includes(op)) throw new Error(USAGE);
  const { readFileSync } = await import("node:fs"), { join } = await import("node:path");
  const { readReleaseConfig, realReleaseIo } = await import("./release.mjs");
  const cwd = deps.cwd ?? process.cwd(), print = deps.print ?? ((l) => console.log(l));
  const io = deps.io ?? realReleaseIo({ env: deps.env ?? process.env, cwd });
  let raw = ""; try { raw = readFileSync(join(cwd, "forge.yaml"), "utf8"); } catch { /* defaults */ }
  const config = readReleaseConfig(raw);
  const repo = flag(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const tracker = Number(String(flag(argv, "--tracker") ?? config.tracker ?? "").replace("#", "")) || null;
  const get = async (path) => { try { return await io.api("GET", path); } catch (e) { if (isMissing(e)) return null; throw e; } };
  if (op === "status") {
    const a = (await readActive(get, repo)).intake, g = await githubPause({ get, repo, autoResume: config.intakeAutoResume });
    print(`intake: ${g.paused ? "PAUSED" : "running"}${g.reason ? ` (${g.reason})` : ""}${a?.at ? `  last change ${a.at}` : ""}`);
    return { ok: true, ...g };
  }
  const by = deps.by ?? (await io.gh(["api", "user", "-q", ".login"]).then((s) => String(s).trim()).catch(() => null));
  const r = await setIntake({ io, repo, paused: op === "pause", reason: flag(argv, "--reason"), by, tracker, release: flag(argv, "--release"), now: io.now?.() ?? Date.now() });
  if (!r.ok) throw new Error(`intake ${op} failed: ${r.refused ?? "lost the _active race"}`);
  print(`intake ${op === "pause" ? "paused" : "resumed"}${tracker ? ` (label ${INTAKE_LABEL} on #${tracker}${typeof r.label === "string" ? `: ${r.label}` : ""})` : ""}`);
  return { ok: true };
}
