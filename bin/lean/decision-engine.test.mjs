// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { loadPolicy, splitEscalation, settle, admissible, isVetoed, effectiveMode, revertVeto, classify, tally, VETO_LABEL } from "./decision-engine.mjs";
import { mapRecord } from "../engine/telemetry-seam.mjs";
import { formatOutcomeLists } from "./orchestrate.mjs";

const files = (m) => ({ readFile: (p) => { const k = p.replace(/^\.\//, ""); if (k in m) return m[k]; throw new Error("ENOENT"); } });
const policy = () => loadPolicy({ io: files({ "NORTHSTAR.md": "# star\n1. cheap first", "forge.yaml": "decisions:\n  mode: live\n" }), cwd: "." });
const good = { choice: "use option A", clause: "NORTHSTAR 2: cut waste", rejected: "option B", reversibility: "reversible", confidence: "high" };

// Fixtures modelled on the six AlterLab escalations (#37240, #37119, #36969, #36694, #37264, #37276).
const FIX = {
  37240: { text: "- Which retry strategy for the sync job?\n- Rotate the production API key (credentials)", terminalCode: "builder.blocked", want: "mixed" },
  37119: { text: "- Choose the pagination style\n- Send the announcement email to customers", terminalCode: "builder.blocked", want: "mixed" },
  36969: { text: "- Pick the cache TTL\n- Which naming for the new table", terminalCode: "builder.blocked", want: "decision" },
  36694: { text: "- Keep the legacy endpoint or drop it?\n- Promote staging to main after the change", terminalCode: "builder.blocked", want: "mixed" },
  37264: { text: "The check needs read-only production data we do not have.", terminalCode: "conformance.unimplemented", want: "evidence" },
  37276: { text: "All items are post-deploy: nothing to build before release.", terminalCode: "conformance.deferred", want: "post-deploy" },
};

test("#4766 loadPolicy: defaults, fallback order, matrix schema", () => {
  const p = loadPolicy({ io: files({ "AGENTS.md": "a" }) });
  assert.equal(p.policyPath, "AGENTS.md");
  assert.equal(p.mode, "shadow");
  assert.equal(p.vetoHours, 24);
  assert.deepEqual(p.matrix.map((m) => m.class), ["spend", "credentials", "external-publish", "customer-send", "prod-write", "promotion", "legal"]);
  const q = loadPolicy({ io: files({ "forge.yaml": "decisions:\n  policy: STAR.md\n  human_only: spend, gdpr, bogus\n  hint_gdpr: gdpr, dpa\n  veto_hours: 6\n  reversal_max: 0.5\n", "STAR.md": "s", "NORTHSTAR.md": "n" }) });
  assert.equal(q.policyPath, "STAR.md");
  assert.deepEqual(q.matrix.map((m) => m.class), ["spend", "gdpr"]);
  assert.ok(q.warnings.some((w) => /bogus/.test(w)));
  assert.equal(q.vetoHours, 6);
  assert.equal(q.reversalMax, 0.5);
  assert.equal(loadPolicy({ io: files({}) }).policyPath, null);
});

test("#4766 splitEscalation: the six AlterLab fixtures", () => {
  const { matrix } = policy();
  for (const [n, f] of Object.entries(FIX)) assert.equal(splitEscalation(f, matrix).kind, f.want, `#${n}`);
  const s = splitEscalation(FIX[37240], matrix);
  assert.equal(s.decisions.length, 1);
  assert.equal(s.external[0].class, "credentials");
  assert.equal(splitEscalation({ text: "x", terminalCode: "ci.red" }, matrix, { retryable: ["ci.red"] }).kind, "recovery");
  assert.equal(splitEscalation({ text: "need the token", blockType: "credentials" }, matrix).kind, "external");
});

test("#4766 admissible: one-way, low confidence and no clause escalate", () => {
  assert.equal(admissible(good).ok, true);
  assert.equal(admissible({ ...good, reversibility: "one-way" }).ok, false);
  assert.equal(admissible({ ...good, confidence: "low" }).ok, false);
  assert.equal(admissible({ ...good, clause: "" }).ok, false);
  assert.equal(admissible(null).ok, false);
});

function harness(over = {}) {
  const posts = [], labels = [], requeued = [], events = [], registered = [];
  return {
    posts, labels, requeued, events, registered,
    deps: {
      judge: async () => good,
      post: async (m, b, i) => { posts.push({ m, b, i }); },
      setLabels: async (x) => { labels.push(x); },
      requeue: async (i) => { requeued.push(i); },
      recordDecisions: async (list) => { registered.push(...list); return list; },
      emit: (r) => events.push(r), ...over,
    },
  };
}
const item = (n, extra = {}) => ({ issue: n, repo: "o/r", escalationId: `c${n}`, anchors: ["bin/x.mjs"], ...FIX[n], ...extra });

test("#4766 shadow posts FORGE:DECISION (shadow), keeps the label, no requeue", async () => {
  const h = harness();
  const p = { ...policy(), mode: "shadow" };
  const r = await settle(item(36969), p, h.deps);
  assert.equal(r.action, "shadow");
  assert.equal(h.posts[0].m, "FORGE:DECISION (shadow)");
  assert.deepEqual([h.labels, h.requeued, h.registered], [[], [], []]);
});

test("#4766 live clears needs-human, requeues, writes the register", async () => {
  const h = harness();
  const r = await settle(item(36969), policy(), h.deps);
  assert.equal(r.action, "decided");
  assert.deepEqual(h.labels, [{ issue: 36969, remove: ["needs-human"] }]);
  assert.deepEqual(h.requeued, [36969]);
  assert.equal(h.registered.length, 2);
  assert.equal(h.events[0].decided, 2);
  assert.match(h.posts[0].b, /Escalation: c36969/);
});

test("#4766 mixed keeps needs-human; external-only untouched; evidence and post-deploy only classified", async () => {
  const h = harness();
  const m = await settle(item(37240), policy(), h.deps);
  assert.equal(m.action, "decided");
  assert.equal(m.kept, true);
  assert.deepEqual([h.labels, h.requeued], [[], []]);
  const e = await settle({ issue: 1, text: "rotate the credentials", escalationId: "x" }, policy(), h.deps);
  assert.equal(e.action, "external");
  assert.equal(e.reason, "skip: external (credentials)");
  assert.equal((await settle(item(37264), policy(), h.deps)).action, "evidence-needed");
  assert.equal((await settle(item(37276), policy(), h.deps)).action, "post-deploy-only");
  assert.deepEqual(classify(item(37240), policy()), { issue: 37240, escalationId: "c37240", kind: "mixed", decisions: 1, external: ["credentials"] });
});

test("#4766 an inadmissible answer escalates with analysis and never changes labels", async () => {
  const h = harness({ judge: async () => ({ ...good, reversibility: "one-way" }) });
  const r = await settle(item(36969), policy(), h.deps);
  assert.equal(r.action, "escalated");
  assert.match(h.posts[0].b, /one-way/);
  assert.deepEqual([h.labels, h.requeued], [[], []]);
});

test("#4766 idempotent on the escalation comment id; errors become rows", async () => {
  const h = harness();
  const seen = [{ body: "<!-- FORGE:DECISION -->\nEscalation: c36969" }];
  assert.equal((await settle(item(36969, { comments: seen }), policy(), h.deps)).action, "skipped");
  assert.equal(h.posts.length, 0);
  const bad = harness({ post: async () => { throw new Error("boom"); } });
  assert.equal((await settle(item(36969), policy(), bad.deps)).action, "error");
});

test("#4766 veto: label or reply within the window; revertVeto restores needs-human", async () => {
  const t0 = Date.parse("2026-10-30T00:00:00Z");
  assert.equal(isVetoed({ labels: [VETO_LABEL] }), true);
  const c = (h, body) => ({ body, createdAt: new Date(t0 + h * 3600_000).toISOString() });
  const base = { decidedAt: t0, vetoHours: 24, now: t0 + 48 * 3600_000 };
  assert.equal(isVetoed({ ...base, comments: [c(2, "veto: wrong")] }), true);
  assert.equal(isVetoed({ ...base, comments: [c(30, "veto")] }), false);
  assert.equal(isVetoed({ ...base, comments: [c(2, "looks good")] }), false);
  const h = harness({ unrequeue: async (i) => h.requeued.push(`un${i}`) });
  const r = await revertVeto({ issue: 5, escalationId: "c5" }, h.deps);
  assert.equal(r.action, "vetoed");
  assert.deepEqual(h.labels, [{ issue: 5, add: ["needs-human"], remove: [VETO_LABEL] }]);
  assert.deepEqual(h.requeued, ["un5"]);
  assert.equal(h.events[0].reversed, 1);
});

test("#4766 a reversal rate above the cap forces shadow", async () => {
  const p = policy();
  assert.equal(effectiveMode(p, { decided: 10, reversed: 1 }).mode, "live");
  assert.equal(effectiveMode(p, { decided: 10, reversed: 5 }).mode, "shadow");
  assert.equal(effectiveMode(p, { decided: 2, reversed: 2 }).mode, "live");
  const h = harness();
  const r = await settle(item(36969), p, { ...h.deps, stats: { decided: 10, reversed: 5 } });
  assert.equal(r.action, "shadow");
  assert.equal(r.gated, true);
});

test("#4766 tally, telemetry mapping and the batch report 'decided' section", () => {
  assert.deepEqual(tally([{ action: "decided" }, { action: "shadow" }, { action: "escalated" }, { action: "external" }, { action: "evidence-needed" }, { action: "post-deploy-only" }]),
    { decided: 1, evidence: 1, folded: 1, external_kept: 1, escalated: 1, vetoed: 0, shadow: 1 });
  const m = mapRecord({ event: "DECISION_ENGINE", issue: 1, decided: 2, escalated: 0, vetoed: 1, reversed: 1, mode: "live" }, 0);
  assert.equal(m.event, "decision_engine");
  assert.deepEqual(m.payload, { decided: 2, escalated: 0, vetoed: 1, reversed: 1, mode: "live" });
  const lines = formatOutcomeLists([{ issue: 7, outcome: "merged", decided: { choice: "use option A" } }]);
  assert.match(lines.join("\n"), /decided .*\n- #7: use option A/);
  assert.deepEqual(formatOutcomeLists([{ issue: 7, outcome: "merged" }]), []);
});

test("#4826 docs say 'not yet wired' exactly while no production module calls settle", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url);
  const callers = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "decision-engine.mjs")
    .filter((f) => /\b(settle|revertVeto)\b[^;]*from "\.\/decision-engine\.mjs"/.test(readFileSync(new URL(f, dir), "utf8")));
  const wired = callers.length > 0;
  for (const p of ["../../docs/DECISIONS.md", "../../docs/CONFIG.md"]) {
    assert.equal(/not yet wired/i.test(readFileSync(new URL(p, import.meta.url), "utf8")), !wired, `${p}: banner must match wiring state (${callers.join(",") || "no callers"})`);
  }
});
