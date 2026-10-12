import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { PHASES, pickPhase, REMEDIATION_BOUND_MARKERS, cycleMarker, sliceToCurrentCycle, postCycleMarker, nextCycleNumber, decompositionRevoked, openDependency } from "../engine/phases.mjs";
import { PHASE_MARKERS } from "../../packages/protocol/src/phases.js";
import { RESERVED_TYPES } from "../../packages/protocol/src/types.js";
import { trusted, jsonLines, invBody, builderBody, remediationBody, remediationHeldBody } from "./helpers/comments.mjs";

const base = { v: 0, run: "r1", issue: 42, lane: "staging", committed: [], phase: null,
  branch: null, pr: null, terminal: false, terminalReason: null, lease: null };

describe("pickPhase", () => {
  it("returns the first uncommitted phase whose entryCondition holds", () => {
    assert.equal(pickPhase(base).id, "investigate");
    assert.equal(pickPhase({ ...base, committed: ["investigate"] }).id, "build");
  });

  it("returns null once all phases are committed", () => {
    const all = PHASES.map(p => p.id);
    assert.equal(pickPhase({ ...base, committed: all }), null);
  });

  it("returns null when the state is already terminal", () => {
    assert.equal(pickPhase({ ...base, terminal: true, terminalReason: "invalid" }), null);
  });

  // forge#2379: decompose/remediate coverage.
  it("returns 'decompose' when investigate committed with terminalReason 'decomposed'", () => {
    const state = { ...base, committed: ["investigate"], terminalReason: "decomposed" };
    assert.equal(pickPhase(state).id, "decompose");
  });

  it("does NOT return 'decompose' when investigate committed but terminalReason is unset (normal happy path)", () => {
    const state = { ...base, committed: ["investigate"], terminalReason: null };
    assert.equal(pickPhase(state).id, "build");
  });

  it("returns 'remediate' when review committed with terminalReason 'needs-human'", () => {
    const state = {
      ...base,
      committed: ["investigate", "build", "review"],
      pr: 7,
      terminalReason: "needs-human",
    };
    assert.equal(pickPhase(state).id, "remediate");
  });

  it("does NOT return 'remediate' when review committed but terminalReason is unset (normal happy path)", () => {
    const state = {
      ...base,
      committed: ["investigate", "build", "review"],
      terminalReason: null,
    };
    assert.equal(pickPhase(state).id, "close");
  });

  it("build.detectOutcome fails when there are no commits ahead of base (encodes #1305)", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([trusted(builderBody())]),
      git: async () => "0", // rev-list count = 0 commits ahead
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "failed");
  });

  it("build.detectOutcome commits when :COMPLETE marker present AND commits exist", async () => {
    const build = PHASES.find(p => p.id === "build");
    const io = {
      gh: async () => JSON.stringify([trusted(builderBody())]),
      git: async () => "2",
    };
    const outcome = await build.detectOutcome({ ...base, branch: "fix/x-42" }, io);
    assert.equal(outcome.status, "committed");
    assert.equal(outcome.outputs.branch, "fix/x-42");
  });

  it("close.detectOutcome does not throw on malformed gh response and reports failed", async () => {
    const close = PHASES.find(p => p.id === "close");
    const io = {
      gh: async () => "not json {{{",
      git: async () => "0",
    };
    const outcome = await close.detectOutcome({ ...base }, io);
    assert.equal(outcome.status, "failed");
  });

  describe("investigate.detectOutcome", () => {
    const investigate = PHASES.find(p => p.id === "investigate");
    // Each argument is a comment: a body string (OWNER-authored) or a full author object.
    // `issue view` (body fetch) is dispatched separately from `api` (comments): configure via ioWith.body / ioWith.bodyError.
    const ioWithBody = (body, ...cs) => ({
      gh: async (args) => (args[0] === "issue" ? (body instanceof Error ? Promise.reject(body) : body) : jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c)))),
      git: async () => "0",
    });
    const ioWith = (...cs) => ioWithBody("", ...cs);

    it("INVALID sentinel as the closing line -> committed, terminalReason invalid", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("INVALID")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("Decomposition Assessment YES -> committed, terminalReason decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("COMPLETE", { decompose: true })));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "decomposed");
    });

    // forge#3543: structured per-comment fixtures (one JSON string per line,
    // the shape issueMarkers() asks gh for) so `comments` is populated.
    const ioComments = (...bodies) => ioWith(...bodies);
    const inv = (assessment, tail = "") =>
      `<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n\n### Recommendation\nDo it.\n\n### Decomposition Assessment\n${assessment}\n${tail}\n<!-- INVESTIGATION:COMPLETE -->`;

    it("investigator **YES** heading without marker -> decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**YES**: three independent pieces.\n1. feat(a)\n2. feat(b)")));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("<!-- DECOMPOSE:YES --> marker -> decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**YES** — split", `<!-- ${PHASE_MARKERS.investigate.decomposedMarker} -->`)));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("**NO** + <!-- DECOMPOSE:NO --> -> committed, goes to build", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**NO** — one PR", `<!-- ${PHASE_MARKERS.investigate.notDecomposedMarker} -->`)));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
    });

    it("NO investigator comment quoting DECOMPOSE:YES is not decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(
        inv("**NO** — fits one PR", "Note: engine waits for DECOMPOSE:YES and <!-- DECOMPOSE:YES --> text"),
        "architect plan mentions DECOMPOSE:YES"));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("quoted DECOMPOSE:YES in another comment does not override NO verdict", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**NO** — fits one PR"), "see DECOMPOSE:YES docs"));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("latest investigator comment wins (YES then re-investigated NO)", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**YES** — split"), inv("**NO** — fits")));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("INVALID still wins over a YES assessment", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**YES** — split").replace("<!-- INVESTIGATION:COMPLETE -->", "<!-- INVESTIGATION:INVALID -->")));
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("tolerates CRLF line endings in the assessment", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(inv("**YES** — split").replace(/\n/g, "\r\n")));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("later comment merely mentioning FORGE:INVESTIGATOR does not shadow a real DECOMPOSE:YES (SEC-1)", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(
        inv("**YES** — split", `<!-- ${PHASE_MARKERS.investigate.decomposedMarker} -->`),
        "architect: read the FORGE:INVESTIGATOR report first"));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("a stray quoted NO marker does not override an explicit YES verdict + marker (SEC-2)", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(
        inv("**YES** — split", `<!-- ${PHASE_MARKERS.investigate.decomposedMarker} -->\nEmit \`<!-- DECOMPOSE:NO -->\` when not splitting.`)));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("conflicting heading and own-line marker fails safe (not decomposed)", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(
        inv("**YES** — split", `<!-- ${PHASE_MARKERS.investigate.notDecomposedMarker} -->`)));
      assert.equal(outcome.terminalReason, undefined);
    });

    // forge#3862: decomposition rests on separability, never on size. No estimate net remains.
    const sized = (verdict, est, seams = 2, justification) => inv(verdict, `ESTIMATED_DIFF_LINES: ${est}\nINDEPENDENT_SEAMS: ${seams}\n${justification === undefined ? "" : `DECOMPOSE_JUSTIFICATION: ${justification}\n`}<!-- DECOMPOSE:${/YES/.test(verdict) ? "YES" : "NO"} -->`);

    it("a NO verdict is never overturned by a huge estimate (no size-based routing)", async () => {
      for (const est of [1500, 5000, 100000]) {
        const outcome = await investigate.detectOutcome(base, ioComments(sized("**NO** — one cohesive change", est, 1)));
        assert.equal(outcome.terminalReason, undefined, `estimate ${est}`);
      }
    });

    it("a legacy report carrying GATE_THRESHOLD / ESTIMATE_FACTOR is read as NO (fields ignored)", async () => {
      const legacy = inv("**NO** — one PR", "ESTIMATED_DIFF_LINES: 1500\nINDEPENDENT_SEAMS: 1\nGATE_THRESHOLD: 1000\nESTIMATE_FACTOR: 1.0\n<!-- DECOMPOSE:NO -->");
      const outcome = await investigate.detectOutcome(base, ioComments(legacy));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("separable YES (2+ seams, own-line DECOMPOSE_JUSTIFICATION) -> decomposed, however small the estimate", async () => {
      for (const est of [90, 600, 5000]) {
        const outcome = await investigate.detectOutcome(base, ioComments(sized("**YES** — independent services", est, 2, "services a and b share no file and have no ordering")));
        assert.equal(outcome.terminalReason, "decomposed", `estimate ${est}`);
      }
    });

    it("YES with a single seam is downgraded to NO even when huge (size is not separability)", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(sized("**YES** — too big", 5000, 1, "it is large")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
    });

    it("YES with 2+ seams but no DECOMPOSE_JUSTIFICATION is downgraded", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(sized("**YES** — split", 1500, 3)));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("quoted mid-line DECOMPOSE_JUSTIFICATION does not justify a YES", async () => {
      const body = inv("**YES** — split", "see `DECOMPOSE_JUSTIFICATION: x` inline\nESTIMATED_DIFF_LINES: 1150\nINDEPENDENT_SEAMS: 2\n<!-- DECOMPOSE:YES -->");
      const outcome = await investigate.detectOutcome(base, ioComments(body));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("YES without a seam field stays decomposed (older or malformed report is not silently downgraded)", async () => {
      const bare = await investigate.detectOutcome(base, ioComments(inv("**YES** — split")));
      assert.equal(bare.terminalReason, "decomposed");
    });

    it("estimate fields in an untrusted comment or quoted mid-line are ignored", async () => {
      const untrusted = trusted(sized("**YES** — split", 9000, 4, "x"), { assoc: "NONE", type: "User", login: "drive-by" });
      const o1 = await investigate.detectOutcome(base, ioComments(inv("**NO** — fits"), untrusted));
      assert.equal(o1.terminalReason, undefined);
      const o2 = await investigate.detectOutcome(base, ioComments(inv("**NO** — fits", "see `ESTIMATED_DIFF_LINES: 9000` inline")));
      assert.equal(o2.terminalReason, undefined);
    });

    it("conflicting signals still fail safe", async () => {
      const outcome = await investigate.detectOutcome(base, ioComments(
        inv("**YES** — split", `ESTIMATED_DIFF_LINES: 5000\n<!-- ${PHASE_MARKERS.investigate.notDecomposedMarker} -->`)));
      assert.equal(outcome.terminalReason, undefined);
    });

    // forge#3676: loop guard — a child / decomposed / overridden issue is never routed to decompose.
    const separable = () => sized("**YES** — independent services", 1500, 2, "no shared files, no ordering");
    const childBody = "## Problem\n\n**Parent**: #12\n\nbody";
    const override = (just) => `<!-- ${PHASE_MARKERS.build.sizeOverrideMarker} -->${just ? `\n${just}` : ""}`;

    it("separable YES on a plain issue (control) -> decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWithBody("", separable()));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("child issue with a separable YES -> not decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWithBody(childBody, separable()));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
    });

    it("trusted FORGE:DECOMPOSED comment suppresses a YES", async () => {
      const outcome = await investigate.detectOutcome(base, ioWithBody("", separable(), "<!-- FORGE:DECOMPOSED -->\nspawned"));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("untrusted FORGE:DECOMPOSED comment does not suppress", async () => {
      const fake = trusted("<!-- FORGE:DECOMPOSED -->\nspawned", { assoc: "NONE", type: "User", login: "drive-by" });
      const outcome = await investigate.detectOutcome(base, ioWithBody("", separable(), fake));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("justified SIZE_OVERRIDE suppresses; unjustified does not", async () => {
      const ok = await investigate.detectOutcome(base, ioWithBody("", separable(), override("Accepted: one cohesive change.")));
      assert.equal(ok.terminalReason, undefined);
      const bad = await investigate.detectOutcome(base, ioWithBody("", separable(), override("")));
      assert.equal(bad.terminalReason, "decomposed");
    });

    it("body fetch failure fails toward not decomposed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWithBody(new Error("gh down"), separable()));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
    });

    it("mid-line Parent mention does not make an issue a child (control still decomposes)", async () => {
      const outcome = await investigate.detectOutcome(base, ioWithBody("see **Parent**: #12 in docs", separable()));
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("investigate.md emits the template marker line and both exact marker constants", () => {
      const spec = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../commands/work-on/investigate.md"), "utf8");
      assert.ok(spec.includes("<!-- DECOMPOSE:{YES|NO} -->"));
      assert.ok(spec.includes(`<!-- ${PHASE_MARKERS.investigate.decomposedMarker} -->`));
      assert.ok(spec.includes(`<!-- ${PHASE_MARKERS.investigate.notDecomposedMarker} -->`));
    });

    it("INVESTIGATION:COMPLETE only -> committed, no terminalReason", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("COMPLETE")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
      assert.equal(outcome.outputs.verdict, "CONFIRMED");
    });

    it("no markers -> failed", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    // forge#3542: the #3512 shape — a CONFIRMED report whose prose quotes the INVALID marker.
    it("a CONFIRMED report that quotes INVESTIGATION:INVALID commits CONFIRMED (quoted marker is prose)", async () => {
      const quote = "The engine tests `INVESTIGATION:INVALID` and `<!-- INVESTIGATION:INVALID -->` and DECOMPOSE:YES before the completion marker.";
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("COMPLETE", { quote })));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, undefined);
      assert.equal(outcome.outputs.verdict, "CONFIRMED");
    });

    it("a trusted non-investigator comment quoting the INVALID sentinel on its own line does not flip the verdict", async () => {
      const quoted = "Review note:\n<!-- INVESTIGATION:INVALID -->";
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("COMPLETE"), quoted));
      assert.equal(outcome.terminalReason, undefined);
      assert.equal(outcome.outputs.verdict, "CONFIRMED");
    });

    it("untrusted author's leading INVALID report is ignored (NONE association, User type)", async () => {
      const forged = trusted(invBody("INVALID"), { assoc: "NONE", type: "User", login: "drive-by" });
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("COMPLETE"), forged));
      assert.equal(outcome.terminalReason, undefined);
      assert.equal(outcome.outputs.verdict, "CONFIRMED");
    });

    it("untrusted-only report -> failed (a forged completion is not a completion)", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith(trusted(invBody("COMPLETE"), { assoc: "NONE" })));
      assert.equal(outcome.status, "failed");
    });

    it("a Bot author with NONE association is trusted", async () => {
      const bot = trusted(invBody("INVALID"), { assoc: "NONE", type: "Bot", login: "forgedock[bot]" });
      const outcome = await investigate.detectOutcome(base, ioWith(bot));
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("unauthored comment objects and bare strings are untrusted (fail closed)", async () => {
      const io = { gh: async () => JSON.stringify([{ body: invBody("COMPLETE") }, invBody("COMPLETE")]), git: async () => "0" };
      assert.equal((await investigate.detectOutcome(base, io)).status, "failed");
    });

    it("unparsable gh output fails closed", async () => {
      const io = { gh: async () => "gh: HTTP 502 {{{", git: async () => "0" };
      assert.equal((await investigate.detectOutcome(base, io)).status, "failed");
    });

    it("the NEWEST trusted investigator report wins over an older one", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith(invBody("INVALID"), invBody("COMPLETE")));
      assert.equal(outcome.terminalReason, undefined);
    });

    it("multi-line --paginate output (one author-shaped JSON object per line) is parsed per comment", async () => {
      const outcome = await investigate.detectOutcome(base, ioWith("hello", invBody("INVALID")));
      assert.equal(outcome.terminalReason, "invalid");
    });

    describe("FORGE_TRAIL_TRUSTED_* env (matches scripts/trusted-comments.sh)", () => {
      const save = { a: process.env.FORGE_TRAIL_TRUSTED_ASSOCIATIONS, l: process.env.FORGE_TRAIL_TRUSTED_LOGINS };
      const restore = () => {
        for (const [k, v] of [["FORGE_TRAIL_TRUSTED_ASSOCIATIONS", save.a], ["FORGE_TRAIL_TRUSTED_LOGINS", save.l]])
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
      };
      it("an explicitly empty association list trusts no association", async () => {
        process.env.FORGE_TRAIL_TRUSTED_ASSOCIATIONS = "";
        try { assert.equal((await investigate.detectOutcome(base, ioWith(invBody("COMPLETE")))).status, "failed"); } finally { restore(); }
      });
      it("FORGE_TRAIL_TRUSTED_LOGINS trusts a listed login regardless of association", async () => {
        process.env.FORGE_TRAIL_TRUSTED_LOGINS = "helper, other";
        try {
          const c = trusted(invBody("COMPLETE"), { assoc: "NONE", login: "helper" });
          assert.equal((await investigate.detectOutcome(base, ioWith(c))).status, "committed");
        } finally { restore(); }
      });
    });
  });

  // forge#2379: decompose is now a real phase (previously investigate's
  // "decomposed" terminalReason short-circuited before this phase could ever
  // run — see bin/engine.mjs's isDecomposeHandoff exemption).
  describe("decompose.detectOutcome", () => {
    const decompose = PHASES.find(p => p.id === "decompose");
    const ioWith = (...cs) => ({ gh: async () => jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c))), git: async () => "0" });
    const done = "<!-- FORGE:DECOMPOSED -->\nspawned sub-issues\n<!-- FORGE:DECOMPOSED:COMPLETE -->";

    it("FORGE:DECOMPOSED:COMPLETE present -> committed, terminalReason decomposed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith(done));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "decomposed");
    });

    it("bare FORGE:DECOMPOSED (no :COMPLETE) -> failed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("<!-- FORGE:DECOMPOSED --> in progress"));
      assert.equal(outcome.status, "failed");
    });

    it("a quoted completion marker inside prose does not count", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("The engine looks for <!-- FORGE:DECOMPOSED:COMPLETE --> in a decompose comment."));
      assert.equal(outcome.status, "failed");
    });

    it("a completion marker in a non-DECOMPOSED comment (header not leading) does not count", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("Quoting the trail:\n<!-- FORGE:DECOMPOSED:COMPLETE -->"));
      assert.equal(outcome.status, "failed");
    });

    it("untrusted author's complete trail does not count", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith(trusted(done, { assoc: "NONE" })));
      assert.equal(outcome.status, "failed");
    });

    it("no marker at all -> failed", async () => {
      const outcome = await decompose.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    it("entryCondition fires only when terminalReason is 'decomposed'", () => {
      assert.equal(decompose.entryCondition({ ...base, terminalReason: "decomposed" }), true);
      assert.equal(decompose.entryCondition({ ...base, terminalReason: null }), false);
      assert.equal(decompose.entryCondition({ ...base, terminalReason: "invalid" }), false);
    });

    it("is always terminal after committing", () => {
      assert.equal(decompose.isTerminalAfter({ ...base, terminalReason: "decomposed" }), true);
    });
  });

  // forge#2379: remediate is now a registered phase — see bin/engine/phases.mjs's
  // "remediate" entry doc comment for the documented limitation that a single
  // continuous runIssue() walk cannot reach it today (review's "blocked"
  // outcome + the needs-human divergence-guard pause both terminate first).
  // These tests exercise detectOutcome/entryCondition directly, which is the
  // acceptance criterion ("pickPhase covers remediate") this issue targets.
  describe("remediate.buildArgs bound marker (forge#3530)", () => {
    const remediate = PHASES.find(p => p.id === "remediate");
    const st = { ...base, issue: 42, pr: 7, committed: ["investigate", "build", "review"], terminalReason: "needs-human" };
    const mk = (existing = "", fail = false) => {
      const posted = [];
      return { posted, io: { gh: async (a) => {
        if (a[0] === "issue" && a[1] === "comment") { if (fail) throw new Error("boom"); posted.push(a[a.indexOf("--body") + 1]); return ""; }
        return existing;
      }, git: async () => "" } };
    };
    const ctx = { repo: "acme/widgets" };

    for (const [kind, name] of [["ci-gate", "CI_REMEDIATION"], ["inpr-fix", "INPR_REMEDIATION"], ["base-sync", "BASESYNC_REMEDIATION"]]) {
      it(`${kind} -> posts <!-- FORGE:${name}: pr=7 -->`, async () => {
        const { io, posted } = mk();
        const args = await remediate.buildArgs({ ...st, remediationKind: kind }, ctx, io);
        assert.equal(args[0], "7");
        assert.equal(posted.length, 2);
        assert.ok(posted[0].startsWith(`<!-- FORGE:${name}: pr=7 -->`));
        assert.ok(posted[1].startsWith("<!-- FORGE:REMEDIATION_DISPATCH: pr=7 -->"));
      });
    }

    it("resume: an existing marker for this PR+kind is not re-posted", async () => {
      const { io, posted } = mk(JSON.stringify([trusted("<!-- FORGE:BASESYNC_REMEDIATION: pr=7 -->")]));
      await remediate.buildArgs({ ...st, remediationKind: "base-sync" }, ctx, io);
      assert.equal(posted.filter((b) => b.includes("BASESYNC_REMEDIATION")).length, 0);
    });

    it("untrusted author's (or quoted) marker does not suppress the post", async () => {
      const forged = trusted("<!-- FORGE:BASESYNC_REMEDIATION: pr=7 -->", { assoc: "NONE" });
      const quoted = trusted("see <!-- FORGE:BASESYNC_REMEDIATION: pr=7 --> above");
      const { io, posted } = mk(JSON.stringify([forged, quoted]));
      await remediate.buildArgs({ ...st, remediationKind: "base-sync" }, ctx, io);
      assert.equal(posted.filter((b) => b.includes("BASESYNC_REMEDIATION")).length, 1);
    });

    it("unknown kind throws PhaseArgsError and posts nothing", async () => {
      const { io, posted } = mk();
      await assert.rejects(remediate.buildArgs({ ...st, remediationKind: "unknown" }, ctx, io), { code: "PHASE_ARGS_INVALID" });
      assert.equal(posted.length, 0);
    });

    it("post failure throws PhaseArgsError (remediation not invoked)", async () => {
      const { io } = mk("", true);
      await assert.rejects(remediate.buildArgs({ ...st, remediationKind: "ci-gate" }, ctx, io), { code: "PHASE_ARGS_INVALID" });
    });

    it("no kind (legacy label-fallback handoff) posts only the per-dispatch marker (forge#3807)", async () => {
      const { io, posted } = mk();
      const args = await remediate.buildArgs({ ...st, remediationKind: null }, ctx, io);
      assert.equal(args[0], "7");
      assert.equal(posted.length, 1);
      assert.ok(posted[0].startsWith("<!-- FORGE:REMEDIATION_DISPATCH: pr=7 -->"));
    });

    it("dispatch marker is posted every call, even when the bound marker already exists (forge#3807)", async () => {
      const { io, posted } = mk(JSON.stringify([trusted("<!-- FORGE:BASESYNC_REMEDIATION: pr=7 -->")]));
      await remediate.buildArgs({ ...st, remediationKind: "base-sync" }, ctx, io);
      assert.equal(posted.length, 1);
      assert.ok(posted[0].startsWith("<!-- FORGE:REMEDIATION_DISPATCH: pr=7 -->"));
    });
  });

  describe("remediate.detectOutcome", () => {
    const remediate = PHASES.find(p => p.id === "remediate");
    const ioWith = (...cs) => ({ gh: async () => jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c))), git: async () => "0" });
    const remediateBody = (outcome) => remediationBody(`${outcome} to staging`);

    // forge#3807: a deferral is only current when it is newer than the newest dispatch marker.
    const deferredC = "<!-- FORGE:REMEDIATION_DEFERRED -->\n## Remediation Deferred\n\npr=7\nkind=lease";
    const dispatchC = "<!-- FORGE:REMEDIATION_DISPATCH: pr=7 -->\nEngine dispatching remediation for PR #7.";
    const stDef = { ...base, issue: 42, pr: 7 };
    it("stale DEFERRED then a later DISPATCH, no trail -> failed (forge#3807)", async () => {
      const r = await remediate.detectOutcome(stDef, ioWith(dispatchC, deferredC, dispatchC));
      assert.equal(r.status, "failed");
    });
    it("DISPATCH then DEFERRED -> blocked/deferred (forge#3807)", async () => {
      const r = await remediate.detectOutcome(stDef, ioWith(dispatchC, deferredC));
      assert.equal(r.status, "blocked");
      assert.equal(r.reason, "deferred");
    });
    it("DEFERRED with no dispatch marker keeps legacy behaviour (forge#3807)", async () => {
      const r = await remediate.detectOutcome(stDef, ioWith(deferredC));
      assert.equal(r.reason, "deferred");
    });

    // forge#3685: held-resume record is non-terminal (no COMPLETE) and must read as awaiting-merge, not a failed phase.
    const heldIo = (merged, ...cs) => ({
      gh: async (args) => (args[0] === "pr" && args[1] === "view"
        ? JSON.stringify(merged ? { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" } : { state: "OPEN" })
        : jsonLines(cs.map((c) => (typeof c === "string" ? trusted(c) : c)))),
      git: async () => "0",
    });
    it("forge#3685: held-only record -> committed awaiting-merge (not failed)", async () => {
      const o = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(false, remediationHeldBody()));
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, "awaiting-merge");
      assert.equal(o.outputs.reGateOutcome, "HELD-AWAITING-MERGE");
    });
    it("forge#3685: COMPLETE newer than held -> COMPLETE wins", async () => {
      const o = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(false, remediationHeldBody(), remediateBody("RE-ESCALATED")));
      assert.equal(o.terminalReason, "needs-human");
    });
    it("forge#3685: held newer than COMPLETE -> held wins", async () => {
      const o = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(false, remediateBody("RE-ESCALATED"), remediationHeldBody()));
      assert.equal(o.terminalReason, "awaiting-merge");
    });
    it("forge#3685: held record + merged PR -> merged with closeHandoff", async () => {
      const o = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(true, remediationHeldBody()));
      assert.equal(o.terminalReason, "merged");
      assert.equal(o.outputs.closeHandoff, true);
    });
    it("forge#3685: untrusted or quoted held marker is ignored", async () => {
      const untrusted = { body: remediationHeldBody(), author_association: "NONE", user: { type: "User", login: "mallory" } };
      const o1 = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(false, untrusted));
      assert.equal(o1.status, "failed");
      const o2 = await remediate.detectOutcome({ ...base, pr: 7 }, heldIo(false, `Quoted:\n${remediationHeldBody()}`));
      assert.equal(o2.status, "failed");
    });

    it("AUTO-LANDED -> committed, terminalReason merged", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("AUTO-LANDED")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
      assert.equal(outcome.outputs.reGateOutcome, "AUTO-LANDED");
    });

    // forge#3624: AUTO-LANDED verifies the issue's real state before ending the run.
    const snapIo = (snap) => ({
      gh: async (args) => {
        if (args[0] === "issue" && args[1] === "view") {
          if (snap instanceof Error) throw snap;
          return typeof snap === "string" ? snap : JSON.stringify(snap);
        }
        return jsonLines([trusted(remediateBody("AUTO-LANDED"))]);
      },
      git: async () => "0",
    });

    it("AUTO-LANDED + issue CLOSED with workflow:merged -> terminal merged, no closeHandoff", async () => {
      const o = await remediate.detectOutcome(base, snapIo({ state: "CLOSED", labels: [{ name: "workflow:merged" }] }));
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, "merged");
      assert.equal(o.outputs.closeHandoff, undefined);
    });

    for (const [name, snap] of [
      ["issue OPEN", { state: "OPEN", labels: [{ name: "workflow:investigating" }] }],
      ["CLOSED but workflow:merged label missing", { state: "CLOSED", labels: [] }],
      ["malformed snapshot", "not json"],
      ["snapshot throws", new Error("gh down")],
    ]) {
      it(`AUTO-LANDED + ${name} -> merged with closeHandoff`, async () => {
        const o = await remediate.detectOutcome(base, snapIo(snap));
        assert.equal(o.status, "committed");
        assert.equal(o.terminalReason, "merged");
        assert.equal(o.outputs.closeHandoff, true);
      });
    }

    it("forge#3644: AUTO-LANDED + issue OPEN with workflow:merged -> closeHandoff, and close.reconcile is not satisfied", async () => {
      const snap = { state: "OPEN", labels: [{ name: "workflow:merged" }] };
      const o = await remediate.detectOutcome(base, snapIo(snap));
      assert.equal(o.outputs.closeHandoff, true);
      const close = PHASES.find(p => p.id === "close");
      assert.equal((await close.reconcile(base, snapIo(snap))).satisfied, false);
      assert.equal((await close.reconcile(base, snapIo({ state: "CLOSED", labels: [{ name: "workflow:merged" }] }))).satisfied, true);
    });

    it("other outcomes never set closeHandoff", async () => {
      for (const r of ["HELD-AWAITING-MERGE", "RE-ESCALATED", "UNFIXABLE"]) {
        const o = await remediate.detectOutcome(base, ioWith(remediateBody(r)));
        assert.equal(o.outputs.closeHandoff, undefined);
      }
    });

    // forge#3647: ground-truth PR read (awaiting-merge / merged resume).
    const prIo = ({ comments = [], pr, issue }) => ({
      gh: async (args) => {
        if (args[0] === "pr" && args[1] === "view") {
          if (pr instanceof Error) throw pr;
          return typeof pr === "string" ? pr : JSON.stringify(pr);
        }
        if (args[0] === "issue" && args[1] === "view") return JSON.stringify(issue ?? { state: "OPEN", labels: [{ name: "workflow:awaiting-merge" }] });
        return jsonLines(comments.map((c) => trusted(c)));
      },
      git: async () => "0",
    });
    const withPr = { ...base, pr: 7 };
    const merged = { state: "MERGED", mergedAt: "2026-10-11T00:00:00Z", baseRefName: "staging" };

    it("awaiting-merge resume: no COMPLETE marker + PR MERGED + issue OPEN -> merged with closeHandoff", async () => {
      const o = await remediate.detectOutcome(withPr, prIo({ pr: merged }));
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, "merged");
      assert.equal(o.outputs.closeHandoff, true);
    });

    it("awaiting-merge resume: no marker + PR MERGED + issue CLOSED/merged -> merged, no handoff", async () => {
      const issue = { state: "CLOSED", labels: [{ name: "workflow:merged" }] };
      const o = await remediate.detectOutcome(withPr, prIo({ pr: merged, issue }));
      assert.equal(o.terminalReason, "merged");
      assert.equal(o.outputs.closeHandoff, undefined);
    });

    it("awaiting-merge: HELD marker + PR MERGED -> merged with closeHandoff, not awaiting-merge", async () => {
      const o = await remediate.detectOutcome(withPr, prIo({ pr: merged, comments: [remediateBody("HELD-AWAITING-MERGE")] }));
      assert.equal(o.terminalReason, "merged");
      assert.equal(o.outputs.closeHandoff, true);
    });

    it("awaiting-merge: HELD marker + PR OPEN -> awaiting-merge unchanged", async () => {
      const o = await remediate.detectOutcome(withPr, prIo({ pr: { state: "OPEN", mergedAt: null }, comments: [remediateBody("HELD-AWAITING-MERGE")] }));
      assert.equal(o.terminalReason, "awaiting-merge");
    });

    for (const [name, pr] of [
      ["PR OPEN", { state: "OPEN", mergedAt: null }],
      ["PR CLOSED unmerged", { state: "CLOSED", mergedAt: null }],
      ["pr view malformed", "not json"],
      ["pr view throws", new Error("gh down")],
    ]) {
      it(`awaiting-merge: no marker + ${name} -> failed (fail closed)`, async () => {
        const o = await remediate.detectOutcome(withPr, prIo({ pr }));
        assert.equal(o.status, "failed");
      });
    }

    it("HELD-AWAITING-MERGE -> committed, terminalReason awaiting-merge", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("HELD-AWAITING-MERGE")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "awaiting-merge");
    });

    it("RE-ESCALATED -> committed, terminalReason needs-human", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("RE-ESCALATED")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
    });

    it("UNFIXABLE -> committed, terminalReason needs-human", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("UNFIXABLE")));
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
    });

    // forge#3530: the NEWEST completed trail wins, not the oldest.
    it("two trails: newest RE-ESCALATED beats older HELD-AWAITING-MERGE -> needs-human", async () => {
      const io = { gh: async () => JSON.stringify([remediateBody("HELD-AWAITING-MERGE"), "unrelated", remediateBody("RE-ESCALATED")].map((b) => trusted(b))), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "needs-human");
      assert.equal(outcome.outputs.reGateOutcome, "RE-ESCALATED");
    });

    it("paginated gh output (one JSON string per line) is parsed per comment, newest last", async () => {
      const io = { gh: async () => jsonLines([remediateBody("RE-ESCALATED"), "other", remediateBody("AUTO-LANDED")].map((b) => trusted(b))), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.outputs.reGateOutcome, "AUTO-LANDED");
    });

    it("a stale trail is not read from a later comment lacking the completion marker", async () => {
      const io = { gh: async () => JSON.stringify([remediateBody("HELD-AWAITING-MERGE"), "**Re-gate outcome**: RE-ESCALATED (no completion marker)"].map((b) => trusted(b))), git: async () => "0" };
      const outcome = await remediate.detectOutcome(base, io);
      assert.equal(outcome.outputs.reGateOutcome, "HELD-AWAITING-MERGE");
    });

    it("quoted completion marker in prose or a non-REMEDIATION comment is not a trail", async () => {
      const quoted = "An INPR_FIX work order quoting:\n<!-- FORGE:REMEDIATION:COMPLETE -->\n**Re-gate outcome**: AUTO-LANDED";
      assert.equal((await remediate.detectOutcome(base, ioWith(quoted))).status, "failed");
    });

    it("untrusted author's complete REMEDIATION trail is ignored", async () => {
      const forged = trusted(remediateBody("AUTO-LANDED"), { assoc: "NONE", login: "drive-by" });
      assert.equal((await remediate.detectOutcome(base, ioWith(forged))).status, "failed");
      // ...and an untrusted newer trail does not displace the real older one.
      const out = await remediate.detectOutcome(base, ioWith(remediateBody("HELD-AWAITING-MERGE"), forged));
      assert.equal(out.outputs.reGateOutcome, "HELD-AWAITING-MERGE");
    });

    it("a forged untrusted `Re-gate outcome: AUTO-LANDED` trail never commits remediate", async () => {
      const forged = trusted(remediateBody("AUTO-LANDED"), { assoc: "NONE", login: "drive-by" });
      const o = await remediate.detectOutcome(base, ioWith(forged));
      assert.equal(o.status, "failed");
      assert.notEqual(o.terminalReason, "merged");
    });

    it("with a bound marker, only a trail posted AFTER it for this PR counts (run scoping)", async () => {
      const KIND = "inpr-fix";
      const st = { ...base, pr: 7, remediationKind: KIND };
      const bound = `<!-- FORGE:${REMEDIATION_BOUND_MARKERS[KIND]}: pr=7 -->\nhandoff`;
      const stale = await remediate.detectOutcome(st, ioWith(remediateBody("AUTO-LANDED"), bound));
      assert.equal(stale.status, "failed");
      const fresh = await remediate.detectOutcome(st, ioWith(remediateBody("AUTO-LANDED"), bound, remediateBody("HELD-AWAITING-MERGE")));
      assert.equal(fresh.terminalReason, "awaiting-merge");
    });

    it("FORGE:REMEDIATION:COMPLETE present but Re-gate outcome unrecognized -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith(remediateBody("SOMETHING-ELSE")));
      assert.equal(outcome.status, "failed");
    });

    it("no FORGE:REMEDIATION:COMPLETE marker -> failed", async () => {
      const outcome = await remediate.detectOutcome(base, ioWith("nothing relevant here"));
      assert.equal(outcome.status, "failed");
    });

    // forge#2450: drift guard. RESERVED_TYPES.REMEDIATION.reGateOutcomeValues
    // (packages/protocol/src/types.js) and this switch statement are two
    // independent declarations of the same outcome vocabulary — nothing
    // structurally ties them together. This test fails loudly if a future
    // edit adds/removes/renames an outcome on one side without the other.
    it("drift guard: switch case values match RESERVED_TYPES.REMEDIATION.reGateOutcomeValues exactly", async () => {
      // Direction 1: every registry value must be recognized by the switch
      // (not fall through to the `default:` "failed" branch).
      for (const registryOutcome of RESERVED_TYPES.REMEDIATION.reGateOutcomeValues) {
        const outcome = await remediate.detectOutcome(base, ioWith(remediateBody(registryOutcome)));
        assert.notEqual(
          outcome.status,
          "failed",
          `Registry outcome "${registryOutcome}" is not recognized by phases.mjs's remediate switch — the two declarations have drifted`,
        );
      }

      // Direction 2: the switch must not handle any outcome absent from the
      // registry (parsed directly from source text, since the switch's case
      // labels aren't otherwise exposed as data).
      const phasesSrc = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "../engine/phases.mjs"),
        "utf8",
      );
      const remediateStart = phasesSrc.indexOf('id: "remediate"');
      const remediateEnd = phasesSrc.indexOf("isTerminalAfter", remediateStart);
      const switchSection = phasesSrc.slice(remediateStart, remediateEnd);
      const caseValues = [...new Set([...switchSection.matchAll(/case\s+"([A-Z-]+)":/g)].map((m) => m[1]))];

      assert.deepEqual(
        caseValues.sort(),
        [...RESERVED_TYPES.REMEDIATION.reGateOutcomeValues].sort(),
        "phases.mjs's remediate switch case values must exactly match RESERVED_TYPES.REMEDIATION.reGateOutcomeValues",
      );
    });

    it("entryCondition requires review committed AND terminalReason needs-human", () => {
      const reviewCommitted = { ...base, committed: ["build", "review"] };
      assert.equal(remediate.entryCondition({ ...reviewCommitted, terminalReason: "needs-human" }), true);
      assert.equal(remediate.entryCondition({ ...reviewCommitted, terminalReason: null }), false);
      assert.equal(remediate.entryCondition({ ...base, terminalReason: "needs-human" }), false); // review not committed
    });

    it("is always terminal after committing", () => {
      assert.equal(remediate.isTerminalAfter({ ...base, terminalReason: "needs-human" }), true);
    });
  });

  describe("review.detectOutcome", () => {
    const review = PHASES.find(p => p.id === "review");
    const reviewState = { ...base, branch: "fix/x-42" };

    function ioFor({ prList, prView, issueLabels }) {
      return {
        gh: async (args) => {
          const cmd = args.join(" ");
          if (cmd.startsWith("issue view") && issueLabels)
            return JSON.stringify({ state: "OPEN", labels: issueLabels.map((name) => ({ name })) });
          if (cmd.startsWith("pr list")) return prList;
          if (cmd.startsWith("pr view")) return prView;
          throw new Error(`unexpected gh call: ${cmd}`);
        },
        git: async () => "0",
      };
    }

    it("no PR -> failed", async () => {
      const io = ioFor({ prList: "[]", prView: "" });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "failed");
    });

    it("PR merged -> committed with outputs.pr", async () => {
      const io = ioFor({
        prList: JSON.stringify([{ number: 7 }]),
        prView: JSON.stringify({ number: 7, state: "MERGED", mergedAt: "t", labels: [] }),
      });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("PR open with needs-human label -> blocked", async () => {
      const io = ioFor({
        prList: JSON.stringify([{ number: 7 }]),
        prView: JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [{ name: "needs-human" }] }),
      });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });

    const openUnlabelled = {
      prList: JSON.stringify([{ number: 7 }]),
      prView: JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [] }),
    };
    const rr = (body) => ({ text: `done\nREVIEW_RESULT:\n${body}\n` });

    it("forge#3521: needs-human on the issue only (PR unlabelled) -> blocked with outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:in-review", "needs-human"] });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3541: workflow:remediating on the issue only (no needs-human, PR unlabelled) -> blocked with outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:remediating"] });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3541: workflow:remediating on the PR -> blocked with outputs.pr", async () => {
      const io = ioFor({
        prList: JSON.stringify([{ number: 7 }]),
        prView: JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [{ name: "workflow:remediating" }] }),
        issueLabels: [],
      });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
      assert.equal(outcome.handoff, true, "escalation is an explicit opt-in handoff");
    });

    it("forge#3525: no-signal review failure carries no handoff opt-in", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      const outcome = await review.detectOutcome(reviewState, io);
      assert.equal(outcome.status, "failed");
      assert.notEqual(outcome.handoff, true);
    });

    it("forge#3541: an explicit REVIEW_RESULT BLOCKED with workflow:remediating on the issue is not a handoff", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:remediating"] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: BLOCKED\n  blocker: x"));
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.handoff, false);
    });

    it("forge#3541: each autonomous kind hands off with no needs-human label anywhere", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:remediating"] });
      for (const kind of ["ci-gate", "inpr-fix", "base-sync"]) {
        const outcome = await review.detectOutcome(reviewState, io,
          rr(`  status: NEXT\n  next: remediate\n  remediation: ${kind}\n  pr_number: 7`));
        assert.equal(outcome.status, "blocked", kind);
        assert.equal(outcome.outputs.remediation, kind);
      }
    });

    it("forge#3592: a HIGH in-PR work order (NEXT/remediate/inpr-fix) hands off and pickPhase then reaches remediate", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: ["workflow:remediating"] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  remediation: inpr-fix\n  pr_number: 7"));
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.handoff, true);
      assert.equal(outcome.outputs.remediation, "inpr-fix");
      const st = { ...base, committed: ["investigate", "build", "review"], pr: 7, terminalReason: "needs-human", remediationKind: "inpr-fix" };
      assert.equal(pickPhase(st).id, "remediate");
    });

    it("forge#3521: REVIEW_RESULT next: remediate with no labels -> blocked with outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  remediation: inpr-fix\n  pr_number: 7"));
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
      assert.equal(outcome.handoff, true);
    });

    it("forge#3530: carries a valid remediation kind; unknown kind recorded as the sentinel, never raw text", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      for (const kind of ["ci-gate", "inpr-fix", "base-sync"]) {
        const o = await review.detectOutcome(reviewState, io, rr(`  status: NEXT\n  next: remediate\n  remediation: ${kind}\n  pr_number: 7`));
        assert.equal(o.outputs.remediation, kind);
      }
      const bad = await review.detectOutcome(reviewState, io, rr("  status: NEXT\n  next: remediate\n  remediation: $(evil)\n  pr_number: 7"));
      assert.equal(bad.status, "blocked");
      assert.equal(bad.outputs.remediation, "unknown");
    });

    it("forge#3521: non-digit pr_number is ignored; openPrFor number wins when they disagree", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      let outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  pr_number: 7; rm -rf /"));
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.outputs.pr, 7);
      outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: remediate\n  pr_number: 99"));
      assert.equal(outcome.outputs.pr, 7);
    });

    it("forge#3521: a non-remediate NEXT is not a handoff; no signal -> failed/non-retryable carrying outputs.pr", async () => {
      const io = ioFor({ ...openUnlabelled, issueLabels: [] });
      const outcome = await review.detectOutcome(reviewState, io,
        rr("  status: NEXT\n  next: close\n  pr_number: 7"));
      assert.equal(outcome.status, "failed");
      assert.equal(outcome.retryable, false);
      assert.equal(outcome.outputs.pr, 7);
      const noText = await review.detectOutcome(reviewState, io);
      assert.equal(noText.status, "failed");
    });

    it("forge#3521: only the last REVIEW_RESULT block counts; issue-read failure does not throw", async () => {
      const io = ioFor(openUnlabelled); // issue view throws
      const outcome = await review.detectOutcome(reviewState, io, {
        text: "REVIEW_RESULT:\n  status: NEXT\n  next: remediate\nlater\nREVIEW_RESULT:\n  status: BLOCKED\n  pr_number: 7\n",
      });
      assert.equal(outcome.status, "failed");
    });
  });

  describe("close.detectOutcome", () => {
    const close = PHASES.find(p => p.id === "close");
    const ioWith = (blob) => ({ gh: async () => blob, git: async () => "0" });

    // forge#2353: a bare CLOSED state (no workflow:merged label) is NOT proof
    // a PR actually merged — the divergence guard (forge#2352, bin/engine.mjs)
    // can route a closed-as-invalid or otherwise closed-not-merged issue into
    // this phase, and reporting "merged" for that case would inflate
    // run-log/telemetry merge-rate consumers with runs that never shipped a
    // PR. Only workflow:merged (set by the review phase's own merge flow) is
    // proof of an actual merge.
    it("issue CLOSED without workflow:merged label -> committed, terminalReason invalid (#2353)", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("issue CLOSED with workflow:invalid label (no workflow:merged) -> committed, terminalReason invalid (#2353)", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [{ name: "workflow:invalid" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "invalid");
    });

    it("workflow:merged label -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "OPEN", labels: [{ name: "workflow:merged" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    it("issue CLOSED AND workflow:merged label -> committed, terminalReason merged", async () => {
      const io = ioWith(JSON.stringify({ state: "CLOSED", labels: [{ name: "workflow:merged" }] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.terminalReason, "merged");
    });

    it("open + no label -> failed", async () => {
      const io = ioWith(JSON.stringify({ state: "OPEN", labels: [] }));
      const outcome = await close.detectOutcome(base, io);
      assert.equal(outcome.status, "failed");
    });
  });

  // forge#3499: context/architect are no longer engine phases — work-on/build owns
  // them. Their markers survive as NON-BLOCKING sub-evidence on build's outcome.
  describe("build.detectOutcome — context/architect sub-evidence is non-blocking (forge#3499)", () => {
    const build = PHASES.find(p => p.id === "build");
    const withComments = (...bodies) => ({
      gh: async () => JSON.stringify(bodies.map((b) => trusted(b))),
      git: async () => "2",
    });
    const builder = builderBody();

    it("context/architect are not engine phases", () => {
      assert.equal(PHASES.find(p => p.id === "context"), undefined);
      assert.equal(PHASES.find(p => p.id === "architect"), undefined);
    });

    it("records complete markers without requiring them", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:CONTEXT -->\n<!-- FORGE:CONTEXT:COMPLETE -->", "<!-- FORGE:ARCHITECT -->\n<!-- FORGE:ARCHITECT:COMPLETE -->", builder));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.context, "complete");
      assert.equal(o.outputs.architect, "complete");
    });

    it("bare/partial annotations are reported as absent, never as complete", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:CONTEXT -->", "<!-- FORGE:ARCHITECT:PARTIAL -->", builder));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.context, "absent");
      assert.equal(o.outputs.architect, "absent");
    });

    it("TRIVIAL fast-path band is recorded as skipped-trivial", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: TRIVIAL", builder));
      assert.equal(o.outputs.context, "skipped-trivial");
      assert.equal(o.outputs.architect, "skipped-trivial");
    });

    it("a malformed band (lowercase) is not treated as TRIVIAL", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" },
        withComments("<!-- FORGE:FAST_PATH -->\n**COMPLEXITY_BAND**: trivial", builder));
      assert.equal(o.outputs.context, "absent");
    });

    it("untrusted or quoted context/architect markers are reported absent", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" }, {
        gh: async () => JSON.stringify([
          trusted("<!-- FORGE:CONTEXT -->\n<!-- FORGE:CONTEXT:COMPLETE -->", { assoc: "NONE" }),
          trusted("quoting <!-- FORGE:ARCHITECT:COMPLETE --> inline"),
          trusted(builder)]),
        git: async () => "2" });
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.context, "absent");
      assert.equal(o.outputs.architect, "absent");
    });

    it("never fails build for a missing context/architect marker", async () => {
      const o = await build.detectOutcome({ ...base, branch: "fix/x-42" }, withComments(builder));
      assert.equal(o.status, "committed");
    });
  });

  describe("build - already-merged PR (forge#3535)", () => {
    const build = PHASES.find(p => p.id === "build");
    const builder = "<!-- FORGE:BUILDER -->\n<!-- FORGE:BUILDER:COMPLETE -->\n**Branch**: `fix/x-42`";
    const mk = ({ prs, ahead = "0", prThrows = false }) => ({
      gh: async (args) => {
        if (args[0] === "pr") { if (prThrows) throw new Error("gh down"); return JSON.stringify(prs); }
        return JSON.stringify([trusted(builder)]);
      },
      git: async () => ahead,
    });
    const st = { ...base, branch: null };
    const mergedInLane = { number: 77, state: "MERGED", mergedAt: "2026-10-10T06:39:07Z", baseRefName: "staging" };

    it("detectOutcome: PR merged into lane commits with branch and pr", async () => {
      const o = await build.detectOutcome(st, mk({ prs: [mergedInLane] }));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.pr, 77);
      assert.equal(o.outputs.branch, "fix/x-42");
    });

    it("reconcile: PR merged into lane is satisfied with pr", async () => {
      const r = await build.reconcile(st, mk({ prs: [mergedInLane] }));
      assert.equal(r.satisfied, true);
      assert.equal(r.outputs.pr, 77);
      assert.equal(r.outputs.branch, "fix/x-42");
    });

    it("PR merged into a different base than the lane does not count", async () => {
      const prs = [{ ...mergedInLane, baseRefName: "main" }];
      const o = await build.detectOutcome(st, mk({ prs }));
      assert.equal(o.status, "failed");
      assert.equal(o.retryable, false);
      assert.equal((await build.reconcile(st, mk({ prs }))).satisfied, false);
    });

    it("closed-unmerged PR or no PR keeps the non-retryable fixed point (merged base check)", async () => {
      for (const prs of [[], [{ number: 5, state: "CLOSED", mergedAt: null, baseRefName: "staging" }]]) {
        const o = await build.detectOutcome(st, mk({ prs }));
        assert.equal(o.status, "failed");
        assert.equal(o.retryable, false);
      }
    });

    it("gh failure on the PR lookup degrades to existing behaviour", async () => {
      const o = await build.detectOutcome(st, mk({ prs: [], prThrows: true }));
      assert.equal(o.status, "failed");
      assert.equal(o.retryable, false);
      assert.equal((await build.reconcile(st, mk({ prs: [], prThrows: true }))).satisfied, false);
    });

    it("picks the merged-into-lane PR among several", async () => {
      const prs = [{ number: 1, state: "CLOSED", mergedAt: null, baseRefName: "staging" }, mergedInLane];
      const o = await build.detectOutcome(st, mk({ prs }));
      assert.equal(o.outputs.pr, 77);
    });

    it("incomplete builder never consults the PR and stays retryable", async () => {
      let consulted = false;
      const io = { gh: async (a) => { if (a[0] === "pr") consulted = true; return JSON.stringify([]); }, git: async () => "0" };
      const o = await build.detectOutcome({ ...st, branch: "fix/x-42" }, io);
      assert.equal(o.status, "failed");
      assert.equal(o.retryable, undefined);
      assert.equal(consulted, false);
    });
  });

  // Regression tests for #2193: within-comment `**Branch**:` field match order is
  // first-match, by design (see phases.mjs parseBranchFromMarkers doc comment).
  // Comment-level last-match (#2184) is unaffected/untouched by these tests.
  // forge#3862: build.md B5.5 is a scope check, not a size gate; a FORGE:DIFF_SIZE record never routes anywhere.
  describe("build.detectOutcome — a finished build never routes to decompose (forge#3862)", () => {
    const build = PHASES.find(p => p.id === "build");
    const withComments = (...items) => ({ gh: async () => jsonLines(items.map((c) => (typeof c === "string" ? trusted(c) : c))), git: async () => "0" });
    const gate = (result, proposal = false) =>
      `<!-- FORGE:DIFF_SIZE -->\n## Diff Size and Scope\n\ndiff_lines: 1906\nreview_weight: 1500\nresult: ${result}\n` +
      (proposal ? "### Split Proposal\n- **A** — a.mjs\n" : "");
    const override = "<!-- FORGE:SIZE_OVERRIDE -->\nJustified: generated bulk.";
    const st = { ...base, committed: ["investigate"] };

    it("a legacy OVER + Split Proposal record no longer routes to decompose", async () => {
      const o = await build.detectOutcome(st, withComments("<!-- FORGE:INVESTIGATOR -->", gate("OVER", true)));
      assert.equal(o.status, "failed");
      assert.equal(o.terminalReason, undefined);
    });

    it("no DIFF_SIZE result (OK, EXTENDED_REVIEW, SCOPE_FLAGGED, OVERRIDDEN, legacy COHESIVE/OVER) routes anywhere", async () => {
      for (const r of ["OK", "EXTENDED_REVIEW", "SCOPE_FLAGGED", "OVERRIDDEN", "COHESIVE", "OVER"]) {
        const o = await build.detectOutcome(st, withComments(gate(r)));
        assert.equal(o.status, "failed", r);
        assert.equal(o.terminalReason, undefined, r);
        assert.notEqual(o.code, "build.size_over_gate", r);
      }
    });

    it("a size override does not change the outcome", async () => {
      const o = await build.detectOutcome(st, withComments(gate("OVER", true), override));
      assert.equal(o.terminalReason, undefined);
    });

    it("a newer OVER after a blocked acceptance gate stays fail-closed (no decompose)", async () => {
      const o = await build.detectOutcome(st, withComments("<!-- FORGE:BUILD_BLOCKED -->\n## Build Blocked\n\nreason", gate("OVER", true)));
      assert.equal(o.status, "failed");
      assert.equal(o.code, "build.acceptance_failed");
      assert.equal(o.terminalReason, undefined);
    });

    it("pickPhase after a committed build with no terminal reason never selects decompose", () => {
      const s = { ...base, committed: ["investigate", "build"], terminalReason: null };
      assert.notEqual(pickPhase(s)?.id, "decompose");
    });

    it("a comment fetch error never routes (propagates, no decompose)", async () => {
      const io = { gh: async () => { throw new Error("boom"); }, git: async () => "0" };
      await assert.rejects(() => build.detectOutcome(st, io), /boom/);
    });

    it("a posted FORGE:BUILDER:COMPLETE with commits wins over a stale OVER", async () => {
      const o = await build.detectOutcome({ ...st, branch: "fix/x-42" },
        { gh: async () => JSON.stringify([trusted(gate("OVER", true)), trusted("<!-- FORGE:BUILDER -->\n<!-- FORGE:BUILDER:COMPLETE -->")]), git: async () => "2" });
      assert.equal(o.status, "committed");
      assert.equal(o.terminalReason, undefined);
    });
  });

  describe("decompositionRevoked (forge#3862, forge#3932)", () => {
    const revoked = "<!-- FORGE:DECOMPOSED:REVOKED -->\nOperator revoked the decomposition.";
    const decomposed = "<!-- FORGE:DECOMPOSED -->\nspawned";
    const complete = "<!-- FORGE:DECOMPOSED -->\n<!-- FORGE:DECOMPOSED:COMPLETE -->";
    const ovr = "<!-- FORGE:SIZE_OVERRIDE -->\nJustified: one cohesive change.";
    const stranger = (b) => trusted(b, { assoc: "NONE", type: "User", login: "drive-by" });
    const run = (...items) => decompositionRevoked(42, { gh: async () => jsonLines(items.map((c) => (typeof c === "string" ? trusted(c) : c))), git: async () => "0" });

    it("a revocation newer than FORGE:DECOMPOSED suffices, with or without a size override", async () => {
      assert.equal(await run(decomposed, complete, revoked), true);
      assert.equal(await run(decomposed, complete, revoked, ovr), true);
      assert.equal(await run(ovr, decomposed, revoked), true);
      assert.equal(await run(revoked), true);
    });
    it("no revocation, an override alone, or a newer re-decomposition -> false", async () => {
      assert.equal(await run(decomposed, complete), false);
      assert.equal(await run(decomposed, complete, ovr), false);
      assert.equal(await run(decomposed, revoked, complete), false);
      assert.equal(await run(decomposed, revoked, complete, ovr), false);
    });
    it("an untrusted revocation never counts", async () => {
      assert.equal(await run(decomposed, stranger(revoked)), false);
      assert.equal(await run(decomposed, stranger(revoked), ovr), false);
    });
    it("an unreadable comment trail fails closed", async () => {
      assert.equal(await decompositionRevoked(42, { gh: async () => { throw new Error("boom"); }, git: async () => "0" }), false);
    });
  });

  describe("openDependency (forge#3932)", () => {
    const rec = (over = {}) => JSON.stringify({ body: "x", state: "open", author_association: "OWNER", user: { type: "User", login: "op" }, ...over });
    const io = (records, calls = []) => ({ git: async () => "0", gh: async (args) => {
      calls.push(args.join(" "));
      const m = /issues\/(\d+)$/.exec(args[args.length - 1]);
      const r = records[m?.[1]];
      if (r instanceof Error) throw r;
      return r ?? "";
    } });
    const dep = "Body.\n\n**Depends on**: #7 — needs the schema first\n";

    it("a trusted exact **Depends on** line whose dependency is OPEN is reported", async () => {
      assert.deepEqual(await openDependency(42, io({ 42: rec({ body: dep }), 7: rec({ state: "open" }) })), { open: [7] });
    });
    it("a closed dependency, no declaration or an empty read blocks nothing", async () => {
      assert.equal(await openDependency(42, io({ 42: rec({ body: dep }), 7: rec({ state: "closed" }) })), null);
      assert.equal(await openDependency(42, io({ 42: rec({ body: "nothing" }) })), null);
      assert.equal(await openDependency(42, io({})), null);
    });
    it("a Bot-authored body is trusted; an untrusted author's claim is ignored (no dependency read)", async () => {
      assert.deepEqual(await openDependency(42, io({ 42: rec({ body: dep, author_association: "NONE", user: { type: "Bot", login: "forge[bot]" } }), 7: rec() })), { open: [7] });
      const calls = [];
      assert.equal(await openDependency(42, io({ 42: rec({ body: dep, author_association: "NONE" }), 7: rec() }, calls)), null);
      assert.equal(calls.length, 1);
    });
    it("loose prose, a mid-line mention and a self-reference are ignored", async () => {
      for (const body of ["depends on #7", "This is blocked by #7, after #7", "see **Depends on**: #7 here", "**Depends on**: #42"])
        assert.equal(await openDependency(42, io({ 42: rec({ body }), 7: rec(), })), null, body);
    });
    it("several dependencies report only the open ones", async () => {
      const body = "**Depends on**: #7\n**Depends on**: #8 — why\n";
      assert.deepEqual(await openDependency(42, io({ 42: rec({ body }), 7: rec({ state: "closed" }), 8: rec() })), { open: [8] });
    });
    it("unreadable issue, unreadable dependency or unparsable output fails closed", async () => {
      assert.equal((await openDependency(42, io({ 42: new Error("boom") }))).unreadable, true);
      assert.equal((await openDependency(42, io({ 42: rec({ body: dep }), 7: new Error("boom") }))).unreadable, true);
      assert.equal((await openDependency(42, io({ 42: rec({ body: dep }), 7: "" }))).unreadable, true);
      assert.equal((await openDependency(42, io({ 42: "not json" }))).unreadable, true);
    });
  });

  describe("build — within-comment **Branch** field match order (#2193)", () => {
    const build = PHASES.find(p => p.id === "build");

    it("uses the FIRST **Branch** field when a single eligible comment contains two", async () => {
      // Synthetic: no real pipeline path produces this today, but the function's
      // documented behavior must stay pinned to first-match for such an input.
      const body = "<!-- FORGE:BUILDER -->\n**Branch**: `fix/first-branch` some notes " +
        "**Branch**: `fix/second-branch`\n<!-- FORGE:BUILDER:COMPLETE -->";
      const io = {
        gh: async () => JSON.stringify([trusted(body)]),
        git: async () => "3",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.branch, "fix/first-branch");
    });

    it("comment-level last-match (#2184) still wins over field-level ordering", async () => {
      // Two eligible comments; the LAST comment's (only) field must be used,
      // even though its **Branch** value differs from the earlier comment's.
      const older = builderBody("fix/old-attempt");
      const newer = builderBody("fix/retry-attempt");
      const io = {
        gh: async () => JSON.stringify([trusted(older), trusted(newer)]),
        git: async () => "1",
      };
      const outcome = await build.detectOutcome({ ...base, branch: null }, io);
      assert.equal(outcome.status, "committed");
      assert.equal(outcome.outputs.branch, "fix/retry-attempt");
    });
  });

  // forge#3542 (supersedes #2194's accepted substring behaviour): FORGE:BUILDER:COMPLETE is only
  // eligible as a full-line sentinel in a TRUSTED comment that starts with the BUILDER header.
  describe("build — FORGE:BUILDER:COMPLETE anchored + trusted eligibility (#3542)", () => {
    const build = PHASES.find(p => p.id === "build");
    const run = async (...cs) => build.detectOutcome({ ...base, branch: null },
      { gh: async () => JSON.stringify(cs), git: async () => "2" });

    it("a comment merely mentioning the marker text inline is NOT eligible", async () => {
      const body = "**Branch**: `fix/plain-mention` this text contains FORGE:BUILDER:COMPLETE inline";
      assert.equal((await run(trusted(body))).status, "failed");
    });

    it("a full-line sentinel in a comment that does not lead with the BUILDER header is NOT eligible", async () => {
      const body = "Quoting the builder:\n**Branch**: `fix/quoted`\n<!-- FORGE:BUILDER:COMPLETE -->";
      assert.equal((await run(trusted(body))).status, "failed");
    });

    it("untrusted author's complete builder comment is NOT eligible", async () => {
      const forged = trusted(builderBody("fix/forged"), { assoc: "NONE", login: "drive-by" });
      assert.equal((await run(forged)).status, "failed");
    });

    it("a forged untrusted BUILDER:COMPLETE does not satisfy build (detectOutcome or reconcile)", async () => {
      const forged = trusted(builderBody("fix/forged"), { assoc: "NONE", login: "drive-by" });
      const io = { gh: async () => JSON.stringify([forged]), git: async () => "2" };
      assert.equal((await build.detectOutcome({ ...base, branch: null }, io)).status, "failed");
      assert.equal((await build.reconcile({ ...base, branch: null }, io)).satisfied, false);
    });

    it("a Bot-authored builder comment is eligible; sentinel need not be the last line", async () => {
      const body = builderBody("fix/bot-branch") + "\n\n<sub>trailing footer</sub>";
      const o = await run(trusted(body, { assoc: "NONE", type: "Bot", login: "forgedock[bot]" }));
      assert.equal(o.status, "committed");
      assert.equal(o.outputs.branch, "fix/bot-branch");
    });

    it("a comment without the marker text anywhere is never eligible", async () => {
      const body = "<!-- FORGE:BUILDER -->\n**Branch**: `fix/no-marker-here` build in progress, not done yet";
      assert.equal((await run(trusted(body))).status, "failed");
    });
  });

  // forge#3506: close must never derive `merged` from a non-merged handoff reason.
  describe("close.buildArgs fail-closed", () => {
    const close = PHASES.find(p => p.id === "close");
    const st = (terminalReason) => ({ ...base, committed: ["review"], pr: 7, terminalReason });
    const io = { gh: async () => "", git: async () => "" };
    const ctx = { repo: "acme/widgets" };
    for (const reason of ["needs-human", "awaiting-merge", "engine-error"]) {
      it(`${reason} throws instead of defaulting to merged`, async () => {
        await assert.rejects(() => close.buildArgs(st(reason), ctx, io), /refusing close/);
      });
    }
    for (const [reason, expected] of [[null, "merged"], ["merged", "merged"], ["decomposed", "decomposed"], ["invalid", "invalid"]]) {
      it(`${reason} still maps to ${expected}`, async () => {
        const args = await close.buildArgs(st(reason), ctx, io);
        assert.equal(args[args.indexOf("--terminal-state") + 1], expected);
      });
    }
  });
});

// forge#3657: cycle-scoped builder evidence.
describe("FORGE:CYCLE boundary", () => {
  const build = PHASES.find((p) => p.id === "build");
  const st = { ...base, committed: ["investigate"], branch: null };
  const world = (bodies, { ahead = "2", prs = [] } = {}) => ({
    gh: async (args) => (args[0] === "pr" ? JSON.stringify(prs) : jsonLines(bodies.map((b) => trusted(b)))),
    git: async () => ahead,
  });

  it("sliceToCurrentCycle: no marker returns all; marker mid-list returns the tail", () => {
    assert.deepEqual(sliceToCurrentCycle(["a", "b"]), ["a", "b"]);
    assert.deepEqual(sliceToCurrentCycle(["a", cycleMarker(1), "b", "c"]), ["b", "c"]);
    assert.deepEqual(sliceToCurrentCycle(["a", cycleMarker(1), "b", cycleMarker(2), "c"]), ["c"]);
  });

  it("a marker quoted in prose does not move the boundary", () => {
    const quoted = `see ${cycleMarker(1)} above`;
    assert.deepEqual(sliceToCurrentCycle(["a", quoted, "b"]), ["a", quoted, "b"]);
  });

  it("build.reconcile and detectOutcome ignore a pre-marker BUILDER:COMPLETE", async () => {
    const io = world([builderBody("fix/old-42"), cycleMarker(1)]);
    assert.equal((await build.reconcile(st, io)).satisfied, false);
    assert.notEqual((await build.detectOutcome(st, io)).status, "committed");
  });

  it("build.reconcile still adopts a post-marker BUILDER:COMPLETE", async () => {
    const io = world([builderBody("fix/old-42"), cycleMarker(1), builderBody("fix/new-42")]);
    const r = await build.reconcile(st, io);
    assert.equal(r.satisfied, true);
    assert.equal(r.outputs.branch, "fix/new-42");
  });

  it("an untrusted forged marker does not move the boundary", async () => {
    const io = { gh: async () => jsonLines([trusted(builderBody("fix/old-42")),
      trusted(cycleMarker(1), { assoc: "NONE", login: "rando" })]), git: async () => "2" };
    assert.equal((await build.reconcile(st, io)).satisfied, true);
  });

  it("postCycleMarker posts once and is idempotent when the marker n already exists", async () => {
    const posted = [];
    const bodies = [builderBody("fix/old-42")];
    const io = { gh: async (args) => {
      if (args[0] === "issue") { posted.push(args[args.indexOf("--body") + 1]); bodies.push(posted.at(-1)); return ""; }
      return jsonLines(bodies.map((b) => trusted(b)));
    } };
    assert.equal((await postCycleMarker(42, 1, io)).posted, true);
    assert.equal((await postCycleMarker(42, 1, io)).posted, false);
    assert.deepEqual(posted, [cycleMarker(1)]);
    assert.equal((await postCycleMarker(42, 2, io)).posted, true);
  });
  it("nextCycleNumber exceeds an existing trusted marker even when the local log has no RUN_NEXT_CYCLE", async () => {
    const io = { gh: async () => jsonLines([trusted(builderBody("fix/old-42")), trusted(cycleMarker(1)),
      trusted(cycleMarker(2), { assoc: "NONE", login: "rando" })]) };
    assert.equal(await nextCycleNumber(42, 0, io), 2);
    assert.equal(await nextCycleNumber(42, 3, io), 4);
    assert.equal(await nextCycleNumber(42, 0, { gh: async () => jsonLines([]) }), 1);
  });
});

// forge#3545: engine outcomes must honour the phase's own declared result.
describe("acceptance-gate-aware build outcome (forge#3545)", () => {
  const build = PHASES.find((p) => p.id === "build");
  const st = { ...base, committed: ["investigate"], branch: null };
  const world = (bodies, { ahead = "2" } = {}) => ({
    gh: async (args) => (args[0] === "pr" ? "[]" : jsonLines(bodies.map((b) => trusted(b)))),
    git: async () => ahead,
  });
  const gate = (kind) => `<!-- FORGE:ACCEPTANCE_GATE -->\n## Acceptance Gate\n\n<!-- FORGE:ACCEPTANCE_GATE:${kind} -->`;
  const blocked = "<!-- FORGE:BUILD_BLOCKED -->\n## Build Blocked\n\nreason";
  const done = builderBody("fix/x-42");

  it("COMPLETE + commits ahead + newer FAILED gate -> failed, retryable:false", async () => {
    const o = await build.detectOutcome(st, world([done, gate("FAILED")]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("COMPLETE + newer BLOCKED gate -> failed, retryable:false", async () => {
    const o = await build.detectOutcome(st, world([done, gate("BLOCKED")]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("COMPLETE + newer FORGE:BUILD_BLOCKED -> failed, retryable:false", async () => {
    const o = await build.detectOutcome(st, world([done, blocked]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("FAILED then a newer PASSED -> committed again", async () => {
    const o = await build.detectOutcome(st, world([done, gate("FAILED"), gate("PASSED")]));
    assert.equal(o.status, "committed");
    assert.equal(o.outputs.branch, "fix/x-42");
  });

  it("PASSED then a newer FAILED -> failed (order decides, not presence)", async () => {
    const o = await build.detectOutcome(st, world([done, gate("PASSED"), gate("FAILED")]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("a newer FORGE:ACCEPTANCE_GATE_REVIEW comment never changes the build gate state (forge#3793)", async () => {
    const rev = (kind) => `<!-- FORGE:ACCEPTANCE_GATE_REVIEW -->\n## Review Acceptance Gate\n\n<!-- FORGE:ACCEPTANCE_GATE_REVIEW:${kind} -->`;
    assert.equal((await build.detectOutcome(st, world([done, gate("PASSED"), rev("FAILED")]))).status, "committed");
    assert.equal((await build.detectOutcome(st, world([done, gate("FAILED"), rev("PASSED")]))).status, "failed");
  });

  it("no gate marker keeps prior behaviour (committed)", async () => {
    assert.equal((await build.detectOutcome(st, world([done]))).status, "committed");
  });

  it("PASSED then a newer BUILD_BLOCKED -> failed", async () => {
    const o = await build.detectOutcome(st, world([done, gate("PASSED"), blocked]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("PASSED, BUILD_BLOCKED, then a re-run PASSED -> committed (forge#3725)", async () => {
    const o = await build.detectOutcome(st, world([done, gate("PASSED"), blocked, gate("PASSED")]));
    assert.equal(o.status, "committed");
  });

  it("FAILED, re-run FAILED again -> still failed", async () => {
    const o = await build.detectOutcome(st, world([done, gate("FAILED"), gate("FAILED")]));
    assert.equal(o.status, "failed");
  });

  it("a gate marker quoted in prose, or from an untrusted author, does not block", async () => {
    const quoted = `see <!-- FORGE:ACCEPTANCE_GATE:FAILED --> in the thread`;
    assert.equal((await build.detectOutcome(st, world([done, quoted]))).status, "committed");
    const io = { gh: async () => jsonLines([trusted(done), trusted(gate("FAILED"), { assoc: "NONE", login: "rando" })]), git: async () => "2" };
    assert.equal((await build.detectOutcome(st, io)).status, "committed");
  });

  it("no-marker crash stays retryable", async () => {
    const o = await build.detectOutcome(st, world([]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, undefined);
  });

  it("reconcile is unsatisfied while the gate is blocked, satisfied once PASSED", async () => {
    assert.equal((await build.reconcile(st, world([done, gate("FAILED")]))).satisfied, false);
    assert.equal((await build.reconcile(st, world([done, gate("FAILED"), gate("PASSED")]))).satisfied, true);
    assert.equal((await build.reconcile(st, world([done]))).satisfied, true);
  });

  it("a pre-cycle FAILED gate does not block the new cycle", async () => {
    const o = await build.detectOutcome(st, world([gate("FAILED"), cycleMarker(1), done]));
    assert.equal(o.status, "committed");
  });
});

describe("close PHASE_COMPLETE outcome (forge#3545)", () => {
  const close = PHASES.find((p) => p.id === "close");
  const phaseComplete = "<!-- FORGE:PHASE:COMPLETE -->\nPhase complete. PR #9 merged to `staging`. 1 phase item(s) remain.";
  const world = (snap, bodies = []) => ({
    gh: async (args) => (args[0] === "issue" ? JSON.stringify(snap) : jsonLines(bodies.map((b) => trusted(b)))),
    git: async () => "0",
  });
  const open = { state: "OPEN", labels: [{ name: "workflow:investigating" }] };

  it("OPEN + FORGE:PHASE:COMPLETE -> committed phase-complete, first attempt", async () => {
    const o = await close.detectOutcome(base, world(open, [phaseComplete]));
    assert.equal(o.status, "committed");
    assert.equal(o.terminalReason, "phase-complete");
    assert.equal(o.retryable, undefined);
  });

  it("reconcile is satisfied with phase-complete; no marker is not", async () => {
    const r = await close.reconcile(base, world(open, [phaseComplete]));
    assert.equal(r.satisfied, true);
    assert.equal(r.terminalReason, "phase-complete");
    assert.equal((await close.reconcile(base, world(open, []))).satisfied, false);
  });

  it("OPEN with no marker still fails (real crash unchanged)", async () => {
    const o = await close.detectOutcome(base, world(open, []));
    assert.equal(o.status, "failed");
    assert.equal(o.detail, "issue not closed");
  });

  it("a prior-cycle, quoted or untrusted PHASE:COMPLETE does not count", async () => {
    assert.equal((await close.detectOutcome(base, world(open, [phaseComplete, cycleMarker(1)]))).status, "failed");
    assert.equal((await close.detectOutcome(base, world(open, [`quoting <!-- FORGE:PHASE:COMPLETE --> here`]))).status, "failed");
    const io = { gh: async (a) => (a[0] === "issue" ? JSON.stringify(open) : jsonLines([trusted(phaseComplete, { assoc: "NONE", login: "rando" })])), git: async () => "0" };
    assert.equal((await close.detectOutcome(base, io)).status, "failed");
  });

  it("merged label and CLOSED paths still win over the marker", async () => {
    const merged = await close.detectOutcome(base, world({ state: "OPEN", labels: [{ name: "workflow:merged" }] }, [phaseComplete]));
    assert.equal(merged.terminalReason, "merged");
    const closed = await close.detectOutcome(base, world({ state: "CLOSED", labels: [{ name: "workflow:merged" }] }, [phaseComplete]));
    assert.equal(closed.terminalReason, "merged");
  });
});

describe("build investigation exit (forge#3534)", () => {
  const build = PHASES.find((p) => p.id === "build");
  const review = PHASES.find((p) => p.id === "review");
  const close = PHASES.find((p) => p.id === "close");
  const st = { ...base, committed: ["investigate"], branch: null };
  const world = (bodies, { ahead = "0" } = {}) => ({
    gh: async (args) => (args[0] === "pr" ? "[]" : jsonLines(bodies.map((b) => trusted(b)))),
    git: async () => ahead,
  });
  const marker = `<!-- ${PHASE_MARKERS.build.investigationMarker} -->\n## Investigation Deliverables\n\n- #11\n- #12`;
  const partialBuilder = "<!-- FORGE:BUILDER -->\n## Implementation Complete\n\n**Branch**: `fix/x-42`";

  it("marker present (no code, no COMPLETE) -> committed first attempt, terminalReason investigation", async () => {
    const o = await build.detectOutcome(st, world([marker]));
    assert.equal(o.status, "committed");
    assert.equal(o.terminalReason, "investigation");
    assert.equal(o.retryable, undefined);
  });

  it("real crash (no COMPLETE, no marker) still fails and stays retryable", async () => {
    const o = await build.detectOutcome(st, world([partialBuilder]));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, undefined);
  });

  it("COMPLETE with ahead=0 and no marker keeps the non-retryable fixed point (forge#2176)", async () => {
    const o = await build.detectOutcome(st, world([builderBody("fix/x-42")], { ahead: "0" }));
    assert.equal(o.status, "failed");
    assert.equal(o.retryable, false);
  });

  it("COMPLETE + commits ahead + marker takes the normal code path (no investigation reason)", async () => {
    const o = await build.detectOutcome(st, world([builderBody("fix/x-42"), marker], { ahead: "2" }));
    assert.equal(o.status, "committed");
    assert.equal(o.terminalReason, undefined);
  });

  it("marker quoted inside another comment, or from an untrusted author, does not count", async () => {
    const quoted = `<!-- FORGE:INVESTIGATOR -->\nquoting\n> <!-- ${PHASE_MARKERS.build.investigationMarker} -->`;
    assert.equal((await build.detectOutcome(st, world([quoted]))).status, "failed");
    const untrusted = trusted(marker, { assoc: "NONE", type: "User", login: "drive-by" });
    const io = { gh: async (a) => (a[0] === "pr" ? "[]" : jsonLines([untrusted])), git: async () => "0" };
    assert.equal((await build.detectOutcome(st, io)).status, "failed");
  });

  it("reconcile is satisfied with investigation reason when the marker exists", async () => {
    const r = await build.reconcile(st, world([marker]));
    assert.equal(r.satisfied, true);
    assert.equal(r.terminalReason, "investigation");
    assert.equal((await build.reconcile(st, world([partialBuilder]))).satisfied, false);
  });

  it("pickPhase skips review and picks close after an investigation build", () => {
    const s = { ...base, committed: ["investigate", "build"], terminalReason: "investigation" };
    assert.equal(review.entryCondition(s), false);
    assert.equal(pickPhase(s).id, "close");
    // normal build still goes to review
    assert.equal(pickPhase({ ...s, terminalReason: null }).id, "review");
  });

  it("close.detectOutcome on a CLOSED investigation issue requires the trajectory (without trajectory fails)", async () => {
    const snap = JSON.stringify({ state: "CLOSED", labels: [] });
    const io = (bodies) => ({ gh: async (a) => (a[0] === "issue" ? snap : jsonLines(bodies.map((b) => trusted(b)))), git: async () => "0" });
    const s = { ...base, terminalReason: "investigation" };
    const ok = await close.detectOutcome(s, io(["<!-- FORGE:TRAJECTORY -->\nrow"]));
    assert.equal(ok.status, "committed");
    assert.equal(ok.terminalReason, "investigation");
    const none = await close.detectOutcome(s, io([marker]));
    assert.equal(none.status, "failed");
    assert.match(none.detail, /no FORGE:TRAJECTORY/);
    const throwing = { gh: async (a) => { if (a[0] === "issue") return snap; throw new Error("gh down"); }, git: async () => "0" };
    assert.equal((await close.detectOutcome(s, throwing)).status, "failed");
    // non-investigation CLOSED is unchanged
    assert.equal((await close.detectOutcome(base, io([]))).terminalReason, "invalid");
  });

  it("close.reconcile on a CLOSED investigation issue needs the trajectory before it is satisfied", async () => {
    const snap = JSON.stringify({ state: "CLOSED", labels: [] });
    const io = (bodies) => ({ gh: async (a) => (a[0] === "issue" ? snap : jsonLines(bodies.map((b) => trusted(b)))), git: async () => "0" });
    const s = { ...base, terminalReason: "investigation" };
    assert.equal((await close.reconcile(s, io([marker]))).satisfied, false);
    assert.equal((await close.reconcile(s, io(["<!-- FORGE:TRAJECTORY -->\nrow"]))).satisfied, true);
  });

  it("forge#3772 CLOSED investigation accepts a trusted current-cycle PHASE:COMPLETE as close evidence", async () => {
    const snap = JSON.stringify({ state: "CLOSED", labels: [] });
    const io = (bodies) => ({ gh: async (a) => (a[0] === "issue" ? snap : jsonLines(bodies.map((b) => trusted(b)))), git: async () => "0" });
    const s = { ...base, terminalReason: "investigation" };
    const pc = "<!-- FORGE:PHASE:COMPLETE -->\nPhase complete. 1 phase item(s) remain.";
    const o = await close.detectOutcome(s, io([marker, pc]));
    assert.equal(o.status, "committed");
    assert.equal(o.terminalReason, "investigation");
    assert.equal((await close.reconcile(s, io([marker, pc]))).satisfied, true);
    // neither marker -> still failed
    assert.equal((await close.detectOutcome(s, io([marker]))).status, "failed");
    // quoted / untrusted PHASE:COMPLETE does not count
    const quoted = "quoting <!-- FORGE:PHASE:COMPLETE --> here";
    assert.equal((await close.detectOutcome(s, io([marker, quoted]))).status, "failed");
    const untrusted = { gh: async (a) => (a[0] === "issue" ? snap : jsonLines([{ body: pc, user: { login: "rando" }, author_association: "NONE" }])), git: async () => "0" };
    assert.equal((await close.detectOutcome(s, untrusted)).status, "failed");
  });

  it("investigation is not a TERMINAL_REASON (run must reach close)", async () => {
    const { TERMINAL_REASONS } = await import("../engine/phases.mjs");
    assert.ok(!TERMINAL_REASONS.includes("investigation"));
  });
});

// forge#3931: blocking-ISSUE review handoff and head-aware remediation staleness.
describe("forge#3931 review blocking-ISSUE disposition and remediation head staleness", () => {
  const review = PHASES.find((p) => p.id === "review");
  const remediate = PHASES.find((p) => p.id === "remediate");
  const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
  const disposition = (sha, filed) =>
    `<!-- FORGE:NOTE_DISPOSITION: notes_fixed=0 notes_listed=0 findings_filed=${filed} reviewed_sha=${sha} -->\n- 1 f.js:1 [HIGH] x: filed`;
  // PR 7 is open at HEAD_A; `prComments` are the comments on the PR (read through the issue-comments API).
  const mkIo = ({ prComments, readFails = false }) => ({
    gh: async (args) => {
      const cmd = args.join(" ");
      if (cmd.startsWith("pr list")) return JSON.stringify([{ number: 7 }]);
      if (cmd.startsWith("pr view")) return JSON.stringify({ number: 7, state: "OPEN", mergedAt: null, labels: [], headRefOid: HEAD_A });
      if (cmd.startsWith("issue view")) return JSON.stringify({ state: "OPEN", labels: [] });
      if (cmd.includes("/issues/7/comments")) { if (readFails) throw new Error("gh down"); return jsonLines(prComments); }
      throw new Error(`unexpected gh call: ${cmd}`);
    },
    git: async () => "0",
  });
  const st = { ...base, branch: "fix/x-42" };

  it("trusted disposition with filed ISSUE at the unchanged head -> coded remediate handoff", async () => {
    const o = await review.detectOutcome(st, mkIo({ prComments: [trusted(disposition(HEAD_A, 2))] }));
    assert.equal(o.status, "blocked");
    assert.equal(o.handoff, true);
    assert.equal(o.code, "review.blocking_issue");
    assert.equal(o.outputs.pr, 7);
  });

  it("disposition for an older head, zero filed, untrusted author, or unreadable PR -> coded pr_open, never uncoded", async () => {
    const cases = [
      mkIo({ prComments: [trusted(disposition(HEAD_B, 2))] }),
      mkIo({ prComments: [trusted(disposition(HEAD_A, 0))] }),
      mkIo({ prComments: [trusted(disposition(HEAD_A, 2), { assoc: "NONE" })] }),
      mkIo({ prComments: [], readFails: true }),
    ];
    for (const io of cases) {
      const o = await review.detectOutcome(st, io);
      assert.equal(o.status, "failed");
      assert.notEqual(o.handoff, true);
      assert.equal(o.code, "review.pr_open");
    }
  });

  it("an explicit REVIEW_RESULT status keeps the failed result but now carries a code", async () => {
    const o = await review.detectOutcome(st, mkIo({ prComments: [] }), { text: "REVIEW_RESULT:\n  status: BLOCKED\n  blocker: x\n" });
    assert.equal(o.status, "failed");
    assert.equal(o.code, "review.pr_open");
  });

  const remBody = (outcome, head) =>
    `<!-- FORGE:REMEDIATION -->\n**Re-gate outcome**: ${outcome}\n**Head**: ${head}\n<!-- FORGE:REMEDIATION:COMPLETE -->`;
  const remIo = ({ comments, head = HEAD_B, prFails = false }) => ({
    gh: async (args) => {
      const cmd = args.join(" ");
      if (cmd.includes("/comments")) return jsonLines(comments);
      if (cmd.startsWith("pr view")) { if (prFails) throw new Error("gh down"); return JSON.stringify({ state: "OPEN", mergedAt: null, headRefOid: head }); }
      throw new Error(`unexpected gh call: ${cmd}`);
    },
    git: async () => "0",
  });
  const withPr = { ...base, pr: 7 };

  it("RE-ESCALATED trail recorded for an older head is not replayed", async () => {
    const o = await remediate.detectOutcome(withPr, remIo({ comments: [trusted(remBody("RE-ESCALATED", HEAD_A))] }));
    assert.equal(o.status, "failed");
    assert.equal(o.code, "remediate.no_marker");
  });

  it("RE-ESCALATED trail at the live head, unknown head, or unreadable PR keeps today's outcome (fail closed)", async () => {
    for (const io of [
      remIo({ comments: [trusted(remBody("RE-ESCALATED", HEAD_B))] }),
      remIo({ comments: [trusted(remBody("RE-ESCALATED", "unknown"))] }),
      remIo({ comments: [trusted(remBody("RE-ESCALATED", HEAD_A))], prFails: true }),
    ]) {
      const o = await remediate.detectOutcome(withPr, io);
      assert.equal(o.status, "committed");
      assert.equal(o.code, "remediate.re_escalated");
    }
  });

  it("an untrusted trail cannot mark the head stale", async () => {
    const { remediationHeadStale } = await import("../engine/phases.mjs");
    assert.equal(await remediationHeadStale(withPr, remIo({ comments: [trusted(remBody("RE-ESCALATED", HEAD_A), { assoc: "NONE" })] })), false);
    assert.equal(await remediationHeadStale(withPr, remIo({ comments: [trusted(remBody("RE-ESCALATED", HEAD_A))] })), true);
  });
});
