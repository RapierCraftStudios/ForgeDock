// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One audited control verb set (#5556, epic #5549 Phase 0, invariants I15/I20/I24/I26): `forgedock release control <verb>`
 * (hold, resume, cancel, lane, exempt, freeze, unfreeze); `forgedock release <verb>` is an alias of the same `runControl`.
 * Every mutation needs `--reason`, is one key-scoped `updateActive` commit (state in `_active.json`, one `controls.jsonl`
 * line {at, actor, host, verb, reason, before, after, epoch}) and posts a `FORGE:CONTROL` comment on the tracker (the lease's
 * issue). `holdCheck` is read by `fenced()` before every irreversible action, so every driver obeys a hold (I24).
 * `buildDispatchArgs` is the only workflow-dispatch builder: it never carries a human break-glass input (I26).
 */
import { hostname } from "node:os";
import { readActive, readLedger, updateActive } from "./release-ledger.mjs";
import { UNSKIPPABLE, isUnskippable, parseFlakeConfig, canQuarantine } from "./release-flakes.mjs";

export const CONTROL_SCHEMA = "forgedock.release.control/v1";
export const CONTROL_MARKER = "FORGE:CONTROL";
export const VERBS = ["hold", "resume", "cancel", "lane", "exempt", "freeze", "unfreeze"];
export { UNSKIPPABLE };
export const EXEMPT_MAX_H = { skip: 24, quarantine: 14 * 24 };
export const LANES = ["train", "release", "p0", "exclude"];
const OWNED = ["holds", "cancelled", "lanes", "exemptions", "freeze"];
const BREAK_GLASS = /^(override_freeze|acknowledge_hotfix_revert|override_.*|acknowledge_.*)$/;

/** Argv of `gh workflow run`; rejects a break-glass input (I26). */
export function buildDispatchArgs({ workflow, repo, ref, inputs = {} }) {
  for (const k of Object.keys(inputs)) if (BREAK_GLASS.test(k)) throw new Error(`dispatch input ${k} is a human break-glass input; the engine never sets it (I26)`);
  return ["workflow", "run", workflow, "--repo", repo, "--ref", ref, ...Object.entries(inputs).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
}

/** The release-PR-body section listing live exemptions (I20: a demoted check appears in the PR body); "" when none. */
export function exemptionsSection(exemptions, now = Date.now()) {
  const live = Object.entries(exemptions ?? {}).filter(([, e]) => e?.until && Date.parse(e.until) > now);
  if (!live.length) return "";
  return `\n\n<!-- FORGE:EXEMPT -->\n### Exempted checks\n${live.map(([c, e]) => `- \`${c}\` (${e.mode}) until ${e.until}, issue #${e.issue}, by ${e.actor}: ${e.reason}`).join("\n")}\n`;
}

/** Why release `id` must not act (held or cancelled), else null. Throws when `_active` cannot be read (callers refuse, I5). */
export async function holdCheck(lctx, id) {
  const a = await readActive(lctx);
  const h = a.holds?.[id] ?? a.holds?.["*"];
  if (h) return `held (${h.reason ?? "no reason"})`;
  if (a.cancelled?.[id]) return `cancelled (${a.cancelled[id].reason ?? "no reason"})`;
  return null;
}

const flagOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const FLAGS = ["--repo", "--reason", "--mode", "--issue", "--until", "--force"];
const positionals = (argv) => argv.filter((a, i) => !a.startsWith("--") && !FLAGS.includes(argv[i - 1]));
const ttlHours = (s) => { const m = /^(\d+)([hd])$/.exec(String(s ?? "")); return m ? Number(m[1]) * (m[2] === "d" ? 24 : 1) : null; };

/**
 * Run one control verb. `argv` is what follows the verb. `ctx`: {io, repo, policy, actor, host, now}.
 * @returns {{schema, ok: boolean, verb, error?, ...}}; never throws for a refusal.
 */
export async function runControl(verb, argv, ctx) {
  const { io, repo, policy = null } = ctx;
  const fail = (error) => ({ schema: CONTROL_SCHEMA, ok: false, verb, error });
  if (!VERBS.includes(verb)) return fail(`unknown control verb ${verb}; one of ${VERBS.join("|")}`);
  const reason = flagOf(argv, "--reason");
  if (!reason || !reason.trim() || reason.startsWith("--")) return fail(`${verb}: --reason is required`);
  const actor = ctx.actor ?? process.env.GITHUB_ACTOR ?? process.env.USER ?? "unknown", host = ctx.host ?? hostname();
  const pos = positionals(argv);
  const lctx = { io, repo, credential: "driver" };
  const at = new Date(ctx.now ?? Date.now()).toISOString();
  let apply; // (active) => {patch, before, after} | {refuse}
  let after = null;
  if (verb === "hold" || verb === "resume" || verb === "cancel") {
    const id = pos[0];
    if (!id) return fail(`${verb}: release id required`);
    if (verb === "cancel") {
      const led = await readLedger(lctx, id).catch(() => null);
      const s = led?.state;
      if (!s) return fail(`cancel: no ledger for release ${id}`);
      if (s.steps?.promotion?.result?.merged || s.steps?.["post-merge"]?.done || s.status === "MERGED") return fail(`cancel: release ${id} is already MERGED; the only exits are LIVE or rollback`);
    }
    const key = verb === "cancel" ? "cancelled" : "holds";
    apply = (a) => {
      const before = a[key]?.[id] ?? null, next = { ...(a[key] ?? {}) };
      if (verb === "resume") delete next[id]; else next[id] = { reason, actor, at };
      return { patch: { [key]: next }, before, after: next[id] ?? null };
    };
  } else if (verb === "lane") {
    const force = flagOf(argv, "--force");
    if (!LANES.includes(force)) return fail(`lane: --force must be one of ${LANES.join("|")}`);
    const issues = pos.map((p) => p.replace(/^#/, "")).filter((p) => /^\d+$/.test(p));
    if (!issues.length) return fail("lane: at least one #issue required");
    apply = (a) => {
      const next = { ...(a.lanes ?? {}) }, before = {};
      for (const n of issues) { before[n] = next[n] ?? null; next[n] = { force, reason, actor, at }; }
      return { patch: { lanes: next }, before, after: Object.fromEntries(issues.map((n) => [n, force])) };
    };
  } else if (verb === "exempt") {
    const check = pos[0], mode = flagOf(argv, "--mode"), issue = flagOf(argv, "--issue"), hours = ttlHours(flagOf(argv, "--until"));
    if (!check) return fail("exempt: check or test name required");
    if (!(mode in EXEMPT_MAX_H)) return fail("exempt: --mode must be skip or quarantine");
    if (!/^#?\d+$/.test(issue ?? "")) return fail("exempt: --issue N is required");
    if (hours == null) return fail("exempt: --until <Nh|Nd> is required");
    if (hours > EXEMPT_MAX_H[mode]) return fail(`exempt: ${mode} expires in at most ${EXEMPT_MAX_H[mode]}h (got ${hours}h)`);
    const cfg = parseFlakeConfig(policy);
    if (isUnskippable(check, cfg.unskippable)) return fail(`exempt: ${check} is an unskippable class (${cfg.unskippable.join(", ")}) (I20)`);
    const trusted = policy?.trust?.actors ?? [];
    if (trusted.length && !trusted.includes(actor)) return fail(`exempt: actor ${actor} is not trusted (policy trust.actors)`);
    const num = String(issue).replace("#", "");
    let iv = null;
    try { iv = JSON.parse(String(await io.gh(["issue", "view", num, "--repo", repo, "--json", "number,state,labels"]))); } catch { /* unreadable: refused below */ }
    if (!iv || String(iv.number) !== num) return fail(`exempt: issue #${num} does not exist or is unreadable`);
    const nowMs = ctx.now ?? Date.now(), labels = (iv.labels ?? []).map((l) => l.name ?? l);
    const entry = { mode, issue: num, reason, actor, at, until: new Date(nowMs + hours * 3_600_000).toISOString() };
    apply = (a) => {
      if (mode === "quarantine") {
        const q = canQuarantine({ target: check, exemptions: a.exemptions, issueLabels: labels, issueOpen: String(iv.state).toUpperCase() === "OPEN", cfg, now: nowMs });
        if (!q.ok) return { refuse: `exempt: ${q.why}` };
      }
      return { patch: { exemptions: { ...(a.exemptions ?? {}), [check]: entry } }, before: a.exemptions?.[check] ?? null, after: entry };
    };
  } else { // freeze | unfreeze: the repo's own deploy variable (6.4), not a second mechanism
    const name = policy?.deploy?.freeze_variable;
    if (!name) return fail(`${verb}: policy deploy.freeze_variable is not set`);
    apply = (a) => ({ patch: { freeze: verb === "freeze" ? { variable: name, reason, actor, at } : null }, before: a.freeze ?? null, after: verb === "freeze" ? { variable: name } : null });
    ctx.afterCommit = async () => { await io.gh(verb === "freeze" ? ["variable", "set", name, "--repo", repo, "--body", "1"] : ["variable", "delete", name, "--repo", repo]); };
  }
  let line;
  const r = await updateActive(lctx, OWNED, (a) => {
    const o = apply(a);
    if (o.refuse) return { refuse: o.refuse };
    after = o.after;
    line = { at, actor, host, verb, reason, before: o.before ?? null, after: o.after ?? null, epoch: a.epoch ?? null };
    return { patch: o.patch, control: line };
  });
  if (!r.ok) return fail(r.refused ?? `could not commit the control (lost the race after ${r.attempts} attempts)`);
  if (ctx.afterCommit) await ctx.afterCommit();
  const issue = r.active.lease?.issue;
  let comment = null;
  if (issue) {
    const body = `<!-- ${CONTROL_MARKER} -->\n**${verb}** by ${actor}@${host} at ${at} (epoch ${line.epoch ?? "none"})\nreason: ${reason}\n\n<!-- ${CONTROL_MARKER} ${JSON.stringify(line)} -->`;
    comment = (await io.api("POST", `repos/${repo}/issues/${issue}/comments`, { body }))?.id ?? null;
  }
  return { schema: CONTROL_SCHEMA, ok: true, verb, entry: line, comment };
}

/** CLI: `[--repo R] [--json]` plus the verb's flags; prints one line or the JSON result; @returns the exit code. */
export async function controlFromCli(verb, argv, { io, policy, actor, host }) {
  const repo = flagOf(argv, "--repo") ?? JSON.parse(String(await io.gh(["repo", "view", "--json", "nameWithOwner"]))).nameWithOwner;
  const r = await runControl(verb, argv.filter((a) => a !== "--json"), { io, repo, policy, actor, host, now: io.now?.() });
  if (argv.includes("--json")) io.print(JSON.stringify(r));
  else io.print(r.ok ? `release ${verb}: recorded (${r.entry.at})` : `release ${verb}: refused: ${r.error}`);
  return r.ok ? 0 : 1;
}
