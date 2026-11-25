// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Batch efficiency SLOs (#5987): `orchestrate.slo.*` thresholds with defaults, breach evaluation over an efficiency.json ledger
 * (efficiency.mjs), and the filer that turns a breach into one rolling `engine-gap` issue per signature `slo:<code>:<repo>`.
 * Filing is default-off (`orchestrate.slo.file_issues: true` opts in); breaches are always recorded in efficiency.json.
 * The filer takes an injected `gh(args) -> stdout`, appends a counter comment on a re-breach at most once per 6 h, and closes the
 * issue after 24 h green. Its state lives in efficiency.json (`slo.sigs`), so a daemon restart neither re-files nor re-comments.
 */
export const DEFAULT_SLO = Object.freeze({ concurrencyMin: 0.6, concurrencyMinutes: 30, repeatMax: 3, attemptsMax: 2, commentsMax: 20, interventionsMax: 6,
  phaseRatioMax: 1.5, capacityRefusalsMax: 20, idleShareMax: 0.2, fileIssues: false, repo: "RapierCraftStudios/ForgeDock", label: "engine-gap" });
export const SLO_UPDATE_MS = 6 * 3_600_000;
export const SLO_CLOSE_GREEN_MS = 24 * 3_600_000;
const SNAKE = { concurrencyMin: "concurrency_min", concurrencyMinutes: "concurrency_minutes", repeatMax: "repeat_max", attemptsMax: "attempts_max", commentsMax: "comments_max",
  interventionsMax: "interventions_max", phaseRatioMax: "phase_ratio_max", capacityRefusalsMax: "capacity_refusals_max", idleShareMax: "idle_share_max" };

/** forge.yaml (parsed) -> SLO config; the parser may nest (`orchestrate.slo.x`) or flatten (`orchestrate.x`). Bad values fall back. */
export function parseSloConfig(yaml) {
  const o = yaml?.orchestrate && typeof yaml.orchestrate === "object" ? yaml.orchestrate : {};
  const s = { ...o, ...(o.slo && typeof o.slo === "object" ? o.slo : {}) };
  const out = { ...DEFAULT_SLO };
  for (const [k, snake] of Object.entries(SNAKE)) { const v = s[snake] ?? s[`slo_${snake}`]; if (v !== undefined && String(v).trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = Number(v); }
  const f = s.file_issues ?? s.slo_file_issues;
  out.fileIssues = f !== undefined && String(f).trim().toLowerCase() === "true";
  const repo = String(s.repo ?? s.slo_repo ?? "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) out.repo = repo;
  return out;
}

/** `[{code, sig, detail, issues, cause}]` for the ledger's current breaches. Pure. */
export function evaluateSlo(eff, cfg = DEFAULT_SLO, { repo = eff?.repo ?? "unknown" } = {}) {
  if (!eff) return [];
  const out = [], add = (code, detail, issues = [], cause = "") => out.push({ code, sig: `slo:${code}:${repo}`, detail, issues, cause });
  const c = eff.concurrency ?? {};
  if (c.ready > 0 && c.lowSinceMin >= cfg.concurrencyMinutes) add("concurrency", `achieved/ceiling ${c.achieved}/${c.ceiling} below ${cfg.concurrencyMin} for ${c.lowSinceMin} min with ${c.ready} ready`, [], `limiter ${(eff.limiters ?? []).join(", ") || "unknown"}`);
  for (const r of eff.repeats ?? []) if (r.count >= cfg.repeatMax) add("repeat", `signature "${r.signature}" repeated ${r.count}x`, r.issues, "the same failure is retried without a change");
  if (eff.attemptsPerMerged != null && eff.attemptsPerMerged > cfg.attemptsMax) add("attempts", `${eff.attemptsPerMerged} attempts per merged issue (max ${cfg.attemptsMax}, 24 h)`, [], "retry loop");
  const cm = eff.commentsPerIssue ?? {};
  if (cm.max > cfg.commentsMax) add("comments", `${cm.max} engine comments on one issue (max ${cfg.commentsMax})`, (cm.issues ?? []).filter((i) => i.comments > cfg.commentsMax).map((i) => i.issue), "comment bloat");
  if (eff.interventionsPerDay > cfg.interventionsMax) add("interventions", `${eff.interventionsPerDay} operator interventions in 24 h (max ${cfg.interventionsMax})`, [], "the batch needs hand-holding");
  const slow = Object.entries(eff.phases ?? {}).filter(([, v]) => v.ratio != null && v.ratio > cfg.phaseRatioMax);
  if (slow.length) add("phase", slow.map(([id, v]) => `${id} p90 ${v.ratio}x baseline`).join("; "), [], `phase regression: ${slow.map(([id]) => id).join(", ")}`);
  if (eff.capacityRefusalsPerHour > cfg.capacityRefusalsMax) add("capacity", `${eff.capacityRefusalsPerHour} capacity refusals in the last hour (max ${cfg.capacityRefusalsMax})`, [], "sandbox capacity");
  for (const [cause, share] of Object.entries(eff.idle?.share ?? {})) if (cause !== "no-ready" && share > cfg.idleShareMax) add(`idle-${cause}`, `${Math.round(share * 100)}% of slot time idle for ${cause} (max ${Math.round(cfg.idleShareMax * 100)}%)`, [], `idle cause ${cause}`);
  return out;
}

const body = (eff, b, { count = 1, reportPath = null } = {}) => [
  `<!-- forge-slo: ${b.sig} -->`, `**SLO breach \`${b.code}\`** (batch \`${eff.batch}\`, repo \`${eff.repo}\`), occurrence ${count}`, "",
  "| field | value |", "| --- | --- |", `| evidence | ${b.detail.replace(/\|/g, "/")} |`, `| window | 24 h to ${eff.at} (concurrency ${eff.concurrency?.windowMin} min) |`,
  `| offending issues | ${b.issues.length ? b.issues.map((n) => `#${n}`).join(", ") : "none named"} |`, `| suggested cause | ${b.cause || "unknown"} |`,
  `| signature | \`${b.sig}\` |`, ...(reportPath ? [`| introspect report | ${reportPath} |`] : [])].join("\n");

/**
 * Apply the filing rules. Returns `{slo, actions}` where `slo` is the next `slo.sigs` state (persist it in efficiency.json).
 * With `enabled` false nothing is called and the state is unchanged. Never throws: a gh failure leaves that signature's state as it was.
 */
export async function fileSloIssues({ eff, breaches, gh, cfg = DEFAULT_SLO, now = Date.now(), enabled = cfg.fileIssues, reportPath = null }) {
  const sigs = { ...(eff?.slo?.sigs ?? {}) }, actions = [];
  if (!enabled || typeof gh !== "function") return { slo: { sigs }, actions };
  const live = new Set(breaches.map((b) => b.sig));
  for (const b of breaches) {
    const prev = sigs[b.sig];
    try {
      if (!prev?.issue) {
        let found = null;
        try { found = JSON.parse(String(await gh(["issue", "list", "--repo", cfg.repo, "--label", cfg.label, "--state", "open", "--search", `"${b.sig}" in:body`, "--json", "number,body"])) || "[]").find((i) => String(i.body ?? "").includes(b.sig)); } catch { found = null; }
        if (found) { sigs[b.sig] = { issue: found.number, count: 1, openedAt: now, updatedAt: now, greenSince: null }; actions.push({ op: "adopt", sig: b.sig, issue: found.number }); continue; }
        const out = String(await gh(["issue", "create", "--repo", cfg.repo, "--label", cfg.label, "--title", `engine-gap: ${b.code} SLO breach (${eff.repo})`, "--body", body(eff, b, { reportPath })]));
        const n = Number(out.match(/(\d+)\s*$/)?.[1]);
        if (Number.isSafeInteger(n)) { sigs[b.sig] = { issue: n, count: 1, openedAt: now, updatedAt: now, greenSince: null }; actions.push({ op: "create", sig: b.sig, issue: n }); }
        continue;
      }
      if (now - prev.updatedAt < SLO_UPDATE_MS) { sigs[b.sig] = { ...prev, greenSince: null }; continue; } // alert noise: one update per signature per 6 h
      const count = (prev.count ?? 1) + 1;
      await gh(["issue", "comment", String(prev.issue), "--repo", cfg.repo, "--body", body(eff, b, { count, reportPath })]);
      sigs[b.sig] = { ...prev, count, updatedAt: now, greenSince: null };
      actions.push({ op: "comment", sig: b.sig, issue: prev.issue, count });
    } catch { /* advisory: retried on the next pass */ }
  }
  for (const [sig, st] of Object.entries(sigs)) {
    if (live.has(sig)) continue;
    const since = st.greenSince ?? now;
    if (now - since < SLO_CLOSE_GREEN_MS) { sigs[sig] = { ...st, greenSince: since }; continue; }
    try { await gh(["issue", "close", String(st.issue), "--repo", cfg.repo, "--comment", `SLO \`${sig}\` has been green for 24 h; closing.`]); delete sigs[sig]; actions.push({ op: "close", sig, issue: st.issue }); } catch { /* retried */ }
  }
  return { slo: { sigs }, actions };
}

/** One advisory ledger pass for a batch: compute, evaluate, file (when enabled), persist. Never throws. */
export async function ledgerPass({ batch, sample, cfg, gh, now = Date.now(), repo = null, compute, readEff, writeEff, reportPath = null }) {
  try {
    const rows = batch.readLog(), prev = readEff(batch.dir);
    let eff = compute({ rows, state: batch.store.peek(), prev, sample, now, batchId: batch.id, repo, concurrencyMin: cfg.concurrencyMin });
    const breaches = evaluateSlo(eff, cfg, { repo: repo ?? "unknown" });
    const { slo, actions } = await fileSloIssues({ eff, breaches, gh, cfg, now, reportPath });
    eff = { ...eff, slo, breaches: breaches.map((b) => ({ code: b.code, sig: b.sig, detail: b.detail, issue: slo.sigs[b.sig]?.issue ?? null })) };
    writeEff(batch.dir, eff);
    return { eff, breaches, actions };
  } catch { return null; }
}

/**
 * Introspect findings (#5987): file the `forgedock stats --conformance-outcomes` report as one rolling `engine-gap` issue per
 * signature `introspect:<scope>`. Deduped against an open issue carrying the signature and against the prior report (`prior`
 * = last filed `{hash, issue}`): an unchanged report files nothing. Returns `{action, issue?, hash}`; never throws.
 */
export async function fileIntrospect({ report, scope, gh, cfg = DEFAULT_SLO, prior = null, reportPath = null }) {
  const text = String(report ?? "").trim(), sig = `introspect:${scope}`;
  if (!text || typeof gh !== "function") return { action: "none", hash: null };
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  if (prior?.hash === hash) return { action: "unchanged", hash, issue: prior.issue ?? null };
  const body = `<!-- forge-slo: ${sig} -->\n**fd-introspect** (${scope})${reportPath ? `\n\nreport: ${reportPath}` : ""}\n\n\`\`\`\n${text.slice(0, 6000)}\n\`\`\``;
  try {
    let found = null;
    try { found = JSON.parse(String(await gh(["issue", "list", "--repo", cfg.repo, "--label", cfg.label, "--state", "open", "--search", `"${sig}" in:body`, "--json", "number,body"])) || "[]").find((i) => String(i.body ?? "").includes(sig)); } catch { found = null; }
    if (found || prior?.issue) {
      const n = found?.number ?? prior.issue;
      await gh(["issue", "comment", String(n), "--repo", cfg.repo, "--body", body]);
      return { action: "comment", issue: n, hash };
    }
    const out = String(await gh(["issue", "create", "--repo", cfg.repo, "--label", cfg.label, "--title", `engine-gap: fd-introspect findings (${scope})`, "--body", body]));
    return { action: "create", issue: Number(out.match(/(\d+)\s*$/)?.[1]) || null, hash };
  } catch { return { action: "failed", hash }; }
}
