import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyWithLlm } from "./lane-audit-llm.mjs";
import { runLaneAudit, buildStamp } from "./lane-audit.mjs";

const bundle = { issue: 7, reason: "needs-human", code: "x", text: "weird novel failure" };
const good = JSON.stringify({ class: "env", signature: "Disk Full!", owner: "#1", action: "free disk", matcher: "no space left" });
const stub = (text) => { const calls = []; return { calls, runner: async (a) => { calls.push(a); return { text }; } }; };

describe("classifyWithLlm", () => {
  it("returns a proposed result with matcher from valid JSON, in one read-only call", async () => {
    const s = stub(`here: ${good}`);
    const r = await classifyWithLlm(bundle, { runner: s.runner });
    assert.equal(r.signature, "llm:disk-full");
    assert.equal(r.class, "env");
    assert.equal(r.matcher, "no space left");
    assert.equal(r.proposed_by, "llm");
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].readOnly, true);
    assert.equal(s.calls[0].resume, null);
    assert.equal(s.calls[0].role, "lane-audit");
  });
  it("returns null for garbage, invalid class, bad matcher, throw, timeout and no runner", async () => {
    assert.equal(await classifyWithLlm(bundle, { runner: stub("not json").runner }), null);
    assert.equal(await classifyWithLlm(bundle, { runner: stub('{"class":"weird"}').runner }), null);
    assert.equal(await classifyWithLlm(bundle, { runner: stub('{"class":"env","matcher":"("}').runner }), null);
    assert.equal(await classifyWithLlm(bundle, { runner: async () => { throw new Error("boom"); } }), null);
    assert.equal(await classifyWithLlm(bundle, { runner: () => new Promise(() => {}), maxMs: 20 }), null);
    assert.equal(await classifyWithLlm(bundle, {}), null);
  });
  it("truncates oversized evidence", async () => {
    const s = stub(good);
    await classifyWithLlm({ ...bundle, text: "x".repeat(100000) }, { runner: s.runner });
    assert.ok(s.calls[0].prompt.length < 7000);
  });
});

describe("runLaneAudit with the llm", () => {
  const mk = (llm, detail) => { const posts = []; return { posts, o: { issue: 7, reason: "needs-human", detail, comments: [], llm, post: async (m, b) => { posts.push(b); }, stamp: buildStamp({ attempt: 1 }) } }; };
  it("never calls the llm on a signature-table hit", async () => {
    let n = 0; const w = mk(async () => { n++; return null; }, "gh: error connecting to api.github.com");
    await runLaneAudit({ ...w.o, gap: async () => null });
    assert.equal(n, 0);
  });
  it("posts an llm result as proposed with matcher and no gap", async () => {
    let gaps = 0; const w = mk(async (e) => classifyWithLlm(e, { runner: stub(good).runner }), "weird novel failure");
    const r = await runLaneAudit({ ...w.o, gap: async () => { gaps++; return {}; } });
    assert.equal(r.audit.status, "proposed");
    assert.equal(r.audit.matcher, "no space left");
    assert.equal(r.audit.proposed_by, "llm");
    assert.equal(gaps, 0);
  });
  it("falls back to unclassified when the llm returns null", async () => {
    const w = mk(async () => null, "weird novel failure");
    assert.equal((await runLaneAudit(w.o)).audit.class, "unclassified");
  });
});
