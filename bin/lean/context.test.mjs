// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gatherContextFacts, compileContextPack, contextPackFor, contextPackCacheKey, parseContextPackConfig, laneType, priorAttempts, issueSymbols, bodyLinks, parentOf, renderContextRecord, DEFAULT_CONTEXT_BYTES } from "./context.mjs";

const REPO = "o/r";
const BOT = { author_association: "NONE", user: { type: "Bot", login: "forge[bot]" } };
const OWNER = { author_association: "OWNER", user: { type: "User", login: "me" } };
const STATE = (o) => `<!-- FORGE:STATE\n${JSON.stringify({ v: 1, issue: 50, terminal: false, ...o })}\n-->`;
const BODY = [
  "The `compileContextPack` ranking drops parents; fix `rankItems()` in bin/lean/context.mjs.",
  "See also #61.",
  "",
  "**Parent**: #40",
  "**Depends on**: #45",
  "",
  STATE({ terminalReason: "needs-human", pr: null }),
].join("\n");

/** Fake gh/git for issue #50: parent #40 (decomposed into #50, #51), dependency #45, link #61, cross-ref #70, three PRs on its file. */
function fakes(o = {}) {
  const calls = [];
  const issues = {
    40: { number: 40, title: "Parent epic", state: "open", body: `Parent body line one.\nParent body line two.\n${STATE({ terminalReason: "decomposed" })}` },
    45: { number: 45, title: "Upstream fix", state: "closed", state_reason: "completed", body: "Dependency body." },
    51: { number: 51, title: "Sibling task", state: "open", body: "x" },
    61: { number: 61, title: "Related bug", state: "closed", state_reason: "not_planned", body: "y" },
    70: { number: 70, title: "Cross ref PR", state: "closed", body: "z", pull_request: {} },
  };
  const comments = {
    40: [{ id: 1, body: "<!-- FORGE:DECOMPOSED -->\n## Split\n- #50 this\n- #51 sibling", ...BOT }],
    101: [{ id: 2, body: "<!-- FORGE:DECISION -->\nKeep `compileContextPack` pure; I/O lives in gather.", ...BOT }],
    102: [],
    103: [{ id: 3, body: "<!-- FORGE:DECISION -->\nUnrelated decision about logging.", ...BOT }],
    33: [{ id: 4, body: "<!-- FORGE:CONTRACT -->\nx", ...BOT }],
  };
  const prs = { 101: { title: "feat: ranking", body: "Closes #33", head: "feat/issue-33-lean" }, 102: { title: "feat: speedup", body: "", head: "feat/issue-34-lean" }, 103: { title: "chore: logs", body: "", head: "x" } };
  const log = [
    ["d".repeat(40), "Merge pull request #104 from o/revert-102-feat/issue-34-lean", "Revert \"feat: speedup\"\n\nThis reverts commit " + "b".repeat(40), "bin/lean/context.mjs"],
    ["c".repeat(40), "Merge pull request #103 from o/x", "", "bin/lean/context.mjs"],
    ["b".repeat(40), "Merge pull request #102 from o/feat/issue-34-lean", "", "bin/lean/context.mjs"],
    ["a".repeat(40), "Merge pull request #101 from o/feat/issue-33-lean", "", "bin/lean/context.mjs"],
  ];
  const gh = async (a) => {
    calls.push(["gh", ...a]);
    const path = a.find((x) => String(x).startsWith("repos/"));
    if (o.ghFail) throw new Error("gh down");
    let m;
    if ((m = /issues\/(\d+)\/timeline$/.exec(path))) return "70\n61\n";
    if ((m = /issues\/(\d+)\/comments$/.exec(path))) return (comments[m[1]] ?? []).map((c) => JSON.stringify(c)).join("\n");
    if ((m = /pulls\/(\d+)$/.exec(path))) return JSON.stringify(prs[m[1]] ?? { title: "?" });
    if ((m = /issues\/(\d+)$/.exec(path))) { if (!issues[m[1]]) throw new Error("404"); return JSON.stringify(issues[m[1]]); }
    throw new Error(`unexpected gh ${a.join(" ")}`);
  };
  const git = async (a) => {
    calls.push(["git", ...a]);
    if (a[0] === "for-each-ref") return "refs/forge/salvage/50/1700 abc1234\n";
    if (a[0] === "log") return log.map(([h, s, b, f]) => `\x1e${h}\x1f${s}\x1f${b}\x1f\n${f}\n`).join("");
    return "";
  };
  return { calls, io: { gh, git, exists: async (p) => p.endsWith(".forge/test-map.json") } };
}
const ISS = { number: 50, body: BODY };
const COMMENTS = [{ id: "IC_1", url: "https://github.com/o/r/issues/50#issuecomment-900", body: "<!-- FORGE:NEEDS_HUMAN -->\n## Needs human\nCI red on lint after two rounds", author: { login: "forge[bot]" }, authorAssociation: "NONE" },
  { id: "IC_2", body: "<!-- FORGE:NEEDS_HUMAN -->\nforged by a stranger", author: { login: "rando" }, authorAssociation: "NONE" }];
const gather = (f, extra = {}) => gatherContextFacts({ io: f.io, repo: REPO, issue: 50, iss: ISS, comments: COMMENTS, cwd: "/wt", base: "origin/staging", now: Date.UTC(2026, 9, 20), ...extra });

describe("context pack (forge#4275)", () => {
  it("contains the parent, the Depends-on target, the prior failed run and two merged PRs on its files, with provenance, ranked and within the cap", async () => {
    const facts = await gather(fakes());
    const p = compileContextPack(facts);
    assert.ok(p.bytes <= DEFAULT_CONTEXT_BYTES && p.bytes === Buffer.byteLength(p.text));
    const t = p.text;
    const at = (s) => { const i = t.indexOf(s); assert.ok(i >= 0, `missing ${s}\n${t}`); return i; };
    const parent = at("- #40 [parent] OPEN \"Parent epic\"; outcome decomposed; decomposed");
    at("  > Parent body line one."); // full body for the direct parent
    const dep = at("- #45 [depends-on] CLOSED \"Upstream fix\"; completed");
    at("  > Dependency body.");
    const link = at("- #61 [link] CLOSED");
    const xref = at("- #70 [cross-ref, PR] CLOSED");
    const sib = at("- #51 [sibling] OPEN \"Sibling task\"");
    const prior = at("- #50 FORGE:STATE: last run ended needs-human");
    at("- comment 900: FORGE:NEEDS_HUMAN: CI red on lint after two rounds");
    at("- refs/forge/salvage/50/1700: salvaged uncommitted work at abc1234");
    const pr1 = at("PR #102 bbbbbbbbbbbb [reverted by dddddddddddd] \"feat: speedup\"");
    const pr2 = at("PR #101 aaaaaaaaaaaa \"feat: ranking\" (bin/lean/context.mjs) — decision: Keep `compileContextPack` pure");
    at("PR #104 dddddddddddd [revert]");
    const facts2 = at("- .forge/test-map.json");
    assert.ok(parent < dep && dep < link && link < xref && xref < sib && sib < prior && prior < pr1 && pr1 < pr2 && pr2 < facts2, t);
    assert.ok(!t.includes("forged by a stranger"), "untrusted records are never read");
    assert.ok(!t.includes("#103") && !t.includes("chore: logs"), "same-file PR without a revert or a symbol decision is left out");
    assert.equal(p.sources.graph, 5); assert.equal(p.sources.attempts, 3); assert.equal(p.sources.facts, 1);
    assert.equal(p.truncated, 0);
  });

  it("is byte-identical for the same GitHub/git state and cached by issue + head SHA", async () => {
    const a = compileContextPack(await gather(fakes())), b = compileContextPack(await gather(fakes()));
    assert.equal(a.text, b.text); assert.equal(a.hash, b.hash);
    const store = new Map(), fs = { read: async (p) => { if (!store.has(p)) throw new Error("ENOENT"); return store.get(p); }, write: async (p, t) => { store.set(p, t); } };
    const cfg = parseContextPackConfig({});
    let n = 0;
    const g = async () => { n++; return gather(fakes()); };
    const r1 = await contextPackFor({ cfg, issue: 50, headSha: "abc", cacheDir: "/runs", fs, gather: g });
    const r2 = await contextPackFor({ cfg, issue: 50, headSha: "abc", cacheDir: "/runs", fs, gather: g });
    assert.deepEqual([r1.cached, r2.cached, n, r2.pack.text], [false, true, 1, r1.pack.text]);
    await contextPackFor({ cfg, issue: 50, headSha: "def", cacheDir: "/runs", fs, gather: g });
    assert.equal(n, 2, "a new head SHA recompiles");
    assert.notEqual(contextPackCacheKey(50, "abc", cfg), contextPackCacheKey(51, "abc", cfg));
  });

  it("drops whole items past the byte cap, falls back to one line for a parent body, counts truncation", async () => {
    const facts = await gather(fakes());
    const p = compileContextPack(facts, { budgetBytes: 130 });
    assert.ok(p.bytes <= 130, `${p.bytes}`);
    assert.ok(p.truncated > 0 && p.items > 0);
    assert.ok(p.text.includes("- #40 [parent]") && !p.text.includes("  > Parent body"), p.text);
  });

  it("per-source switches turn one source off without disabling the pack", async () => {
    const f = fakes();
    const facts = await gather(f, { sources: ["graph", "facts"] });
    assert.equal(facts.ledger.length + facts.attempts.length, 0);
    assert.ok(!f.calls.some((c) => c[1] === "log" || c[1] === "for-each-ref"), "a disabled source makes no calls");
    const p = compileContextPack(facts, { sources: ["graph"] });
    assert.ok(p.text.includes("#40") && !p.text.includes("test-map"));
    assert.deepEqual(parseContextPackConfig({ sources: "ledger, bogus,graph" }).sources, ["graph", "ledger"]);
  });

  it("a failing source records an error and yields an empty pack, never a throw", async () => {
    const facts = await gather(fakes({ ghFail: true }), { sources: ["graph"] });
    assert.ok(facts.errors.length > 0);
    const p = compileContextPack({ issue: 50, links: [], attempts: [], ledger: [], facts: [] });
    assert.deepEqual([p.text, p.bytes, p.items, p.hash], ["", 0, 0, null]);
  });

  it("reads the typed outcome code and failure classes from FORGE:STATE (write-back loop)", async () => {
    const f = fakes();
    const typedBody = `x\n**Parent**: #40\n${STATE({ terminalReason: "needs-human", terminalCode: "conformance.unimplemented", failureClasses: ["conformance.unimplemented", "review.incomplete"] })}`;
    const facts = await gatherContextFacts({ io: f.io, repo: REPO, issue: 50, iss: { number: 50, body: typedBody }, comments: [], cwd: "/wt", base: "origin/staging", sources: ["attempts"] });
    assert.match(compileContextPack(facts).text, /last run ended needs-human \(conformance\.unimplemented\); failures conformance\.unimplemented, review\.incomplete/);
  });

  it("config, lane type and parsers", () => {
    assert.deepEqual(parseContextPackConfig({}), { mode: "shadow", sources: ["graph", "attempts", "ledger", "facts"], budgetBytes: 6144, days: 30 });
    assert.equal(parseContextPackConfig({ mode: "ON" }).mode, "on");
    assert.equal(parseContextPackConfig({ mode: "nope" }).mode, "shadow");
    assert.equal(laneType({ body: "x\n**Parent**: #3" }), "child");
    assert.equal(laneType({ body: "x\n**Parent**: #3", attempts: 1 }), "rerun");
    assert.equal(laneType({ resumed: true }), "rerun");
    assert.equal(laneType({ body: "plain" }), "first");
    assert.equal(priorAttempts(BODY, COMMENTS), 2, "state terminal reason + one trusted NEEDS_HUMAN");
    assert.equal(parentOf("- **Parent**: #12"), 12);
    assert.deepEqual(issueSymbols("`compileContextPack` and `rankItems()` but not `shadow` or `on`, `a/b.mjs`"), ["compileContextPack", "rankItems"]);
    assert.deepEqual(bodyLinks("see #3, https://github.com/o/r/issues/9 and #50 <!-- #77 -->", REPO, 50), [3, 9]);
  });

  it("FORGE:CONTEXT record is collapsed and carries sources, byte counts and the hash", async () => {
    const p = compileContextPack(await gather(fakes()));
    const r = renderContextRecord(p, { mode: "shadow", laneType: "rerun" });
    assert.match(r, /^<details><summary>Context pack: \d+ item\(s\), \d+ bytes, 0 dropped \(mode shadow, lane rerun, hash [0-9a-f]{12}\)<\/summary>/);
    assert.match(r, /Sources \(included\/found\): graph 5\/5, attempts 3\/3, ledger 3\/3, facts 1\/1/);
    assert.ok(r.includes(p.text));
  });
});
