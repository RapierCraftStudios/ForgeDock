// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin orchestrate: run core work-on for several issues with bounded concurrency, honouring `**Depends on**: #X`
 * among the given issues (wait for the dependency to merge; skip when it ends anywhere but merged/invalid).
 * No investigation, synthesis or agent spawning. `runOne(issue)` and `readBody(issue)` are injected.
 * Optional `prefilter(issue)` (#4123) runs in the lane slot before `runOne`: when it closed the issue, no lane starts.
 */
const DEP_RE = /^\*\*Depends on\*\*:[ \t]*#(\d+)\b/gm;
// A dependency that finished like this no longer blocks its dependents.
const SATISFIED = new Set(["merged", "invalid"]);

export function parseDeps(body, issue) {
  return [...new Set([...String(body ?? "").replace(/\r\n/g, "\n").matchAll(DEP_RE)].map((m) => Number(m[1])))].filter((n) => n > 0 && n !== issue);
}

/**
 * @returns {Promise<Array<{issue:number, outcome:string, pr:?number, cost_usd:number, minutes:number, detail?:string}>>}
 */
export async function orchestrate({ issues, parallel = 3, runOne, readBody, prefilter = null, now = () => Date.now(), onUpdate = () => {} }) {
  const set = new Set(issues);
  const deps = new Map();
  for (const n of issues) {
    let body = "";
    try { body = await readBody(n); } catch { /* unreadable: no ordering info, work-on's own check still applies */ }
    deps.set(n, parseDeps(body, n).filter((d) => set.has(d)));
  }
  const results = new Map(); // issue -> row
  const running = new Map(); // issue -> promise
  const pending = [...new Set(issues)];

  const skip = (n, detail) => { results.set(n, { issue: n, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail }); onUpdate(results.get(n)); };
  const start = (n) => {
    const t0 = now();
    const p = (async () => {
      let r, pf = null;
      if (prefilter) { try { pf = await prefilter(n); } catch { pf = null; } } // fail-open: an error means a normal lane
      if (pf?.closed) r = { terminalReason: "invalid", cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else { try { r = await runOne(n); } catch (e) { r = { terminalReason: "engine-error", detail: e?.message ?? String(e) }; } }
      const row = { issue: n, outcome: r?.terminalReason ?? "engine-error", pr: r?.pr ?? null, cost_usd: (r?.cost_usd ?? 0) + (pf?.cost_usd ?? 0), minutes: Math.round((now() - t0) / 6000) / 10, detail: r?.detail, ...(pf ? { prefilter: pf } : {}) };
      results.set(n, row); running.delete(n); onUpdate(row);
    })();
    running.set(n, p);
  };

  while (pending.length || running.size) {
    // Resolve skips first: a dependency that finished unsatisfied (or never can) skips its dependents.
    for (let i = pending.length - 1; i >= 0; i--) {
      const n = pending[i];
      const bad = deps.get(n).find((d) => results.has(d) && !SATISFIED.has(results.get(d).outcome));
      if (bad !== undefined) { pending.splice(i, 1); skip(n, `dependency #${bad} ended ${results.get(bad).outcome}`); }
    }
    for (let i = 0; i < pending.length && running.size < parallel;) {
      const n = pending[i];
      if (deps.get(n).every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome))) { pending.splice(i, 1); start(n); }
      else i++;
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.length) { // nothing runnable and nothing running: a dependency cycle
      for (const n of pending.splice(0)) skip(n, "dependency cycle");
    }
  }
  return issues.filter((n, i) => issues.indexOf(n) === i).map((n) => results.get(n));
}

export function formatTable(rows) {
  const head = ["issue", "outcome", "PR", "cost", "min"];
  const body = rows.map((r) => [`#${r.issue}`, r.outcome + (r.outcome === "skipped" && r.detail ? ` (${r.detail})` : r.prefilter?.closed ? " (pre-filter)" : ""), r.pr ? `#${r.pr}` : "-", `$${(r.cost_usd ?? 0).toFixed(2)}`, String(r.minutes ?? 0)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}
