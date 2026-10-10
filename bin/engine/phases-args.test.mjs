// Contract test (forge#3499): the arguments each engine phase passes to its
// work-on sub-skill must satisfy that spec's `argument-hint`. Fails CI when a
// phase's `buildArgs` and `commands/<command>.md` drift apart — the failure
// mode that parked every orchestrate run at architect.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PHASES, PhaseArgsError } from "./phases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function argumentHint(command) {
  const file = path.join(ROOT, "commands", `${command}.md`);
  assert.ok(existsSync(file), `engine phase command has no spec: ${file}`);
  const m = readFileSync(file, "utf-8").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${command}.md has no frontmatter`);
  const h = m[1].match(/^argument-hint:\s*(.*)$/m);
  assert.ok(h, `${command}.md has no argument-hint`);
  let v = h[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.replace(/\\"/g, '"');
}

/** Required = flags/positional outside [...] groups; optional = inside. */
function parseHint(hint) {
  const required = hint.replace(/\[[^\]]*\]/g, " ");
  const flagsIn = (t) => [...t.matchAll(/(--[a-z][a-z-]*)/g)].map((x) => x[1]);
  return {
    requiredFlags: flagsIn(required),
    allFlags: flagsIn(hint),
    requiredPositional: /^\s*\{[A-Z_]+\}/.test(required),
  };
}

const state = { v: 0, run: "r", issue: 3499, lane: "staging", committed: ["investigate", "build", "review"],
  phase: null, branch: "fix/example-3499", pr: 77, terminal: false, terminalReason: null, lease: null };
const ctx = { repo: "acme/widgets" };
const io = {
  git: async () =>
    "worktree /repo/.claude/worktrees/fix-example-3499\nHEAD 1111111\nbranch refs/heads/fix/example-3499\n",
};

describe("engine phase args satisfy each target spec's argument-hint (forge#3499)", () => {
  it("context/architect are not engine phases (work-on/build owns them)", () => {
    const ids = PHASES.map((p) => p.id);
    assert.ok(!ids.includes("context") && !ids.includes("architect"), ids.join(","));
  });

  for (const phase of PHASES) {
    it(`${phase.id} (${phase.command})`, async () => {
      assert.equal(typeof phase.buildArgs, "function", `${phase.id} must define buildArgs`);
      const hint = parseHint(argumentHint(phase.command));
      const args = await phase.buildArgs({ ...state, terminalReason: phase.id === "remediate" ? "needs-human" : null }, ctx, io);

      assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"), "args must be an array of strings");
      assert.ok(args.length > 1, `${phase.id} must not be invoked with only a positional`);
      for (const a of args) assert.ok(!/[\n\r\t]/.test(a), `control char in arg ${JSON.stringify(a)}`);

      // positional: issue number (or PR number for remediate) comes first
      const expectedPositional = phase.id === "remediate" ? String(state.pr) : String(state.issue);
      assert.equal(args[0], expectedPositional);
      if (hint.requiredPositional) assert.match(args[0], /^[0-9]+$/);

      const emitted = args.filter((a) => a.startsWith("--"));
      for (const flag of hint.requiredFlags) {
        const i = args.indexOf(flag);
        assert.ok(i >= 0, `${phase.id}: required ${flag} missing from [${args.join(" ")}]`);
        assert.ok(args[i + 1] !== undefined && args[i + 1] !== "" && !args[i + 1].startsWith("--"),
          `${phase.id}: ${flag} has no value`);
      }
      for (const flag of emitted) {
        assert.ok(hint.allFlags.includes(flag), `${phase.id}: emits ${flag}, which ${phase.command}.md does not declare`);
      }
    });
  }

  it("--gh-flag is a single quoted token, as in the specs' argument-hint", async () => {
    const args = await PHASES.find((p) => p.id === "investigate").buildArgs(state, ctx, io);
    assert.equal(args[args.indexOf("--gh-flag") + 1], '"-R acme/widgets"');
  });

  it("fails closed (PhaseArgsError) on a missing or injectable repo/branch/worktree rather than sending a partial arg set", async () => {
    const inv = PHASES.find((p) => p.id === "investigate");
    const review = PHASES.find((p) => p.id === "review");
    for (const repo of [null, "", "no-slash", "a/b --base main", 'a/b"c', "a/b\nc"]) {
      await assert.rejects(() => inv.buildArgs(state, { repo }, io), PhaseArgsError, `repo=${JSON.stringify(repo)}`);
    }
    await assert.rejects(() => review.buildArgs({ ...state, branch: "x y" }, ctx, io), PhaseArgsError);
    await assert.rejects(() => review.buildArgs({ ...state, branch: null }, ctx, io), PhaseArgsError);
    await assert.rejects(() => review.buildArgs(state, ctx, { git: async () => "worktree /repo\nbranch refs/heads/main\n" }), PhaseArgsError);
    await assert.rejects(() => review.buildArgs(state, ctx, { git: async () => { throw new Error("git down"); } }), PhaseArgsError);
    await assert.rejects(() => PHASES.find((p) => p.id === "remediate").buildArgs({ ...state, pr: null }, ctx, io), PhaseArgsError);
  });

  it("close derives --terminal-state from the run's terminal reason", async () => {
    const close = PHASES.find((p) => p.id === "close");
    for (const [reason, expected] of [[null, "merged"], ["invalid", "invalid"], ["decomposed", "decomposed"]]) {
      const args = await close.buildArgs({ ...state, terminalReason: reason }, ctx, io);
      assert.equal(args[args.indexOf("--terminal-state") + 1], expected);
    }
    // worktree is optional for close: absent worktree must not fail it
    const args = await close.buildArgs(state, ctx, { git: async () => "" });
    assert.ok(!args.includes("--worktree"));
  });
});
