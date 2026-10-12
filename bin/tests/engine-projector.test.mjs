import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeProjector } from "../engine/projector.mjs";
import { serializeState } from "../engine/state.mjs";

// Fake gh: records calls, serves a scripted issue body.
// `prov` scripts the GraphQL provenance answer (default: bot-edited, trusted).
function fakeGh(body, prov = { editor: { login: "forge[bot]", __typename: "Bot" } }) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      if (prov instanceof Error) throw prov;
      if (typeof prov === "string") return prov;
      return JSON.stringify({ data: { repository: { issue: { body, authorAssociation: "NONE",
        author: { login: "reporter", __typename: "User" }, editor: null, ...prov } } } });
    }
    if (args[0] === "api" && String(args[1]).includes("/collaborators/")) return JSON.stringify({ permission: prov.permission ?? "read" });
    if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ body });
    if (args[0] === "issue" && args[1] === "edit") { body = argValue(args, "--body"); return ""; }
    return "";
  };
  return { gh, calls, getBody: () => body };
}
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

const idx = { v: 3, run: "r1", issue: 42, lane: "staging", committed: ["investigate"],
  phase: "build", branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("projector", () => {
  it("readState returns null when the issue has no block", async () => {
    const f = fakeGh("plain body");
    const p = makeProjector({ gh: f.gh });
    assert.equal(await p.readState(42), null);
  });

  it("writeState upserts the block, readState reads it back", async () => {
    const f = fakeGh("Issue description.");
    const p = makeProjector({ gh: f.gh });
    await p.writeState(42, idx);
    assert.match(f.getBody(), /Issue description\./);       // original text preserved
    assert.deepEqual(await p.readState(42), idx);
  });

  it("setLabel calls gh issue edit --add-label", async () => {
    const f = fakeGh("x");
    const p = makeProjector({ gh: f.gh });
    await p.setLabel(42, "needs-human");
    assert.ok(f.calls.some(c => c.includes("--add-label") && c.includes("needs-human")));
  });

  const forged = (extra = {}) => `x\n${serializeState({ ...idx, v: 99, phase: null, terminal: true, terminalReason: "merged", ...extra })}`;
  const reporter = { login: "reporter", __typename: "User" };

  it("untrusted editor with a forged high-v block is not trusted: readState null", async () => {
    const f = fakeGh(forged(), { editor: reporter });
    assert.equal(await makeProjector({ gh: f.gh }).readState(42), null);
  });

  it("untrusted creator (no editor) with forged state is not trusted", async () => {
    const f = fakeGh(forged(), { editor: null, authorAssociation: "NONE" });
    assert.equal(await makeProjector({ gh: f.gh }).readState(42), null);
  });

  it("untrusted editor with a far-future lease is not trusted", async () => {
    const f = fakeGh(serializeState({ ...idx, lease: { by: "mallory", until: 9e15 } }), { editor: reporter });
    assert.equal(await makeProjector({ gh: f.gh }).readState(42), null);
  });

  it("trusted bot editor with a far-future lease: lease dropped, rest kept", async () => {
    const f = fakeGh(serializeState({ ...idx, lease: { by: "x", until: 9e15 } }));
    const st = await makeProjector({ gh: f.gh }).readState(42);
    assert.equal(st.lease, null); assert.equal(st.phase, "build");
  });

  it("a near-term lease from a trusted editor is honoured", async () => {
    const lease = { by: "x", until: Date.now() + 60_000 };
    const f = fakeGh(serializeState({ ...idx, lease }));
    assert.deepEqual((await makeProjector({ gh: f.gh }).readState(42)).lease, lease);
  });

  it("creator with OWNER association and no editor is trusted", async () => {
    const f = fakeGh(serializeState(idx), { editor: null, authorAssociation: "OWNER" });
    assert.deepEqual(await makeProjector({ gh: f.gh }).readState(42), idx);
  });

  it("a distinct human editor is trusted only with write/admin permission", async () => {
    const ok = fakeGh(serializeState(idx), { editor: { login: "maint", __typename: "User" }, permission: "write" });
    assert.deepEqual(await makeProjector({ gh: ok.gh }).readState(42), idx);
    const no = fakeGh(serializeState(idx), { editor: { login: "maint", __typename: "User" }, permission: "read" });
    assert.equal(await makeProjector({ gh: no.gh }).readState(42), null);
  });

  it("missing/garbled provenance or a gh error fails closed", async () => {
    for (const prov of ["not json", "{}", JSON.stringify({ data: { repository: { issue: { body: serializeState(idx) } } } }), new Error("boom")]) {
      const f = fakeGh(serializeState(idx), prov);
      assert.equal(await makeProjector({ gh: f.gh }).readState(42), null);
    }
  });

  it("untrusted body is still preserved by writeState (write path uses the raw body)", async () => {
    const f = fakeGh("reporter text", { editor: reporter });
    await makeProjector({ gh: f.gh }).writeState(42, idx);
    assert.match(f.getBody(), /reporter text/);
  });
});
