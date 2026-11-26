import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLaneAudit, buildEvidence, buildStamp, classify, parseAudit, compareVersions, LANE_AUDIT_MARKER } from "./lane-audit.mjs";
import { SIGNATURES } from "./lane-audit-signatures.mjs";
import { auditGap } from "./lane-audit-gap.mjs";
import { classifyWithLlm } from "./lane-audit-llm.mjs";

const FIXTURES = { // recorded evidence text per seeded signature
  "gh-network-text": "gh: error connecting to api.github.com",
  "unguarded-status-post": "TypeError: status post failed: boom",
  "no-status-rows": "parked after repeats: no status rows were written",
  "contract-deferred-judged-omission": "reviewer: omission of the CLI flag, which the contract deferred per frozen decision K2",
  "decision-not-reaching-reviewer": "the free-text decision did not reach the reviewer",
  "amendment-syntax": "unknown amendment kind \"type\"",
  "remote-sandbox-tool-gap": "bash: jq: command not found in the remote sandbox",
  "mirror-seed-conflict": "mirror seed failed with HTTP 422",
  "genuine-credentials": "block: need creds for the payment API",
  "genuine-spend": "requires approval of the spend",
  "genuine-product-decision": "this is a product decision for the owner",
  "genuine-customer": "waiting for the customer to confirm",
  "genuine-prod-access": "requires access to prod",
  "spec-two-features": "the issue asks for two separate features",
};
const NEGATIVES = ["tests failed: 3 assertions", "merge conflict in lean.mjs", "gh: HTTP 404 not found", "the command ran fine"];
const ev = (text, stamp = { engine_version: "1.2.0", attempt: 1 }) => buildEvidence({ issue: 7, reason: "needs-human", detail: text, stamp });
const world = (comments = []) => { const posts = []; return { posts, o: { issue: 7, reason: "needs-human", code: "x", comments, post: async (m, b) => { posts.push([m, b]); comments.push(`<!-- ${m} -->\n${b}`); }, stamp: buildStamp({ engineVersion: "1.2.0", attempt: 1, batchId: "b1", imageTag: "img", buildSha: "abc", agentVersion: "a1", forgeYamlHash: "ff" }) } }; };

describe("lane audit signatures", () => {
  for (const s of SIGNATURES) {
    it(`classifies ${s.id} from recorded evidence without an LLM`, () => {
      assert.ok(FIXTURES[s.id], "fixture exists");
      const c = classify(ev(FIXTURES[s.id]));
      assert.equal(c.signature, s.id);
      assert.equal(c.class, s.class);
      assert.equal(c.active, true);
    });
  }
  it("covers every seeded class and does not match unrelated text", () => {
    assert.deepEqual([...new Set(SIGNATURES.map((s) => s.class))].sort(), ["env", "genuine", "pipeline", "pool", "spec"]);
    for (const n of NEGATIVES) assert.equal(classify(ev(n)), null, n);
  });
});

describe("lane audit run", () => {
  it("posts one stamped JSON audit and a rerun posts nothing", async () => {
    const w = world();
    const r = await runLaneAudit({ ...w.o, detail: FIXTURES["gh-network-text"] });
    assert.equal(r.posted, true);
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0][0], LANE_AUDIT_MARKER);
    const a = parseAudit(`<!-- ${LANE_AUDIT_MARKER} -->\n${w.posts[0][1]}`);
    assert.equal(a.status, "proposed");
    assert.equal(a.signature, "gh-network-text");
    assert.deepEqual(Object.keys(a.stamp).sort(), ["agent_version", "attempt", "batch_id", "build_sha", "engine_version", "forge_yaml_hash", "image_tag"]);
    assert.equal(a.stamp.batch_id, "b1");
    const again = await runLaneAudit({ ...w.o, detail: FIXTURES["gh-network-text"] });
    assert.equal(again.posted, false);
    assert.equal(w.posts.length, 1);
  });
  it("an old engine is fixed_in_later: not active, gap seam not called", async () => {
    const table = [{ ...SIGNATURES[0], fixed_in: "2.0.0" }];
    const w = world();
    let gapCalls = 0;
    const r = await runLaneAudit({ ...w.o, detail: FIXTURES["gh-network-text"], table, gap: async () => { gapCalls++; return null; } });
    assert.equal(r.audit.fixed_in_later, true);
    assert.equal(r.audit.active, false);
    assert.equal(gapCalls, 0);
    const w2 = world();
    const r2 = await runLaneAudit({ ...w2.o, detail: FIXTURES["gh-network-text"], table: [{ ...table[0], fixed_in: "1.0.0" }], gap: async () => { gapCalls++; return { x: 1 }; } });
    assert.equal(r2.audit.active, true);
    assert.equal(gapCalls, 1, "an active pipeline failure reaches the gap seam");
    assert.deepEqual(r2.audit.gap, { x: 1 });
  });
  it("genuine class does not call the gap seam; unclassified evidence still gets an audit", async () => {
    let gapCalls = 0;
    const w = world();
    await runLaneAudit({ ...w.o, detail: FIXTURES["genuine-spend"], gap: async () => { gapCalls++; } });
    assert.equal(gapCalls, 0);
    const u = world();
    const r = await runLaneAudit({ ...u.o, detail: "something new" });
    assert.equal(r.audit.signature, "unclassified");
  });
  it("the stubs are no-ops", async () => {
    assert.equal(await auditGap({}), null);
    assert.equal(await classifyWithLlm({}), null);
  });
  it("never throws, whatever fails", async () => {
    const r = await runLaneAudit({ issue: 1, reason: "needs-human", post: async () => { throw new Error("gh down"); } });
    assert.equal(r.posted, false);
    assert.match(r.skipped, /gh down/);
    assert.equal((await runLaneAudit()).posted, false);
  });
  it("compares versions", () => {
    assert.equal(compareVersions("1.2.0", "2.0.0"), -1);
    assert.equal(compareVersions("1.2.0", null), null);
  });
});
