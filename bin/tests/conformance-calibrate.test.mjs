// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelOf, casesOf, scoreKinds, formatKindReport, run, parseCalibrateArgs, eventsOf, mutationStats, formatMutationReport } from "../../scripts/conformance-calibrate.mjs";

const LABELS = "docs/eval/conformance-labels-v1.json";
const labels = () => JSON.parse(readFileSync(LABELS, "utf8"));

describe("conformance-calibrate", () => {
  it("derives a label from the replay shape and ignores unusable cases", () => {
    assert.equal(labelOf({ expected_block: true, blocked: true }), "true-block");
    assert.equal(labelOf({ expected_block: false, blocked: true }), "false-block");
    assert.equal(labelOf({ expected_block: true, blocked: false }), "missed");
    assert.equal(labelOf({ expected_block: false, blocked: false }), "true-pass");
    assert.equal(labelOf({}), null);
    assert.equal(casesOf([{ kind: "k", label: "true-block" }, { label: "true-block" }, { kind: "k" }]).length, 1);
  });

  it("scores precision, recall and false-block rate per kind", () => {
    const c = (kind, label) => ({ kind, label });
    const rows = scoreKinds([c("a", "true-block"), c("a", "true-block"), c("a", "true-block"), c("a", "missed"), c("b", "true-block"), c("b", "false-block"), c("b", "true-block")]);
    const a = rows.find((r) => r.kind === "a"), b = rows.find((r) => r.kind === "b");
    assert.deepEqual([a.precision, a.recall, a.falseBlockRate, a.mode], [1, 0.75, 0, "enforce"]);
    assert.deepEqual([b.falseBlockRate, b.mode], [1 / 3, "shadow"]);
    assert.equal(scoreKinds([c("z", "true-block")])[0].mode, "shadow", "too few blocks to earn enforcement");
    assert.equal(scoreKinds([c("z", "true-block")], { minBlocks: 1 })[0].mode, "enforce");
  });

  it("the labelled set holds the batch b20261031-085207 cases with their labels", () => {
    const got = labels().cases.map((x) => [x.batch, x.issue, x.kind, x.label]);
    for (const row of [
      ["b20261031-085207", 4865, "conformance.omission", "true-block"],
      ["b20261031-085207", 4873, "conformance.omission", "true-block"],
      ["b20261031-085207", 4866, "conformance.guard_broken", "false-block"],
      ["b20261031-085207", 4873, "conformance.guard_broken", "false-block"],
      ["b20261031-085207", 4899, "conformance.guard_broken", "false-block"],
      ["b20261031-085207", 4887, "conformance.scope_creep", "false-block"],
    ]) assert.ok(got.some((g) => g.join() === row.join()), row.join());
    assert.equal(got.filter((g) => g[1] === 4865).length, 2, "#4865 was caught twice");
  });

  it("the labelled set earns enforcement only for the kind with no false block", () => {
    const m = Object.fromEntries(scoreKinds(casesOf(labels())).map((r) => [r.kind, r.mode]));
    assert.deepEqual(m, { "conformance.guard_broken": "shadow", "conformance.omission": "enforce", "conformance.scope_creep": "shadow" });
  });

  it("run scores labels plus a replay corpus and prints the per-kind table", () => {
    const files = { l: labels(), r: { corpus: "replay", cases: [{ id: "x", kind: "conformance.guard_broken", expected_block: true, blocked: true }] } };
    const out = run(["--labels", "l", "--replay", "r"], (p) => files[p]);
    assert.match(out, /8 labelled case\(s\)/);
    assert.match(out, /conformance\.guard_broken\s+4\s+25%\s+100%\s+3\/4 \(75%\)\s+shadow/);
    assert.match(out, /engine\.conformance_kinds: "conformance\.omission=enforce"/);
    assert.equal(JSON.parse(run(["--labels", "l", "--json"], (p) => files[p])).kinds.length, 3);
  });

  it("rejects missing or unknown arguments", () => {
    assert.throws(() => parseCalibrateArgs([]), /usage/);
    assert.throws(() => parseCalibrateArgs(["--nope"]), /unknown argument/);
    assert.match(formatKindReport([]), /none earned/);
  });

  describe("mutation metrics (#4929)", () => {
    const evt = (ids, checked, skipped) => ({ event: "REQUIREMENT_MUTATION_SURVIVED", ids, checked, skipped });
    const mc = (label) => ({ kind: "conformance.mutation_survived", label });

    it("survived share is survived ids over checked requirements, ignoring other events", () => {
      const m = mutationStats([evt(["R1"], 2), evt([], 3), evt([], 0, "dirty tree"), { event: "PRECHECK", ids: ["x"], checked: 9 }], []);
      assert.deepEqual([m.events, m.checked, m.survived, m.survivedShare, m.skippedRuns], [3, 5, 1, 0.2, 1]);
      assert.equal(mutationStats([], []).survivedShare, null);
      assert.equal(mutationStats([evt([], 0, "skip")], []).survivedShare, null);
    });

    it("false survived is the false-block share of labelled mutation_survived cases", () => {
      const m = mutationStats([], [mc("true-block"), mc("false-block"), mc("true-block"), mc("true-pass"), { kind: "other", label: "false-block" }]);
      assert.deepEqual([m.falseSurvived, m.labelledSurvived, m.falseSurvivedRate], [1, 3, 1 / 3]);
      assert.equal(mutationStats([], []).falseSurvivedRate, null);
    });

    it("eventsOf reads JSONL, an array and {events}, dropping bad lines", () => {
      assert.equal(eventsOf('{"event":"a"}\nnot json\n{"event":"b"}\n').length, 2);
      assert.equal(eventsOf('[{"event":"a"}]').length, 1);
      assert.equal(eventsOf('{"events":[{"event":"a"},{"event":"b"}]}').length, 2);
      assert.equal(eventsOf("").length, 0);
    });

    it("run with --events adds the mutation section; without it the output is unchanged", () => {
      const jsonl = [evt(["R1"], 2), evt([], 2)].map((e) => JSON.stringify(e)).join("\n");
      const files = { l: { cases: [mc("true-block"), mc("false-block")] }, e: jsonl };
      const read = (p) => files[p];
      const withEv = run(["--labels", "l", "--events", "e"], read, read);
      assert.match(withEv, /survived-mutation share: 1\/4 \(25%\) over 2 event\(s\), 0 skipped/);
      assert.match(withEv, /false survived: 1\/2 \(50%\)/);
      assert.equal(JSON.parse(run(["--labels", "l", "--events", "e", "--json"], read, read)).mutation.survivedShare, 0.25);
      const plain = run(["--labels", "l"], read, read);
      assert.doesNotMatch(plain, /mutation check/);
      assert.equal(JSON.parse(run(["--labels", "l", "--json"], read, read)).mutation, undefined);
      assert.match(formatMutationReport(mutationStats([], [])), /0\/0 \(n\/a\)/);
    });

    it("parses --events", () => {
      assert.equal(parseCalibrateArgs(["--labels", "l", "--events", "e"]).events, "e");
      assert.equal(parseCalibrateArgs(["--labels", "l"]).events, null);
    });
  });
});
