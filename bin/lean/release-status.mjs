// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock release status [<id>] [--watch] [--json]` and `release explain <id | #issue | PR>` (#5554, epic #5549 Phase 0):
 * read-only views of a release over the ledger (when `release.managed`) or the local cache, plus GitHub. No GitHub write is made.
 * Output carries no host name or wall clock (only recorded timestamps), so a second host prints the same bytes. JSON schemas
 * `forgedock.release.status/v1` and `forgedock.release.explain/v1`; both carry `next_actions[]`, the exact commands an agent may run.
 * `explain #N` traces the rules that exist today (labels, priority, theme_map, `Depends on` closure, the recorded release set);
 * the design's wave planner is a later issue. Effects (`io`, `gateState`, local cache) are injected, so it is unit-testable.
 */
import { readLedger, readActive, listLedgers } from "./release-ledger.mjs";
import { priorityOf, classifyTheme, closure } from "./issuewatch-release.mjs";

export const STATUS_SCHEMA = "forgedock.release.status/v1";
export const EXPLAIN_SCHEMA = "forgedock.release.explain/v1";
export const TERMINAL = ["done", "refused", "blocked", "cancelled"];
export const SKIP_LABELS = ["epic", "needs-human", "post-deploy", "workflow:merged", "awaiting-promotion", "host-task"];
const STEPS = ["preflight", "host-preflight", "release-pr", "review", "fixes", "mark-ready", "rehearsal", "promotion", "post-merge"];
const json = (s) => JSON.parse(String(s || "null"));

/** Newest release id: the lease's, else the newest ledger branch, else the newest local one. */
async function pickId({ io, repo, config, local }) {
  const ctx = { io, repo, credential: "driver" };
  if (config?.managed && io.api) {
    const active = await readActive(ctx);
    if (active.lease?.release) return active.lease.release;
    const ids = await listLedgers(ctx);
    if (ids.length) return ids.sort().at(-1);
  }
  return local.ids().sort().at(-1) ?? null;
}

/** The release `id` (default: newest) as `{schema, ...}`; `null` when there is none. */
export async function collectStatus({ io, repo, id, config = {}, local, gateState }) {
  id ??= await pickId({ io, repo, config, local });
  if (!id) return null;
  const ctx = { io, repo, credential: "driver" }, managed = !!(config.managed && io.api);
  const led = managed ? await readLedger(ctx, id) : null;
  if (led?.rejected) return { schema: STATUS_SCHEMA, id, repo, source: "ledger", status: "rejected", reason: led.rejected, steps: [], next_actions: [`forgedock release explain ${id} --repo ${repo}`] };
  const state = led?.state ?? local.load(id);
  if (!state) return null;
  const active = managed ? await readActive(ctx) : {};
  const steps = STEPS.map((step) => ({ step, done: !!state.steps?.[step]?.done, at: state.steps?.[step]?.at ?? null }));
  const stopped = Object.entries(state.steps ?? {}).find(([, v]) => v && v.done === false)?.[0];
  const next = stopped ?? STEPS.find((st) => !state.steps?.[st]) ?? null;
  const prRes = state.steps?.["release-pr"]?.result, pr = prRes?.pr ? { number: prRes.pr, head: prRes.head ?? null, gate: null } : null;
  if (pr?.head && gateState) { try { pr.gate = await gateState({ io, repo, pr: pr.number, head: pr.head }); } catch { pr.gate = null; } }
  const status = state.status ?? "running";
  const held = (active.holds ?? []).length > 0;
  const out = {
    schema: STATUS_SCHEMA, id, repo, source: led ? "ledger" : "local", status, next_step: TERMINAL.includes(status) ? null : next,
    steps, pr, lease: active.lease ? { holder: active.lease.holder, epoch: active.lease.epoch } : null,
    hold: held, intake: active.intake?.paused ? "paused" : "open",
    release: state.release ? { snapshot: state.release.snapshot ?? null, branch: state.release.branch ?? null, issues: issueNumbers(state), picks: (state.release.picks ?? []).length } : null,
  };
  out.next_actions = nextActions(out);
  return out;
}

const issueNumbers = (state) => (state.release?.issues ?? []).map((i) => (typeof i === "object" ? i.number : i)).filter((n) => n != null).sort((a, b) => a - b);

function nextActions(s) {
  const r = `--repo ${s.repo}`, out = [];
  if (!TERMINAL.includes(s.status)) {
    out.push(`forgedock release --resume ${s.id} ${r}`);
    if (s.pr?.gate?.marker === "pass") out.push(`forgedock release --resume ${s.id} ${r} --merge`);
  }
  if (s.pr) out.push(`forgedock release explain ${s.pr.number} ${r}`);
  out.push(`forgedock release explain ${s.id} ${r}`, `forgedock release status ${s.id} ${r} --json`);
  return out;
}

export function renderStatus(s) {
  if (!s) return "no release found";
  const head = `${s.id}  ${s.repo}  status=${s.status}${s.next_step ? ` next=${s.next_step}` : ""}  source=${s.source}  hold=${s.hold ? "yes" : "no"}  intake=${s.intake}`;
  const lines = [head];
  if (s.lease) lines.push(`  lease: ${s.lease.holder} (epoch ${s.lease.epoch})`);
  if (s.reason) lines.push(`  rejected: ${s.reason}`);
  for (const st of s.steps) lines.push(`  ${st.done ? "[x]" : "[ ]"} ${st.step}${st.at ? `  ${st.at}` : ""}`);
  if (s.pr) lines.push(`  PR #${s.pr.number}  head ${s.pr.head ?? "?"}  gate marker=${s.pr.gate?.marker ?? "none"} deploy-gate=${s.pr.gate?.deployGate ?? "none"}`);
  if (s.release) lines.push(`  release set: ${s.release.issues.map((n) => `#${n}`).join(" ") || "(none recorded)"}  picks=${s.release.picks}`);
  lines.push("  next:", ...s.next_actions.map((a) => `    ${a}`));
  return lines.join("\n");
}

/** Poll `collect` until the release is terminal (or `maxPolls`); every poll is printed. */
export async function watchStatus({ collect, print, sleep, asJson = false, intervalMs = 10_000, maxPolls = Infinity }) {
  let last = null;
  for (let n = 0; n < maxPolls; n++) {
    last = await collect();
    print(asJson ? JSON.stringify(last) : renderStatus(last));
    if (!last || TERMINAL.includes(last.status)) break;
    await sleep(intervalMs);
  }
  return last;
}

const rule = (name, key, pass, detail) => ({ rule: name, config_key: key, pass, detail });

/** `explain #N`: the ordered rule trace for one issue. `watch` is the issue_watch watch config (theme_map, immediate), `{}` when none. */
export async function explainIssue({ io, repo, number, state, watch = {}, skipLabels = SKIP_LABELS }) {
  const issue = json(await io.gh(["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,labels,createdAt"]));
  const open = json(await io.gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", "number,title,body,labels,createdAt"])) ?? [];
  const names = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const trace = [];
  const skip = names.filter((l) => skipLabels.includes(l));
  trace.push(rule("skip_labels", "issue_watch.skip_labels", skip.length === 0, skip.length ? `labelled ${skip.join(", ")}` : "no skip label"));
  const prio = priorityOf(issue);
  trace.push(rule("priority", "issue_watch.watches.<name>.immediate", prio !== null, prio ? `priority ${prio}` : "no P0-P3 label (weighs as P3)"));
  const theme = classifyTheme(issue, watch.theme_map ?? {});
  trace.push(rule("theme", "issue_watch.watches.<name>.theme_map", !!theme, theme ? `theme ${theme.theme} via ${theme.via}` : "no theme rule matches"));
  const byNum = new Map(open.map((i) => [i.number, i])); byNum.set(issue.number, issue);
  const prereq = closure(issue, byNum).filter((i) => i.number !== issue.number).map((i) => i.number);
  trace.push(rule("depends_on", "release.managed", prereq.length === 0, prereq.length ? `open prerequisites ${prereq.map((n) => `#${n}`).join(", ")} must ship first` : "no open prerequisite"));
  const members = state ? issueNumbers(state) : [];
  const member = members.includes(issue.number);
  trace.push(rule("release_set", "release.mode", member, state ? (member ? `in the recorded release set of ${state.id}` : `not in the recorded release set of ${state.id}`) : "no release recorded"));
  trace.push(rule("wave_planner", "release.planner", null, "absent: the wave planner rules are not in this build (a later issue); only the rules above decide"));
  const lane = member ? "release" : skip.length ? "excluded" : "pool";
  const would = [];
  if (skip.length) would.push(`remove label ${skip.join(", ")}`);
  if (prereq.length) would.push(`close or ship ${prereq.map((n) => `#${n}`).join(", ")}`);
  if (!theme) would.push("add a theme_map rule (label:, scope: or path:) in forge.yaml");
  if (!member && !skip.length) would.push("include it in the next release cut");
  return { schema: EXPLAIN_SCHEMA, kind: "issue", repo, issue: number, lane, trace, would_change: would, next_actions: [`forgedock release status --repo ${repo} --json`] };
}

/** `explain <PR>`: the gate decision (marker, forge/deploy-gate, failing checks). */
export async function explainPr({ io, repo, pr, gateState }) {
  const head = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"]))?.headRefOid;
  const g = await gateState({ io, repo, pr, head });
  const checks = json(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion}]"])) ?? [];
  const bad = checks.filter((c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion)).map((c) => c.name).sort();
  const trace = [
    rule("gate_marker", "release.gate", g.marker === "pass", `FORGE:GATE_PASS marker: ${g.marker ?? "none"}`),
    rule("deploy_gate", "forge/deploy-gate", g.deployGate === "success", `forge/deploy-gate: ${g.deployGate ?? "none"}`),
    rule("checks", "branches.required_checks", bad.length === 0, bad.length ? `not passing: ${bad.join(", ")}` : `${checks.length} check run(s), none failing`),
  ];
  const would = trace.filter((t) => !t.pass).map((t) => `${t.rule}: ${t.detail}`);
  return { schema: EXPLAIN_SCHEMA, kind: "pr", repo, pr, head, decision: trace.every((t) => t.pass) ? "pass" : "hold", trace, would_change: would, next_actions: [`forgedock release explain ${pr} --repo ${repo} --json`] };
}

export function renderExplain(e) {
  const lines = [e.kind === "issue" ? `#${e.issue}  lane=${e.lane}` : e.kind === "pr" ? `PR #${e.pr}  head ${e.head}  decision=${e.decision}` : `${e.id}  status=${e.status}`];
  e.trace.forEach((t, i) => lines.push(`  ${i + 1}. ${t.pass === null ? "n/a " : t.pass ? "pass" : "FAIL"}  ${t.rule}  [${t.config_key}]  ${t.detail}`));
  if (e.would_change?.length) lines.push("  would change:", ...e.would_change.map((w) => `    - ${w}`));
  lines.push("  next:", ...e.next_actions.map((a) => `    ${a}`));
  return lines.join("\n");
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** `release status|explain ...`; @returns the exit code (0 found, 1 nothing found). `deps`: {io, config, local, gateState, watch, maxPolls}. */
export async function statusFromCli(argv, deps) {
  const { io } = deps, verb = argv[0], rest = argv.slice(1);
  const known = ["--repo", "--json", "--watch"];
  const bad = rest.find((a) => a.startsWith("--") && !known.includes(a));
  if (bad) throw new Error(`unknown option ${bad}; usage: forgedock release ${verb} ${verb === "status" ? "[<id>] [--watch] [--json]" : "<id | #issue | PR>"} [--repo owner/repo] [--json]`);
  const asJson = rest.includes("--json"), arg = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--repo");
  const repo = flag(rest, "--repo") ?? json(await io.gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const base = { io, repo, config: deps.config, local: deps.local, gateState: deps.gateState };
  if (verb === "status") {
    const collect = () => collectStatus({ ...base, id: arg });
    if (rest.includes("--watch")) { const s = await watchStatus({ collect, print: io.print, sleep: io.sleep, asJson, maxPolls: deps.maxPolls }); return s ? 0 : 1; }
    const s = await collect();
    io.print(asJson ? JSON.stringify(s) : renderStatus(s));
    return s ? 0 : 1;
  }
  if (!arg) throw new Error("release explain needs <id | #issue | PR>");
  let out;
  if (arg.startsWith("#")) {
    const s = await collectStatus({ ...base }).catch(() => null);
    out = await explainIssue({ io, repo, number: Number(arg.slice(1)), state: s ? { id: s.id, release: s.release } : null, watch: deps.watch });
  } else if (/^\d+$/.test(arg) || /\/pull\/\d+/.test(arg)) {
    out = await explainPr({ io, repo, pr: Number(/\d+$/.exec(arg)[0]), gateState: deps.gateState });
  } else {
    const s = await collectStatus({ ...base, id: arg });
    if (!s) { io.print(`no release ${arg}`); return 1; }
    out = { schema: EXPLAIN_SCHEMA, kind: "release", id: s.id, repo, status: s.status, trace: s.steps.map((st) => rule(st.step, "release.steps", st.done, st.done ? `done ${st.at ?? ""}`.trim() : "not done")), would_change: s.next_step ? [`run step ${s.next_step}`] : [], next_actions: s.next_actions };
  }
  io.print(asJson ? JSON.stringify(out) : renderExplain(out));
  return 0;
}
