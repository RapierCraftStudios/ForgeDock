import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UNLIMITED,
  CASCADE_PRESETS,
  DEFAULT_CASCADE_POLICY_NAME,
  parseIntOrUnlimited,
  resolveCascadePolicy,
  admitsGeneration,
  admitsTokenSpend,
  evaluateCascadeFinding,
} from "./admission.mjs";

describe("parseIntOrUnlimited", () => {
  it("parses a positive integer", () => {
    assert.deepEqual(parseIntOrUnlimited("3", 1), { value: 3, warning: null });
    assert.deepEqual(parseIntOrUnlimited(3, 1), { value: 3, warning: null });
  });

  it("parses the unlimited sentinel case-insensitively", () => {
    assert.deepEqual(parseIntOrUnlimited("unlimited", 1), { value: UNLIMITED, warning: null });
    assert.deepEqual(parseIntOrUnlimited("UNLIMITED", 1), { value: UNLIMITED, warning: null });
    assert.deepEqual(parseIntOrUnlimited(" Unlimited ", 1), { value: UNLIMITED, warning: null });
  });

  it("falls back to default on absent/null/empty with no warning (no-op case)", () => {
    assert.deepEqual(parseIntOrUnlimited(undefined, 12), { value: 12, warning: null });
    assert.deepEqual(parseIntOrUnlimited(null, 12), { value: 12, warning: null });
    assert.deepEqual(parseIntOrUnlimited("null", 12), { value: 12, warning: null });
    assert.deepEqual(parseIntOrUnlimited("", 12), { value: 12, warning: null });
  });

  it("warns and falls back on invalid values (zero, negative, non-numeric)", () => {
    for (const bad of ["0", "-1", "abc", "3.5"]) {
      const r = parseIntOrUnlimited(bad, 5);
      assert.equal(r.value, 5);
      assert.match(r.warning, /falling back to default 5/);
    }
  });
});

describe("resolveCascadePolicy — presets", () => {
  it("defaults to balanced when no config is given (no-op, matches pre-#2234 hardcoded behavior)", () => {
    const { policy, policyName, warnings } = resolveCascadePolicy();
    assert.equal(policyName, DEFAULT_CASCADE_POLICY_NAME);
    assert.deepEqual(policy, CASCADE_PRESETS.balanced);
    assert.deepEqual(warnings, []);
  });

  it("policy: all removes both caps and disables every heuristic", () => {
    const { policy, warnings } = resolveCascadePolicy({ policy: "all" });
    assert.equal(policy.maxGeneration, UNLIMITED);
    assert.equal(policy.tokenBudget, UNLIMITED);
    assert.equal(policy.deferOnBatchGated, false);
    assert.equal(policy.keywordHeuristic, false);
    assert.equal(policy.p3SameFileDefer, false);
    assert.deepEqual(warnings, []);
  });

  it("policy: conservative keeps balanced's shape but lowers the token budget", () => {
    const { policy } = resolveCascadePolicy({ policy: "conservative" });
    assert.equal(policy.maxGeneration, 1);
    assert.equal(policy.tokenBudget, 450000);
    assert.equal(policy.deferOnBatchGated, true);
  });

  it("unrecognized policy name falls back to balanced with a warning", () => {
    const { policy, policyName, warnings } = resolveCascadePolicy({ policy: "yolo" });
    assert.equal(policyName, "balanced");
    assert.deepEqual(policy, CASCADE_PRESETS.balanced);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not one of/);
  });
});

describe("resolveCascadePolicy — granular overrides compose with a preset", () => {
  it("a single granular key overrides just that field, preset supplies the rest", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced", max_generation: "unlimited" });
    assert.equal(policy.maxGeneration, UNLIMITED);
    // Everything else still comes from the balanced preset.
    assert.equal(policy.tokenBudget, 900000);
    assert.equal(policy.deferOnBatchGated, true);
    assert.equal(policy.keywordHeuristic, true);
    assert.equal(policy.p3SameFileDefer, true);
  });

  it("granular boolean overrides on top of the all preset", () => {
    const { policy } = resolveCascadePolicy({ policy: "all", defer_on_batch_gated: true });
    assert.equal(policy.deferOnBatchGated, true);
    // Unrelated fields remain the all-preset's.
    assert.equal(policy.maxGeneration, UNLIMITED);
    assert.equal(policy.keywordHeuristic, false);
  });

  it("max_generation can express admit-gen-2-stop-at-gen-3 (the case a binary flag cannot)", () => {
    const { policy } = resolveCascadePolicy({ policy: "all", max_generation: 3 });
    assert.equal(admitsGeneration(1, policy), true);
    assert.equal(admitsGeneration(2, policy), true);
    assert.equal(admitsGeneration(3, policy), true);
    assert.equal(admitsGeneration(4, policy), false);
  });
});

describe("resolveCascadePolicy — token_budget deprecated-alias fallback", () => {
  it("falls back to legacy pipeline.token_budget_per_batch when orchestration.cascade.token_budget is absent", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" }, 300000);
    assert.equal(policy.tokenBudget, 300000);
  });

  it("orchestration.cascade.token_budget wins over the legacy alias when both are set", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced", token_budget: 50000 }, 300000);
    assert.equal(policy.tokenBudget, 50000);
  });
});

describe("admitsGeneration / admitsTokenSpend", () => {
  it("unlimited admits any generation and any spend", () => {
    const policy = CASCADE_PRESETS.all;
    assert.equal(admitsGeneration(1, policy), true);
    assert.equal(admitsGeneration(99, policy), true);
    assert.equal(admitsTokenSpend(0, policy), true);
    assert.equal(admitsTokenSpend(Number.MAX_SAFE_INTEGER, policy), true);
  });

  it("balanced caps generation at 1 and token spend at 900000", () => {
    const policy = CASCADE_PRESETS.balanced;
    assert.equal(admitsGeneration(1, policy), true);
    assert.equal(admitsGeneration(2, policy), false);
    assert.equal(admitsTokenSpend(900000, policy), true);
    assert.equal(admitsTokenSpend(900001, policy), false);
  });
});

describe("evaluateCascadeFinding — Step 4C rule-chain parity", () => {
  const baseFinding = {
    generation: 1,
    priority: "P3",
    title: "fix: something",
    sameFileAsBatch: false,
    batchFullyGated: false,
    projectedTokenSpend: 0,
  };

  it("policy: all admits a gen >= 3 finding (the regression this issue's AC requires)", () => {
    const { policy } = resolveCascadePolicy({ policy: "all" });
    const result = evaluateCascadeFinding({ ...baseFinding, generation: 3 }, policy);
    assert.equal(result.admit, true);
    assert.equal(result.reason, null);
  });

  it("balanced defers a gen 2 finding even at P3", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding({ ...baseFinding, generation: 2 }, policy);
    assert.equal(result.admit, false);
    assert.match(result.reason, /generation 2 exceeds/);
  });

  it("rule 0: batch fully gated always defers when deferOnBatchGated is true, even for P1", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding(
      { ...baseFinding, priority: "P1", batchFullyGated: true },
      policy,
    );
    assert.equal(result.admit, false);
    assert.match(result.reason, /batch fully human-gated/);
  });

  it("rule 0 is a no-op under policy: all (deferOnBatchGated: false)", () => {
    const { policy } = resolveCascadePolicy({ policy: "all" });
    const result = evaluateCascadeFinding({ ...baseFinding, batchFullyGated: true }, policy);
    assert.equal(result.admit, true);
  });

  it("priority override: P1/P2 always execute, skipping keyword/same-file heuristics", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding(
      { ...baseFinding, priority: "P2", title: "comment: typo fix", sameFileAsBatch: true },
      policy,
    );
    assert.equal(result.admit, true);
  });

  it("keyword heuristic defers a P3 comment/typo finding when enabled", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding({ ...baseFinding, title: "fix: typo in README" }, policy);
    assert.equal(result.admit, false);
    assert.match(result.reason, /comment\/typo/);
  });

  it("keyword heuristic is disabled under policy: all", () => {
    const { policy } = resolveCascadePolicy({ policy: "all" });
    const result = evaluateCascadeFinding({ ...baseFinding, title: "fix: typo in README" }, policy);
    assert.equal(result.admit, true);
  });

  it("P3 + same-file defers when enabled", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding({ ...baseFinding, sameFileAsBatch: true }, policy);
    assert.equal(result.admit, false);
    assert.match(result.reason, /same file/);
  });

  it("token budget defers a P3 finding once projected spend exceeds the ceiling", () => {
    const { policy } = resolveCascadePolicy({ policy: "balanced" });
    const result = evaluateCascadeFinding({ ...baseFinding, projectedTokenSpend: 900001 }, policy);
    assert.equal(result.admit, false);
    assert.match(result.reason, /token budget exhausted/);
  });
});
