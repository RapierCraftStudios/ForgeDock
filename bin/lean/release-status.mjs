// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock release status [<id>] [--watch] [--json]` and `release explain <id | #issue | PR>` (#5554, epic #5549 Phase 0):
 * read-only views of a release over the ledger (when `release.managed`) or the local cache, plus GitHub. No GitHub write is made.
 * Output carries no host name or wall clock (only recorded timestamps), so a second host prints the same bytes. JSON schemas
 * `forgedock.release.status/v1` and `forgedock.release.explain/v1`; both carry `next_actions[]`, the exact commands an agent may run.
 * `explain #N` traces the rules that exist today (classification record, skip labels, risk/forces, priority, theme_map, `Depends on`
 * closure, recorded release set, lane); the wave planner (#5559) registers into PLANNER_RULES, until then `planner: not installed`. Effects (`io`, `gateState`, local cache) are injected, so it is unit-testable.
 */
import { readLedger, readActive } from "./release-ledger.mjs";
import { priorityOf, classifyTheme, closure } from "./issuewatch-release.mjs";

export const STATUS_SCHEMA = "forgedock.release.status/v1";
export const EXPLAIN_SCHEMA = "forgedock.release.explain/v1";
export const TERMINAL = ["done", "refused", "blocked", "cancelled"];
export const SKIP_LABELS = ["epic", "needs-human", "post-deploy", "workflow:merged", "awaiting-promotion", "host-task"];
const STEPS = ["preflight", "host-preflight", "release-pr", "review", "fixes", "mark-ready", "rehearsal", "promotion", "post-merge"];
export const CONTROL_VERBS = ["hold", "resume", "cancel", "rollback", "lane"];
const OK = ["success", "neutral", "skipped"];
const ACTION_FLAGS = ["--repo", "--merge", "--watch", "--resume", "--json", "--interval", "--reason"];
const unk = (v) => (v === undefined || v === null || v === "" ? "unknown" : v);
const json = (s) => JSON.parse(String(s || "null"));

/** Planner rules (#5559 fills this): each `({issue, state}) => ({rule, config_key, result, detail, would_change})`. */
export const PLANNER_RULES = [];
export const registerPlannerRule = (fn) => { PLANNER_RULES.push(fn); };

/** The release id of `_active`'s lease (managed), else the newest local one. */
async function pickId({ io, repo, config, local }) {
  if (config?.managed && io.api) {
    const active = await readActive({ io, repo, credential: "driver" });
    return active.lease?.release ?? active.release ?? null;
  }
  return local.ids().sort().at(-1) ?? null;
}

async function ciSummary(io, repo, head) {
  try {
    const runs = json(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion}]"])) ?? [];
    return { total: runs.length, failed: runs.filter((c) => c.conclusion && !OK.includes(c.conclusion)).length, pending: runs.filter((c) => !c.conclusion).length };
  } catch { return null; }
}

/** The release `id` (default: the active one) as `{schema, ...}`; `null` when there is none. A field the ledger does not hold is `"unknown"`. */
export async function collectStatus({ io, repo, id, config = {}, local, gateState }) {
  id ??= await pickId({ io, repo, config, local });
  if (!id) return null;
  const ctx = { io, repo, credential: "driver" }, managed = !!(config.managed && io.api);
  const led = managed ? await readLedger(ctx, id) : null;
  if (led?.rejected) return { schema: STATUS_SCHEMA, id, repo, source: "ledger", status: "rejected", reason: led.rejected, steps: [], next_actions: [`forgedock release explain ${id} --repo ${repo}`] };
  const state = led?.state ?? local.load(id);
  if (!state) return null;
  const active = managed ? await readActive(ctx) : null;
  const steps = STEPS.map((step) => ({ step, done: !!state.steps?.[step]?.done, at: state.steps?.[step]?.at ?? null }));
  const stopped = Object.entries(state.steps ?? {}).find(([, v]) => v && v.done === false)?.[0];
  const next = stopped ?? STEPS.find((st) => !state.steps?.[st]) ?? null;
  const prRes = state.steps?.["release-pr"]?.result, pr = prRes?.pr ? { number: prRes.pr, head: prRes.head ?? null, gate: null, ci: null } : null;
  if (pr?.head && gateState) { try { pr.gate = await gateState({ io, repo, pr: pr.number, head: pr.head }); } catch { pr.gate = null; } }
  if (pr?.head) pr.ci = await ciSummary(io, repo, pr.head);
  const status = state.status ?? "running";
  const lease = active?.lease;
  const hb = lease?.heartbeat_at ? Math.max(0, Math.round((io.now() - Date.parse(lease.heartbeat_at)) / 1000)) : null;
  const w = state.wave;
  const verdict = state.steps?.review?.result?.verdict;
  const out = {
    schema: STATUS_SCHEMA, id, repo, source: led ? "ledger" : "local", status, next_step: TERMINAL.includes(status) ? null : next,
    wave: w ? `${w.n}/${w.of ?? w.m}` : "unknown", lane: unk(state.lane ?? w?.lane),
    steps, pr,
    lease: lease ? { holder: unk(lease.holder), epoch: unk(lease.epoch), heartbeat_age_s: hb ?? "unknown" } : "unknown",
    hold: active ? (active.holds ?? []).length > 0 : "unknown",
    intake: active?.intake ? (active.intake.paused ? "paused" : "open") : "unknown",
    cut_sha: unk(state.release?.snapshot),
    review: verdict ? { verdict, head: pr?.head ?? "unknown" } : "unknown",
    merge_sha: unk(state.steps?.promotion?.result?.sha ?? state.merge_sha),
    deploy: state.deploy ? { run: unk(state.deploy.run), stage: unk(state.deploy.stage), attempt: unk(state.deploy.attempt) } : "unknown",
    rollback_target: unk(state.rollback?.target), auto_rollback: state.rollback?.armed === undefined ? "unknown" : state.rollback.armed ? "armed" : "off",
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
    out.push(s.hold === true ? `forgedock release resume ${s.id} ${r} --reason <reason>` : `forgedock release hold ${s.id} ${r} --reason <reason>`);
    out.push(`forgedock release cancel ${s.id} ${r} --reason <reason>`);
  }
  if (s.steps?.find((x) => x.step === "promotion")?.done) out.push(`forgedock release rollback ${s.id} ${r} --reason <reason>`);
  if (s.pr) out.push(`forgedock release explain ${s.pr.number} ${r}`);
  out.push(`forgedock release explain ${s.id} ${r}`, `forgedock release status ${s.id} ${r} --json`);
  return out;
}

/** Parse a `next_actions[]` command under the release CLI grammar; mutating verbs need `--reason`. Throws on anything else. */
export function parseNextAction(cmd) {
  const t = String(cmd).split(/\s+/);
  if (t[0] !== "forgedock" || t[1] !== "release") throw new Error(`not a release command: ${cmd}`);
  const verb = [...CONTROL_VERBS, "status", "explain", "verify"].includes(t[2]) ? t[2] : null;
  const flags = t.filter((x) => x.startsWith("--"));
  const bad = flags.find((f) => !ACTION_FLAGS.includes(f));
  if (bad) throw new Error(`unknown option ${bad}: ${cmd}`);
  if (CONTROL_VERBS.includes(verb) && !flags.includes("--reason")) throw new Error(`${verb} needs --reason: ${cmd}`);
  if (!verb && !flags.includes("--resume")) throw new Error(`no verb or --resume: ${cmd}`);
  return { verb, flags };
}

const show = (v) => (typeof v === "object" && v !== null ? Object.entries(v).map(([k, x]) => `${k}=${x}`).join(" ") : String(v));

export function renderStatus(s) {
  if (!s) return "no active release";
  const head = `${s.id}  ${s.repo}  status=${s.status}${s.next_step ? ` next=${s.next_step}` : ""}  source=${s.source}  hold=${s.hold === true ? "yes" : s.hold === false ? "no" : s.hold}  intake=${s.intake}`;
  const lines = [head];
  if (s.reason) lines.push(`  rejected: ${s.reason}`);
  if (s.steps.length) {
    lines.push(`  wave: ${s.wave}  lane: ${s.lane}`, `  lease: ${show(s.lease)}`, `  cut: ${s.cut_sha}`);
    for (const st of s.steps) lines.push(`  ${st.done ? "[x]" : "[ ]"} ${st.step}${st.at ? `  ${st.at}` : ""}`);
    lines.push(s.pr ? `  PR #${s.pr.number}  head ${s.pr.head ?? "unknown"}  gate marker=${s.pr.gate?.marker ?? "none"} deploy-gate=${s.pr.gate?.deployGate ?? "none"}  ci: ${s.pr.ci ? show(s.pr.ci) : "unknown"}` : "  PR: unknown");
    lines.push(`  review: ${show(s.review)}`, `  merge: ${s.merge_sha}`, `  deploy: ${show(s.deploy)}`, `  rollback: target=${s.rollback_target} auto=${s.auto_rollback}`);
    if (s.release) lines.push(`  release set: ${s.release.issues.map((n) => `#${n}`).join(" ") || "(none recorded)"}  picks=${s.release.picks}`);
  }
  lines.push("  next:", ...s.next_actions.map((a) => `    ${a}`));
  return lines.join("\n");
}

/** Poll `collect` until the release is terminal (or `maxPolls`); a poll is printed only when its output changed. */
export async function watchStatus({ collect, print, sleep, asJson = false, intervalMs = 10_000, maxPolls = Infinity }) {
  let last = null, prev;
  for (let n = 0; n < maxPolls; n++) {
    last = await collect();
    const text = asJson ? JSON.stringify(last) : renderStatus(last);
    if (text !== prev) print(text);
    prev = text;
    if (!last || TERMINAL.includes(last.status)) break;
    await sleep(intervalMs);
  }
  return last;
}

let stepNo = 0;
const item = (rule, config_key, result, detail, would_change = []) => ({ step: ++stepNo, rule, config_key, result, detail, would_change });
const resetSteps = () => { stepNo = 0; };
const res = (ok) => (ok === null ? "n/a" : ok ? "pass" : "fail");

/** The `FORGE:CLASSIFY` record of an issue (latest comment carrying it): `{files, confidence, source, set_by}` or `null`. */
function classificationOf(comments) {
  const c = (comments ?? []).map((x) => String(x?.body ?? "")).filter((b) => b.includes("FORGE:CLASSIFY")).at(-1);
  if (!c) return null;
  const body = c.replace(/<!--[^>]*-->/g, "");
  let rec = null;
  try { rec = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)); } catch { /* key: value lines */ }
  if (!rec) { rec = {}; for (const m of body.matchAll(/^\s*([a-z_]+):\s*(.+)$/gm)) rec[m[1]] = m[2].trim(); if (typeof rec.files === "string") rec.files = rec.files.split(/\s*,\s*/); }
  return { files: rec.files ?? "unknown", confidence: rec.confidence ?? "unknown", source: rec.source ?? "unknown", set_by: rec.set_by ?? rec.who ?? "unknown" };
}

const hasLabel = (names, r) => names.includes(r.label);

/** `explain #N`: the ordered rule trace for one issue. `watch`: issue_watch config; `policy`: {skip_labels, min_confidence, risk_rules[], forces[]}; `controls`: controls.jsonl entries. */
export async function explainIssue({ io, repo, number, state, watch = {}, policy = {}, controls = [], planner = PLANNER_RULES }) {
  resetSteps();
  const issue = json(await io.gh(["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,labels,comments,createdAt"]));
  const open = json(await io.gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", "number,title,body,labels,createdAt"])) ?? [];
  const names = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
  const trace = [];
  const cls = classificationOf(issue.comments);
  trace.push(item("classification", "FORGE:CLASSIFY", cls ? "pass" : "n/a", cls ? `files ${show(cls.files)}; confidence ${cls.confidence}; source ${cls.source}; set by ${cls.set_by}` : "classification: absent"));
  const skipList = policy.skip_labels ?? SKIP_LABELS, skip = names.filter((l) => skipList.includes(l));
  trace.push(item("skip_labels", "plan.skip_labels", res(skip.length === 0), skip.length ? `labelled ${skip.join(", ")}` : "no skip label", skip.length ? [`remove label ${skip.join(", ")}`] : []));
  const min = policy.min_confidence, conf = Number(cls?.confidence);
  trace.push(item("min_confidence", "classify.min_confidence", min === undefined || !cls || Number.isNaN(conf) ? "n/a" : res(conf >= min), min === undefined ? "no minimum configured" : cls ? `confidence ${cls.confidence} vs minimum ${min}` : "no classification to compare", conf < min ? ["raise confidence or lower classify.min_confidence"] : []));
  for (const [key, rules] of [["risk.rules", policy.risk_rules ?? []], ["forces", policy.forces ?? []]]) {
    if (!rules.length) trace.push(item(key, key, "n/a", "no rules configured"));
    rules.forEach((r, i) => { const hit = hasLabel(names, r); trace.push(item(key, `${key}[${i}]`, res(!hit), hit ? `label ${r.label} fires${r.lane ? ` -> lane ${r.lane}` : ""}` : `label ${r.label} absent`, hit ? [`remove label ${r.label} or edit ${key}[${i}]`] : [])); });
  }
  const prio = priorityOf(issue);
  trace.push(item("priority", "issue_watch.watches.<name>.immediate", prio !== null ? "pass" : "n/a", prio ? `priority ${prio}` : "no P0-P3 label (weighs as P3)"));
  const theme = classifyTheme(issue, watch.theme_map ?? {});
  trace.push(item("theme", "issue_watch.watches.<name>.theme_map", res(!!theme), theme ? `theme ${theme.theme} via ${theme.via}` : "no theme rule matches", theme ? [] : ["add a theme_map rule (label:, scope: or path:) in forge.yaml"]));
  const byNum = new Map(open.map((i) => [i.number, i])); byNum.set(issue.number, issue);
  const prereq = closure(issue, byNum).filter((i) => i.number !== issue.number).map((i) => i.number);
  trace.push(item("depends_on", "release.managed", res(prereq.length === 0), prereq.length ? `open prerequisites ${prereq.map((n) => `#${n}`).join(", ")} must ship first` : "no open prerequisite", prereq.length ? [`close or ship ${prereq.map((n) => `#${n}`).join(", ")}`] : []));
  const member = (state ? issueNumbers(state) : []).includes(issue.number);
  trace.push(item("release_set", "release.mode", res(member), state ? (member ? `in the recorded release set of ${state.id}` : `not in the recorded release set of ${state.id}`) : "no release recorded", member || skip.length ? [] : ["include it in the next release cut"]));
  if (planner.length) for (const fn of planner) { const p = fn({ issue, state }); trace.push(item(p.rule, p.config_key, p.result, p.detail ?? "", p.would_change ?? [])); }
  else trace.push(item("planner", "release.planner", "n/a", "planner: not installed"));
  const ctl = controls.filter((c) => (c.type === "lane" || c.verb === "lane") && Number(String(c.issue ?? "").replace("#", "")) === number).at(-1);
  const planned = member ? "release" : skip.length ? "excluded" : "pool";
  const lane = ctl?.lane ?? planned;
  trace.push(item("lane", "controls.jsonl lane | plan lane", "n/a", ctl ? `lane ${lane} (control decision${ctl.actor ? ` by ${ctl.actor}` : ""})` : `lane ${lane} (plan)`, [`label or config key above, or: forgedock release lane #${number} --force <lane> --reason <reason>`]));
  return { schema: EXPLAIN_SCHEMA, kind: "issue", repo, issue: number, lane, classification: cls ?? "absent", trace, would_change: trace.flatMap((t) => t.would_change), next_actions: [`forgedock release status --repo ${repo} --json`] };
}

/** `explain <PR>`: every required check and its outcome at the head, the deploy gate, and any exemption (demotion) from `controls`. */
export async function explainPr({ io, repo, pr, gateState, policy = {}, controls = [] }) {
  resetSteps();
  const head = json(await io.gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"]))?.headRefOid;
  const g = await gateState({ io, repo, pr, head });
  const checks = json(await io.gh(["api", `repos/${repo}/commits/${head}/check-runs`, "--jq", "[.check_runs[] | {name, conclusion}]"])) ?? [];
  const byName = new Map(checks.map((c) => [c.name, c]));
  const names = (policy.required_checks ?? checks.map((c) => c.name)).slice().sort();
  const exempt = (n) => controls.filter((c) => ["exempt", "demote"].includes(c.type ?? c.verb) && c.check === n && (c.pr === undefined || Number(c.pr) === pr)).at(-1);
  const trace = [
    item("gate_marker", "release.gate", res(g.marker === "pass"), `FORGE:GATE_PASS marker: ${g.marker ?? "none"}`),
    item("deploy_gate", "forge/deploy-gate", res(g.deployGate === "success"), `forge/deploy-gate: ${g.deployGate ?? "none"}`),
  ];
  const demoted = [];
  for (const n of names) {
    const c = byName.get(n), concl = c?.conclusion ?? null, ex = exempt(n);
    const ok = concl ? OK.includes(concl) : null;
    if (ex && ok !== true) {
      demoted.push({ check: n, actor: unk(ex.actor), expires: unk(ex.until ?? ex.expires), reason: unk(ex.reason), issue: unk(ex.issue) });
      trace.push(item(`check:${n}`, "branches.required_checks", "n/a", `${concl ?? "missing"}; demoted by ${unk(ex.actor)} until ${unk(ex.until ?? ex.expires)}: ${unk(ex.reason)} (issue ${unk(ex.issue)})`));
    } else trace.push(item(`check:${n}`, "branches.required_checks", ok === null ? "fail" : res(ok), c ? `${concl ?? "pending"}` : "missing", ok === true ? [] : [`make ${n} pass, or demote it: forgedock release exempt ${n} --reason <reason>`]));
  }
  return { schema: EXPLAIN_SCHEMA, kind: "pr", repo, pr, head, decision: trace.every((t) => t.result !== "fail") ? "pass" : "hold", demoted, trace, would_change: trace.flatMap((t) => t.would_change), next_actions: [`forgedock release explain ${pr} --repo ${repo} --json`] };
}

export function renderExplain(e) {
  const lines = [e.kind === "issue" ? `#${e.issue}  lane=${e.lane}` : e.kind === "pr" ? `PR #${e.pr}  head ${e.head}  decision=${e.decision}` : `${e.id}  status=${e.status}`];
  e.trace.forEach((t) => lines.push(`  ${t.step}. ${t.result === "pass" ? "pass" : t.result === "fail" ? "FAIL" : "n/a "}  ${t.rule}  [${t.config_key}]  ${t.detail}`));
  if (e.would_change?.length) lines.push("  would change:", ...e.would_change.map((w) => `    - ${w}`));
  lines.push("  next:", ...e.next_actions.map((a) => `    ${a}`));
  return lines.join("\n");
}

const flag = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** `release status|explain ...`; @returns the exit code (0 found, 1 nothing found). `deps`: {io, config, local, gateState, watch, maxPolls}. */
export async function statusFromCli(argv, deps) {
  const { io } = deps, verb = argv[0], rest = argv.slice(1);
  const known = ["--repo", "--json", "--watch", "--interval"];
  const bad = rest.find((a) => a.startsWith("--") && !known.includes(a));
  if (bad) throw new Error(`unknown option ${bad}; usage: forgedock release ${verb} ${verb === "status" ? "[<id>] [--watch] [--interval s] [--json]" : "<id | #issue | PR>"} [--repo owner/repo] [--json]`);
  const asJson = rest.includes("--json"), arg = rest.find((a, i) => !a.startsWith("--") && !["--repo", "--interval"].includes(rest[i - 1]));
  const repo = flag(rest, "--repo") ?? json(await io.gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  const base = { io, repo, config: deps.config, local: deps.local, gateState: deps.gateState };
  const none = (s) => s ?? { schema: STATUS_SCHEMA, id: null, repo, status: "no active release", next_actions: [] };
  const show1 = (s) => (asJson ? JSON.stringify(none(s)) : arg && !s ? `no release ${arg}` : renderStatus(s));
  if (verb === "status") {
    const collect = () => collectStatus({ ...base, id: arg });
    if (rest.includes("--watch")) {
      const secs = flag(rest, "--interval") === null ? 10 : Number(flag(rest, "--interval"));
      if (!(secs > 0)) throw new Error("--interval needs a positive number of seconds");
      const s = await watchStatus({ collect, print: io.print, sleep: io.sleep, asJson, intervalMs: secs * 1000, maxPolls: deps.maxPolls });
      return s ? 0 : 1;
    }
    const s = await collect();
    io.print(show1(s));
    return s ? 0 : 1;
  }
  if (!arg) throw new Error("release explain needs <id | #issue | PR>");
  const controls = deps.config?.managed && io.api ? ((await readActive({ io, repo, credential: "driver" })).controls ?? []) : [];
  let out;
  if (arg.startsWith("#")) {
    const s = await collectStatus({ ...base }).catch(() => null);
    out = await explainIssue({ io, repo, number: Number(arg.slice(1)), state: s ? { id: s.id, release: s.release } : null, watch: deps.watch, policy: deps.policy, controls });
  } else if (/^\d+$/.test(arg) || /\/pull\/\d+/.test(arg)) {
    out = await explainPr({ io, repo, pr: Number(/\d+$/.exec(arg)[0]), gateState: deps.gateState, policy: deps.policy, controls });
  } else {
    const s = await collectStatus({ ...base, id: arg });
    if (!s) { io.print(`no release ${arg}`); return 1; }
    resetSteps();
    out = { schema: EXPLAIN_SCHEMA, kind: "release", id: s.id, repo, status: s.status, trace: s.steps.map((st) => item(st.step, "release.steps", st.done ? "pass" : "n/a", st.done ? `done ${st.at ?? ""}`.trim() : "not done")), would_change: s.next_step ? [`run step ${s.next_step}`] : [], next_actions: s.next_actions };
  }
  io.print(asJson ? JSON.stringify(out) : renderExplain(out));
  return 0;
}
