// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseProdWatch, targetLabel, roundOnce, humanOnly, metricRows, prodWatchFromCli, formatProdWatchStatus, SUMMARY_TAG, llmResult, killSwitchSet, issueBody } from "./prodwatch.mjs";
import { trailerOf } from "./prodwatch-triage.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const YAML = `name: x
prod_watch:
  poll_minutes: 10
  deployed_probe: "curl -fsS https://example.test/health"
  target_watch: prod
  alert_channel: "notify-oncall"
  governor:
    max_issues_per_hour: 5
    max_cost_usd_per_round: 1
    cost_per_issue_usd: 0.4
  sources:
    am: {kind: alertmanager, run: "am-alerts"}
issue_watch:
  watches:
    prod:
      labels: [prod-incident]
`;
const alert = (name, sev, summary = "boom") => ({ fingerprint: name, labels: { alertname: name, severity: sev }, annotations: { summary }, startsAt: "2026-10-31T10:00:00Z" });

/** Fake world: gh/exec/llm/page recorded; `alerts` is what the alertmanager source returns. */
function world({ alerts = [], issues = [], probe = 0, killed = false, llmCost = 0.4 } = {}) {
  const w = { gh: [], llm: 0, pages: [], emits: [], execs: [] };
  w.io = {
    now: () => NOW, exists: () => killed, emit: (r) => w.emits.push(r), page: (p) => { w.pages.push(p); return true; },
    exec: async (cmd) => { w.execs.push(cmd); return cmd === "am-alerts" ? { code: 0, stdout: JSON.stringify(alerts) } : { code: probe, stdout: "" }; },
    llm: async () => { w.llm++; return { text: "Hypothesis: pool exhausted.", cost_usd: llmCost }; },
    gh: async (a) => { w.gh.push(a); if (a[1] === "list") return JSON.stringify(issues); return `https://github.com/o/r/issues/${100 + w.gh.length}\n`; },
  };
  return w;
}
const creates = (w) => w.gh.filter((a) => a[1] === "create");

describe("parseProdWatch", () => {
  it("parses poll, governor, probe, channel, sources and the target label", () => {
    const c = parseProdWatch(YAML);
    assert.equal(c.poll_minutes, 10);
    assert.deepEqual(c.governor, { max_issues_per_hour: 5, max_cost_usd_per_round: 1, cost_per_issue_usd: 0.4 });
    assert.equal(c.sources[0].kind, "alertmanager");
    assert.equal(c.alert_channel, "notify-oncall");
    assert.equal(targetLabel(c, YAML), "prod-incident");
    assert.equal(targetLabel({ target_watch: null }), "prod-watch");
  });
  it("throws on unknown keys, missing sources and bad poll", () => {
    assert.throws(() => parseProdWatch("prod_watch:\n  bogus: 1\n"), /unknown key bogus/);
    assert.throws(() => parseProdWatch("prod_watch:\n  poll_minutes: 5\n"), /sources is required/);
    assert.throws(() => parseProdWatch("prod_watch:\n  poll_minutes: 0\n  sources:\n    a: {kind: alertmanager, run: x}\n"), /poll_minutes/);
    assert.throws(() => parseProdWatch("prod_watch:\n  governor:\n    nope: 1\n  sources:\n    a: {kind: alertmanager, run: x}\n"), /governor: unknown key nope/);
  });
});

describe("roundOnce", () => {
  const cfg = parseProdWatch(YAML);
  it("files one issue per fileable cluster with signal_ref, source marker, label and an llm body", async () => {
    const w = world({ alerts: [alert("PgDown", "P0", "service down"), alert("Slow", "P2")] });
    const state = {};
    const r = await roundOnce({ cfg, io: w.io, state, label: "prod-incident" });
    assert.equal(r.filed.length, 2);
    assert.equal(w.llm, 2);
    const c = creates(w)[0];
    assert.ok(c.includes("prod-incident"));
    const body = c[c.indexOf("--body") + 1];
    assert.match(body, /Hypothesis: pool exhausted\./);
    assert.match(body, /<!-- FORGE:SIGNAL_REF fp=[0-9a-f]+ -->/);
    assert.match(body, /FORGE:PRODWATCH source=am/);
    assert.equal(state.filed.length, 2);
  });
  it("does not refile a cluster whose fingerprint an open issue already embeds", async () => {
    const first = world({ alerts: [alert("Slow", "P2")] });
    await roundOnce({ cfg, io: first.io, state: {} });
    const body = creates(first)[0][creates(first)[0].indexOf("--body") + 1];
    const w = world({ alerts: [alert("Slow", "P2")], issues: [{ number: 7, state: "OPEN", body, createdAt: "2026-10-31T11:00:00Z" }] });
    const r = await roundOnce({ cfg, io: w.io, state: {} });
    assert.equal(r.filed.length, 0);
    assert.equal(creates(w).length, 0);
  });
  it("kill switch makes the round a no-op", async () => {
    const w = world({ alerts: [alert("Slow", "P2")], killed: true });
    const r = await roundOnce({ cfg, io: w.io, state: {} });
    assert.equal(r.killed, true);
    assert.equal(w.gh.length, 0); assert.equal(w.execs.length, 0); assert.equal(w.llm, 0);
  });
  it("--dry-run makes no gh write, no llm call, no page, no state change", async () => {
    const w = world({ alerts: [alert("PgDown", "P0", "service down")] });
    const state = {};
    const r = await roundOnce({ cfg, io: w.io, state, dryRun: true });
    assert.equal(r.would_file.length, 1);
    assert.equal(w.gh.every((a) => a[1] === "list"), true);
    assert.equal(w.llm, 0); assert.equal(w.pages.length, 0); assert.equal(w.emits.length, 0);
    assert.deepEqual(state.filed, []);
  });
  it("llm cost counts against max_cost_usd_per_round: the next cluster is deferred, not filed", async () => {
    const c2 = { ...cfg, governor: { ...cfg.governor, max_cost_usd_per_round: 0.5, cost_per_issue_usd: 0 } };
    const w = world({ alerts: [alert("A1", "P2", "first"), alert("B2", "P2", "second thing")], llmCost: 0.6 });
    const r = await roundOnce({ cfg: c2, io: w.io, state: {} });
    assert.equal(r.filed.length, 1); assert.equal(w.llm, 1);
    assert.equal(r.deferred.some((d) => d.why === "max_cost_usd_per_round"), true);
  });
  it("governor overflow files one storm summary", async () => {
    const c2 = { ...cfg, governor: { max_issues_per_hour: 1 } };
    const w = world({ alerts: [alert("A1", "P2", "first"), alert("B2", "P2", "second thing"), alert("C3", "P2", "third one")] });
    const r = await roundOnce({ cfg: c2, io: w.io, state: {} });
    assert.equal(r.filed.length, 1);
    assert.match(r.summary.title, /2 cluster\(s\) deferred/);
    assert.equal(creates(w).length, 2);
  });
  it("an LLM call with no reported cost counts as the whole cap when no estimate is set (#4868)", async () => {
    const c2 = { ...cfg, governor: { max_cost_usd_per_round: 0.01 } };
    const w = world({ alerts: [alert("A1", "P2", "first"), alert("B2", "P2", "second thing"), alert("C3", "P2", "third one")], llmCost: null });
    const r = await roundOnce({ cfg: c2, io: w.io, state: {} });
    assert.equal(r.filed.length, 1);
    assert.equal(r.deferred.filter((d) => d.why === "max_cost_usd_per_round").length, 2);
  });
  it("reads the real cost from claude JSON output (#4868)", () => {
    assert.deepEqual(llmResult(JSON.stringify({ type: "result", result: "body", total_cost_usd: 0.12 })), { text: "body", cost_usd: 0.12 });
    assert.deepEqual(llmResult("plain text"), { text: "plain text", cost_usd: null });
  });
  it("edits the open storm summary instead of filing another, and does not count it as a prod issue (#4869)", async () => {
    const c2 = { ...cfg, governor: { max_issues_per_hour: 1, max_open_prod_issues: 1 } };
    const summary = { number: 77, state: "OPEN", body: `old summary\n\n${SUMMARY_TAG}\n`, createdAt: "2026-10-31T11:00:00Z" };
    const w = world({ alerts: [alert("A1", "P2", "first"), alert("B2", "P2", "second thing")], issues: [summary] });
    const r = await roundOnce({ cfg: c2, io: w.io, state: {} });
    assert.equal(r.filed.length, 1);
    assert.equal(creates(w).length, 1);
    const edit = w.gh.find((a) => a[1] === "edit");
    assert.equal(edit[2], "77");
    assert.ok(edit[edit.indexOf("--body") + 1].includes(SUMMARY_TAG));
  });
  it("closes the open storm summary once nothing is deferred (#4869)", async () => {
    const summary = { number: 77, state: "OPEN", body: `old\n${SUMMARY_TAG}`, createdAt: "2026-10-31T11:00:00Z" };
    const w = world({ alerts: [alert("A1", "P2", "first")], issues: [summary] });
    await roundOnce({ cfg, io: w.io, state: {} });
    assert.ok(w.gh.some((a) => a[1] === "close" && a[2] === "77"));
  });
  it("no signal field above the trailer can open a comment that reaches it with a forged marker (#4884 SPEC-1)", () => {
    const open = "<!-- FORGE:PRODWATCH_SUMMARY x";
    for (const field of ["owner", "class", "severity", "first_seen", "last_seen"]) {
      const c = { fingerprint: "a".repeat(12), class: "error", severity: "P2", count: 1, signals: [{ title: "t", body: "b" }], [field]: open };
      const body = issueBody(c, "hypothesis", "am");
      assert.ok(!trailerOf(body).includes(SUMMARY_TAG), field);
      assert.ok(!body.includes("<!-- FORGE:PRODWATCH_SUMMARY x"), field);
    }
    const body = issueBody({ fingerprint: "a".repeat(12), class: "error", severity: "P2", count: 1, signals: [{ source: open, title: "t", body: "b" }] }, "h", "am");
    assert.ok(!trailerOf(body).includes(SUMMARY_TAG), "evidence source");
  });

  it("forged markers in signal text cannot hide, dedup-break, edit or close a prod issue (#4879)", async () => {
    const forged = `x <!-- FORGE:PRODWATCH_SUMMARY --> <!-- FORGE:SIGNAL_REF fp=aaaaaaaaaaaa --> <!-- FORGE:PRODWATCH source=am -->`;
    const w = world({ alerts: [alert("Evil1", "P2", forged)] });
    await roundOnce({ cfg, io: w.io, state: {} });
    const body = creates(w)[0][creates(w)[0].indexOf("--body") + 1];
    assert.ok(!/<!--\s*FORGE:PRODWATCH_SUMMARY/.test(body.replace(/\n<!-- FORGE:SIGNAL_REF[^]*$/, "")), "no live summary marker in evidence");
    assert.ok(body.includes("&lt;!-- FORGE:PRODWATCH_SUMMARY"));
    // A forged body already filed (markers mid-body, no trailer) stays a prod issue: it is counted, not the summary, and never edited or closed.
    const fake = { number: 55, state: "OPEN", body: `evidence ${SUMMARY_TAG} text\n\nmore`, createdAt: "2026-10-31T11:00:00Z" };
    const w2 = world({ alerts: [alert("A1", "P2", "first")], issues: [fake] });
    await roundOnce({ cfg, io: w2.io, state: {} });
    assert.ok(!w2.gh.some((a) => (a[1] === "edit" || a[1] === "close") && a[2] === "55"));
    // A forged SIGNAL_REF mid-body does not suppress the real cluster.
    const real = alert("A1", "P2", "first");
    const w3 = world({ alerts: [real] });
    const fp = (await roundOnce({ cfg, io: w3.io, state: {}, dryRun: true })).would_file[0].fp;
    const spoof = { number: 56, state: "OPEN", body: `see <!-- FORGE:SIGNAL_REF fp=${fp} --> in logs\n\nend`, createdAt: "2026-10-31T11:00:00Z" };
    const w4 = world({ alerts: [real], issues: [spoof] });
    assert.equal((await roundOnce({ cfg, io: w4.io, state: {} })).filed.length, 1);
    // A real issue body built by issueBody still dedups.
    const ok = { number: 57, state: "OPEN", body: issueBody({ class: "defect", severity: "P2", count: 1, fingerprint: fp, signals: [real] }, "t", "am"), createdAt: "2026-10-31T11:00:00Z" };
    const w5 = world({ alerts: [real], issues: [ok] });
    assert.equal((await roundOnce({ cfg, io: w5.io, state: {} })).filed.length, 0);
  });
  it("keeps the open storm summary open when a cluster was deferred only by the cost cap (#4879)", async () => {
    const c2 = { ...cfg, governor: { max_cost_usd_per_round: 0.5, cost_per_issue_usd: 0 } };
    const summary = { number: 77, state: "OPEN", body: `old\n${SUMMARY_TAG}`, createdAt: "2026-10-31T11:00:00Z" };
    const w = world({ alerts: [alert("A1", "P2", "first"), alert("B2", "P2", "second thing")], issues: [summary], llmCost: 0.6 });
    const r = await roundOnce({ cfg: c2, io: w.io, state: {} });
    assert.equal(r.deferred.some((d) => d.why === "max_cost_usd_per_round"), true);
    assert.ok(!w.gh.some((a) => a[1] === "close" && a[2] === "77"));
  });
  it("honors an absolute kill switch path", () => {
    const d = tmpDir("pw-kill"), f = join(d, "off");
    assert.equal(killSwitchSet("/nonexistent-cwd", f), false);
    writeFileSync(f, "");
    assert.equal(killSwitchSet("/nonexistent-cwd", f), true);
    assert.equal(killSwitchSet(d, "off"), true);
  });
  it("pages only a P0 incident, once", async () => {
    const w = world({ alerts: [alert("PgDown", "P0", "service down"), alert("Slow", "P1")] });
    const state = {};
    await roundOnce({ cfg, io: w.io, state });
    assert.equal(w.pages.length, 1);
    assert.equal(w.pages[0].channel, "notify-oncall");
    const w2 = world({ alerts: [alert("PgDown", "P0", "service down")] });
    await roundOnce({ cfg, io: w2.io, state });
    assert.equal(w2.pages.length, 0);
  });
  it("collects human-only clusters into one digest issue per day and never files them", async () => {
    const matrix = [{ class: "credentials", re: /credential/i }];
    const state = {};
    const w = world({ alerts: [alert("Key", "P2", "rotate credential now")] });
    const r = await roundOnce({ cfg, io: w.io, state, humanMatrix: matrix });
    assert.equal(r.filed.length, 0); assert.equal(r.human.length, 1);
    assert.equal(creates(w).length, 1);
    assert.match(creates(w)[0][3], /owner digest 2026-10-31/);
    const w2 = world({ alerts: [alert("Key", "P2", "rotate credential now"), alert("Key2", "P2", "credential expired elsewhere")] });
    await roundOnce({ cfg, io: w2.io, state, humanMatrix: matrix });
    assert.equal(creates(w2).length, 0);
    assert.equal(w2.gh.filter((a) => a[1] === "edit").length, 1);
  });
  it("retries a failed digest create next round and records the issue once it succeeds", async () => {
    const matrix = [{ class: "credentials", re: /credential/i }];
    const state = {}, alerts = [alert("Key", "P2", "rotate credential now")];
    const w = world({ alerts }), gh = w.io.gh;
    w.io.gh = async (a) => { if (a[1] === "create") { w.gh.push(a); throw new Error("gh down"); } return gh(a); };
    const r = await roundOnce({ cfg, io: w.io, state, humanMatrix: matrix });
    assert.match(r.errors.join(), /digest create/);
    assert.equal(state.digest, undefined);
    const w2 = world({ alerts });
    await roundOnce({ cfg, io: w2.io, state, humanMatrix: matrix });
    assert.equal(creates(w2).length, 1);
    assert.equal(state.digest.items.length, 1);
    assert.ok(state.digest.issue);
  });
  it("leaves digest state unchanged on a failed edit and retries it with the new item", async () => {
    const matrix = [{ class: "credentials", re: /credential/i }];
    const state = {};
    await roundOnce({ cfg, io: world({ alerts: [alert("Key", "P2", "rotate credential now")] }).io, state, humanMatrix: matrix });
    const before = JSON.stringify(state.digest);
    const alerts = [alert("Key", "P2", "rotate credential now"), alert("Key2", "P2", "credential expired elsewhere")];
    const w = world({ alerts }), gh = w.io.gh;
    w.io.gh = async (a) => { if (a[1] === "edit") { w.gh.push(a); throw new Error("gh down"); } return gh(a); };
    const r = await roundOnce({ cfg, io: w.io, state, humanMatrix: matrix });
    assert.match(r.errors.join(), /digest edit/);
    assert.equal(JSON.stringify(state.digest), before);
    const w2 = world({ alerts });
    await roundOnce({ cfg, io: w2.io, state, humanMatrix: matrix });
    const edits = w2.gh.filter((a) => a[1] === "edit");
    assert.equal(edits.length, 1);
    assert.match(edits[0][edits[0].indexOf("--body") + 1], /Key2/);
    assert.equal(state.digest.items.length, 2);
  });
  it("drops a source whose false-positive rate is over the cap to shadow", async () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, state: "CLOSED", stateReason: "NOT_PLANNED", body: `x\n<!-- FORGE:SIGNAL_REF fp=${String(i).padStart(6, "a")} -->\n<!-- FORGE:PRODWATCH source=am -->`, createdAt: "2026-10-30T00:00:00Z", closedAt: "2026-10-30T01:00:00Z" }));
    const w = world({ alerts: [alert("Slow", "P2")], issues });
    const r = await roundOnce({ cfg, io: w.io, state: {} });
    assert.equal(r.filed.length, 0);
    assert.equal(r.deferred[0].why, "source in shadow mode");
  });
  it("verifies a fixed issue once the probe passes and the signal is gone; refuses while it persists", async () => {
    const first = world({ alerts: [alert("Slow", "P2")] });
    await roundOnce({ cfg, io: first.io, state: {} });
    const body = creates(first)[0][creates(first)[0].indexOf("--body") + 1];
    const closed = [{ number: 9, state: "CLOSED", stateReason: "COMPLETED", body, createdAt: "2026-10-30T00:00:00Z", closedAt: "2026-10-30T05:00:00Z" }];
    const gone = world({ alerts: [], issues: closed }), st = {};
    const r = await roundOnce({ cfg, io: gone.io, state: st });
    assert.deepEqual(r.verified, [9]);
    assert.ok(gone.gh.some((a) => a[1] === "comment" && /FORGE:VERIFIED/.test(a[4])));
    const still = world({ alerts: [alert("Slow", "P2")], issues: closed });
    const r2 = await roundOnce({ cfg, io: still.io, state: {} });
    assert.deepEqual(r2.verified, []);
    assert.match(r2.errors.join(), /persists after the fix/);
  });
  it("files nothing when the issue list fails (no blind duplicates)", async () => {
    const w = world({ alerts: [alert("Slow", "P2")] });
    const orig = w.io.gh; w.io.gh = async (a) => { if (a[1] === "list") throw new Error("rate limited"); return orig(a); };
    const r = await roundOnce({ cfg, io: w.io, state: {} });
    assert.equal(r.filed.length, 0);
    assert.match(r.errors[0], /nothing filed/);
  });
});

describe("helpers and CLI", () => {
  it("humanOnly and metricRows", () => {
    assert.equal(humanOnly({ signals: [{ title: "spend cap", body: "" }] }, [{ class: "spend", re: /spend/i }]), "spend");
    assert.equal(humanOnly({ signals: [{ title: "x" }] }, []), null);
    const rows = metricRows([{ state: "CLOSED", stateReason: "NOT_PLANNED", body: "<!-- FORGE:PRODWATCH source=am -->", createdAt: "a" }, { state: "OPEN", body: "no marker" }]);
    assert.equal(rows.length, 1); assert.equal(rows[0].invalid, true);
  });
  it("rejects a bad op and prints status without a status file", async () => {
    await assert.rejects(prodWatchFromCli(["nope"]), /usage: forgedock prod-watch/);
    const out = [];
    const io = { gh: async () => JSON.stringify({ nameWithOwner: "o/r" }), now: () => NOW };
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cwd = tmpDir("pw-"); writeFileSync(join(cwd, "forge.yaml"), YAML);
    await prodWatchFromCli(["status"], { cwd, io, env: { FORGEDOCK_WATCH_DIR: cwd }, print: (l) => out.push(l) });
    assert.match(out[0], /prod-watch \(o\/r\): no status yet/);
    assert.match(formatProdWatchStatus({ phase: "done", rounds: 2, filed: 3 }, "o/r"), /rounds: 2/);
  });
  it("dry-run via the CLI writes no state or lock", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cwd = tmpDir("pw-"); writeFileSync(join(cwd, "forge.yaml"), YAML);
    const w = world({ alerts: [alert("Slow", "P2")] }); const out = [];
    const io = { ...w.io, gh: async (a) => (a[0] === "repo" ? JSON.stringify({ nameWithOwner: "o/r" }) : w.io.gh(a)) };
    await prodWatchFromCli(["run", "--dry-run"], { cwd, io, env: { FORGEDOCK_WATCH_DIR: join(cwd, "w") }, print: (l) => out.push(l) });
    assert.match(out[0], /would file 1 issue/);
    assert.equal(existsSync(join(cwd, "w")), false);
  });
});
