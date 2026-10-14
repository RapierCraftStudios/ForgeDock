// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin orchestrate: run core work-on for several issues with bounded concurrency, honouring `**Depends on**: #X`
 * among the given issues (wait for the dependency to merge; skip when it ends anywhere but merged/invalid).
 * A `dependency-open` run is requeued behind its dependencies, pulling an out-of-set one into the batch; a
 * `decomposed` run adds its sub-issues and its dependents wait on them instead (#4124).
 * No investigation, synthesis or agent spawning. `runOne(issue)` and `readBody(issue)` are injected.
 * Optional `prefilter(issue, lane)` (#4123) runs in the lane slot before `runOne`: when it closed the issue, no lane starts.
 * Optional `resolveLane(issue)` (#4125) works out each issue's own lane (milestone branch or staging): an issue whose
 * lane is refused ends `lane-refused` without a run, and a dependency edge between two lanes goes to `onCrossLane`.
 */
const DEP_RE = /^\*\*Depends on\*\*:[ \t]*#(\d+)\b/gm;
// A dependency that finished like this no longer blocks its dependents.
const SATISFIED = new Set(["merged", "invalid"]);
// Times one issue may be requeued behind a dependency before its dependency-open row is final.
export const MAX_REQUEUES = 2;

export function parseDeps(body, issue) {
  return [...new Set([...String(body ?? "").replace(/\r\n/g, "\n").matchAll(DEP_RE)].map((m) => Number(m[1])))].filter((n) => n > 0 && n !== issue);
}

/**
 * @returns {Promise<Array<{issue:number, outcome:string, pr:?number, cost_usd:number, minutes:number, detail?:string}>>}
 */
export async function orchestrate({ issues, parallel = 3, runOne, readBody, prefilter = null, resolveLane = null, now = () => Date.now(), onUpdate = () => {}, onCrossLane = () => {} }) {
  const order = [...new Set(issues)];
  const set = new Set(order);
  const deps = new Map(); // issue -> declared dependencies (any issue); only those in `set` are edges
  const readDeps = async (n) => {
    let body = "";
    try { body = await readBody(n); } catch { /* unreadable: no ordering info, work-on's own check still applies */ }
    deps.set(n, parseDeps(body, n));
    if (resolveLane) { let l; try { l = await resolveLane(n); } catch (e) { l = { ok: false, code: "lane.unresolved", detail: e?.message ?? String(e) }; } lanes.set(n, l); }
  };
  const lanes = new Map(); // issue -> resolveLane result
  const crossSeen = new Set();
  // A milestone issue waiting on a staging fix (or the reverse) never sees that fix on its own base: surface the edge.
  const noteCrossLane = () => {
    for (const n of order) for (const d of edges(n)) {
      const a = lanes.get(n), b = lanes.get(d), key = `${n}<${d}`;
      if (!a?.ok || !b?.ok || a.lane === b.lane || crossSeen.has(key)) continue;
      crossSeen.add(key);
      onCrossLane({ issue: n, lane: a.lane, dependency: d, dependencyLane: b.lane });
    }
  };
  for (const n of order) await readDeps(n);
  const edges = (n) => deps.get(n).filter((d) => set.has(d));
  noteCrossLane();
  const results = new Map(); // issue -> row
  const running = new Map(); // issue -> promise
  const pending = [...order];
  const requeues = new Map();
  const checked = new Map(); // issue -> pre-filter result
  const addIssues = async (ns) => {
    const fresh = ns.filter((d) => !set.has(d));
    for (const d of fresh) { set.add(d); order.push(d); }
    for (const d of fresh) { await readDeps(d); pending.push(d); }
    noteCrossLane();
  };

  const skip = (n, detail) => { results.set(n, { issue: n, outcome: "skipped", pr: null, cost_usd: 0, minutes: 0, detail }); onUpdate(results.get(n)); };
  const start = (n) => {
    const t0 = now();
    const ln = lanes.get(n);
    if (ln && !ln.ok) { // settled synchronously: nothing runs, no lease, no comment
      const row = { issue: n, outcome: "lane-refused", pr: null, cost_usd: 0, minutes: 0, detail: `${ln.code}: ${ln.detail}`, code: ln.code };
      results.set(n, row); onUpdate(row);
      return;
    }
    const lane = ln?.lane;
    const p = (async () => {
      let r;
      // Pre-filter once per issue (a requeued dependency-open issue is not re-checked); fail-open: an error means a normal lane.
      if (prefilter && !checked.has(n)) { let pf = null; try { pf = await prefilter(n, lane); } catch { pf = null; } checked.set(n, pf); }
      const pf = checked.get(n) ?? null;
      if (pf?.closed) r = { terminalReason: "invalid", cost_usd: 0, detail: `pre-filter: ${pf.detail}` };
      else { try { r = await runOne(n, lane); } catch (e) { r = { terminalReason: "engine-error", detail: e?.message ?? String(e) }; } }
      const row = { issue: n, outcome: r?.terminalReason ?? "engine-error", pr: r?.pr ?? null, cost_usd: (r?.cost_usd ?? 0) + (pf?.cost_usd ?? 0), minutes: Math.round((now() - t0) / 6000) / 10, detail: r?.detail, ...(pf ? { prefilter: pf } : {}) };
      const depList = (Array.isArray(r?.dependencies) ? r.dependencies : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
      const subs = (Array.isArray(r?.subissues) ? r.subissues : []).filter((d) => Number.isSafeInteger(d) && d > 0 && d !== n);
      if (row.outcome === "dependency-open" && depList.length && (requeues.get(n) ?? 0) < MAX_REQUEUES) {
        // A scheduling fact, not a failure: add the edge, pull the dependency in, and run this issue again after it.
        requeues.set(n, (requeues.get(n) ?? 0) + 1);
        deps.set(n, [...new Set([...deps.get(n), ...depList])]);
        await addIssues(depList);
        pending.push(n); running.delete(n); onUpdate({ ...row, detail: `requeued behind ${depList.map((d) => `#${d}`).join(", ")}` });
        return;
      }
      if (row.outcome === "decomposed" && subs.length) {
        await addIssues(subs);
        for (const [m, ds] of deps) if (ds.includes(n)) deps.set(m, [...new Set(ds.flatMap((d) => (d === n ? subs : [d])))]);
        noteCrossLane();
      }
      results.set(n, row); running.delete(n); onUpdate(row);
    })();
    running.set(n, p);
  };

  while (pending.length || running.size) {
    // Resolve skips first: a dependency that finished unsatisfied (or never can) skips its dependents.
    for (let i = pending.length - 1; i >= 0; i--) {
      const n = pending[i];
      const bad = edges(n).find((d) => results.has(d) && !SATISFIED.has(results.get(d).outcome));
      if (bad !== undefined) { pending.splice(i, 1); skip(n, `dependency #${bad} ended ${results.get(bad).outcome}`); }
    }
    let started = 0;
    for (let i = 0; i < pending.length && running.size < parallel;) {
      const n = pending[i];
      if (edges(n).every((d) => results.has(d) && SATISFIED.has(results.get(d).outcome))) { pending.splice(i, 1); start(n); started++; }
      else i++;
    }
    if (running.size) await Promise.race(running.values());
    else if (started) continue; // only lane-refused rows settled (synchronously): re-resolve skips first
    else if (pending.length) { // nothing runnable and nothing running: a dependency cycle
      for (const n of pending.splice(0)) skip(n, "dependency cycle");
    }
  }
  return order.map((n) => results.get(n));
}

export function formatTable(rows) {
  const head = ["issue", "outcome", "PR", "cost", "min"];
  const body = rows.map((r) => [`#${r.issue}`, r.outcome + (r.outcome === "skipped" && r.detail ? ` (${r.detail})` : r.prefilter?.closed ? " (pre-filter)" : ""), r.pr ? `#${r.pr}` : "-", `$${(r.cost_usd ?? 0).toFixed(2)}`, String(r.minutes ?? 0)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join("  ").trimEnd();
  return [line(head), line(w.map((n) => "-".repeat(n))), ...body.map(line)].join("\n");
}
