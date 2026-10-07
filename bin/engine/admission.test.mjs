import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UNLIMITED,
  CASCADE_PRESETS,
  DEFAULT_CASCADE_POLICY_NAME,
  parseIntOrUnlimited,
  parseOptionalPositiveNumber,
  resolveCascadePolicy,
  admitsGeneration,
  admitsBatchGeneration,
  admitsTokenSpend,
  evaluateCascadeFinding,
  classifyBatchSafety,
  evaluateAmplification,
  batchExclusionReason,
  planP3BatchGroups,
  canDeduplicateAutomatedAlert,
} from "./admission.mjs";

describe("classifyBatchSafety", () => {
  it("classifies the six security findings that previously evaded batching exclusion", () => {
    const fixtures = [
      ["MaintenanceAuth alias bypasses write rate limit", "auth"],
      ["nested bash -c double substitution permits command injection", "injection"],
      ["CTA href needs scheme validation to reject javascript URIs", "scheme"],
      ["Discord markdown code-fence injection from log samples", "injection"],
      ["redact raw psql DETAIL and CONTEXT on migration failure", "redaction"],
      ["PGPASSWORD interpolated into a SQL literal", "credential"],
    ];
    for (const [text, expected] of fixtures) {
      assert.equal(classifyBatchSafety(text), expected, text);
    }
  });

  it("keeps the documented false positives batchable while matching identifier auth", () => {
    assert.equal(classifyBatchSafety("authority_source docstring fix"), null);
    assert.equal(classifyBatchSafety("**Agent**: Security\n## Problem\nstale docstring count"), null);
    assert.equal(classifyBatchSafety("AdminAuth and authz_check must reject bypasses"), "auth");
    assert.equal(classifyBatchSafety("injection\n<!-- FORGE:CLASS: shell-hardening -->"), "shell-hardening");
  });
});

describe("canDeduplicateAutomatedAlert", () => {
  const canonical = {
    authorType: "Bot",
    authorLogin: "github-actions[bot]",
    title: "Backup restore drill failed",
    generator: "backup-restore-drill.yml",
    trigger: "corrupt-backup-fixture-v1",
  };

  it("permits only byte-for-byte equivalent machine alerts after title normalization", () => {
    assert.equal(
      canDeduplicateAutomatedAlert(canonical, {
        ...canonical,
        authorLogin: "app[bot]",
        title: "  backup   restore drill FAILED ",
      }),
      true,
    );
  });

  it("rejects human reports and differing generators or triggers", () => {
    assert.equal(
      canDeduplicateAutomatedAlert(canonical, { ...canonical, authorType: "User", authorLogin: "person" }),
      false,
    );
    assert.equal(canDeduplicateAutomatedAlert(canonical, { ...canonical, generator: "other.yml" }), false);
    assert.equal(canDeduplicateAutomatedAlert(canonical, { ...canonical, trigger: "other-fixture" }), false);
    assert.equal(canDeduplicateAutomatedAlert(canonical, { ...canonical, generator: undefined }), false);
  });
});

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

describe("parseOptionalPositiveNumber", () => {
  it("defaults to disabled and accepts a positive decimal", () => {
    assert.deepEqual(parseOptionalPositiveNumber(undefined), { value: null, warning: null });
    assert.deepEqual(parseOptionalPositiveNumber("off"), { value: null, warning: null });
    assert.deepEqual(parseOptionalPositiveNumber("1.5"), { value: 1.5, warning: null });
  });

  it("disables invalid values with a warning", () => {
    const result = parseOptionalPositiveNumber("0");
    assert.equal(result.value, null);
    assert.match(result.warning, /disabling the bound/);
  });
});

describe("resolveCascadePolicy — presets", () => {
  it("defaults to balanced when no config is given (no-op, matches pre-#2234 hardcoded behavior)", () => {
    const { policy, policyName, warnings } = resolveCascadePolicy();
    assert.equal(policyName, DEFAULT_CASCADE_POLICY_NAME);
    assert.deepEqual(policy, {
      ...CASCADE_PRESETS.balanced,
      maxAmplification: null,
      convergenceWindow: 3,
    });
    assert.deepEqual(warnings, []);
  });

  it("policy: all removes both caps and disables every heuristic", () => {
    const { policy, warnings } = resolveCascadePolicy({ policy: "all" });
    assert.equal(policy.maxGeneration, UNLIMITED);
    assert.equal(policy.batchMaxGeneration, 2);
    assert.equal(policy.tokenBudget, UNLIMITED);
    assert.equal(policy.deferOnBatchGated, false);
    assert.equal(policy.keywordHeuristic, false);
    assert.equal(policy.p3SameFileDefer, false);
    // "all" leaves both levers uncapped by design — this is the one preset expected to
    // carry the both-uncapped notice (see "resolveCascadePolicy — both-uncapped notice"
    // describe block below for the dedicated coverage of that behavior).
    assert.deepEqual(warnings, [
      "orchestration.cascade: both max_generation and token_budget are unlimited — cascade admission has no upper bound on generation depth or token spend for this run.",
    ]);
  });

  it("policy: conservative keeps balanced's shape but lowers the token budget", () => {
    const { policy } = resolveCascadePolicy({ policy: "conservative" });
    assert.equal(policy.maxGeneration, 1);
    assert.equal(policy.batchMaxGeneration, 2);
    assert.equal(policy.tokenBudget, 450000);
    assert.equal(policy.deferOnBatchGated, true);
  });

  it("unrecognized policy name falls back to balanced with a warning", () => {
    const { policy, policyName, warnings } = resolveCascadePolicy({ policy: "yolo" });
    assert.equal(policyName, "balanced");
    assert.deepEqual(policy, {
      ...CASCADE_PRESETS.balanced,
      maxAmplification: null,
      convergenceWindow: 3,
    });
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
    assert.equal(policy.maxAmplification, null);
    assert.equal(policy.convergenceWindow, 3);
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

  it("keeps batching finite even when explicit cascade admission is unlimited", () => {
    const { policy } = resolveCascadePolicy({ policy: "all" });
    assert.equal(admitsBatchGeneration(2, policy), true);
    assert.equal(admitsBatchGeneration(3, policy), false);
  });

  it("allows a repository to set a different finite batching ceiling", () => {
    const { policy } = resolveCascadePolicy({ batch_max_generation: 3 });
    assert.equal(policy.batchMaxGeneration, 3);
    assert.equal(admitsBatchGeneration(3, policy), true);
    assert.equal(admitsBatchGeneration(4, policy), false);
  });
});

describe("evaluateAmplification", () => {
  it("reports the running ratio without bounding the default policy", () => {
    const { policy } = resolveCascadePolicy();
    assert.deepEqual(evaluateAmplification(2, 3, policy), { ratio: 1.5, exceedsBound: false });
  });

  it("flags an opt-in bound only after the ratio exceeds it", () => {
    const { policy } = resolveCascadePolicy({ max_amplification: 1 });
    assert.equal(evaluateAmplification(2, 2, policy).exceedsBound, false);
    assert.equal(evaluateAmplification(2, 3, policy).exceedsBound, true);
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

  it("validates the legacy fallback itself — a malformed legacy value does not silently bypass validation (forge#2302)", () => {
    const { policy, warnings } = resolveCascadePolicy({ policy: "balanced" }, -1);
    // -1 is invalid — must NOT be silently adopted; falls back to the balanced preset default.
    assert.equal(policy.tokenBudget, 900000);
    assert.ok(warnings.some((w) => /token_budget_per_batch \(legacy alias\)/.test(w)));
  });

  it("accepts a valid legacy fallback with no warning", () => {
    const { policy, warnings } = resolveCascadePolicy({ policy: "balanced" }, 123456);
    assert.equal(policy.tokenBudget, 123456);
    assert.ok(!warnings.some((w) => /legacy alias/.test(w)));
  });
});

describe("resolveCascadePolicy — both-uncapped notice", () => {
  it("flags bothUncapped and adds a warning when policy: all leaves both levers unlimited", () => {
    const { policy, bothUncapped, warnings } = resolveCascadePolicy({ policy: "all" });
    assert.equal(policy.maxGeneration, UNLIMITED);
    assert.equal(policy.tokenBudget, UNLIMITED);
    assert.equal(bothUncapped, true);
    assert.ok(warnings.some((w) => /both max_generation and token_budget are unlimited/.test(w)));
  });

  it("flags bothUncapped via a granular override combination, not just the all preset", () => {
    const { bothUncapped } = resolveCascadePolicy({
      policy: "balanced",
      max_generation: "unlimited",
      token_budget: "unlimited",
    });
    assert.equal(bothUncapped, true);
  });

  it("does not flag bothUncapped when only one lever is uncapped", () => {
    const { bothUncapped: onlyGenUncapped } = resolveCascadePolicy({
      policy: "balanced",
      max_generation: "unlimited",
    });
    assert.equal(onlyGenUncapped, false);

    const { bothUncapped: onlyTokenUncapped } = resolveCascadePolicy({
      policy: "balanced",
      token_budget: "unlimited",
    });
    assert.equal(onlyTokenUncapped, false);
  });

  it("balanced preset (default, no config) never flags bothUncapped", () => {
    const { bothUncapped } = resolveCascadePolicy();
    assert.equal(bothUncapped, false);
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

describe("planP3BatchGroups — concern-level P3 batching", () => {
  const finding = (number, affectedFile, body = "") => ({ number, affectedFile, body });

  it("keeps same-file grouping ahead of every broader key", () => {
    const plan = planP3BatchGroups([
      finding(1, "infra/monitoring/a.yml", "**Source**: PR #42"),
      finding(2, "infra/monitoring/a.yml", "**Source**: PR #42"),
      finding(3, "infra/monitoring/b.yml", "**Source**: PR #42"),
    ]);
    assert.deepEqual(plan.groups, [
      { kind: "same-file", key: "infra/monitoring/a.yml", members: [1, 2] },
    ]);
    assert.deepEqual(plan.ungrouped, [3]);
  });

  it("groups all remaining findings from one source PR cohort", () => {
    const plan = planP3BatchGroups([
      finding(1, "infra/monitoring/a.yml", "**Source**: PR #42"),
      finding(2, "infra/monitoring/b.yml", "**Source**: PR #42"),
      finding(3, "scripts/a.sh", "**Source**: PR #42"),
      finding(4, "README.md", "**Source**: PR #42"),
    ]);
    assert.deepEqual(plan.groups, [
      { kind: "source-pr", key: "42", members: [1, 2, 3, 4] },
    ]);
    assert.deepEqual(plan.ungrouped, []);
  });

  it("groups explicit defect classes across files", () => {
    const plan = planP3BatchGroups([
      finding(1, "infra/monitoring/a.yml", "<!-- FORGE:CLASS: fail-loud-check -->"),
      finding(2, "scripts/check.sh", "<!-- FORGE:CLASS: fail-loud-check -->"),
    ]);
    assert.deepEqual(plan.groups, [
      { kind: "defect-class", key: "fail-loud-check", members: [1, 2] },
    ]);
  });

  it("lowers leaf-directory grouping to three and caps batches at eight", () => {
    const three = planP3BatchGroups([
      finding(1, "scripts/a.sh"), finding(2, "scripts/b.sh"), finding(3, "scripts/c.sh"),
    ]);
    assert.deepEqual(three.groups, [{ kind: "leaf-directory", key: "scripts", members: [1, 2, 3] }]);

    const nine = planP3BatchGroups(Array.from({ length: 9 }, (_, index) => finding(index + 1, `scripts/${index}.sh`)));
    assert.deepEqual(nine.groups, [{ kind: "leaf-directory", key: "scripts", members: [1, 2, 3, 4, 5, 6, 7, 8] }]);
    assert.deepEqual(nine.ungrouped, [9]);
  });

  it("extends compatible open batches before creating another one", () => {
    const plan = planP3BatchGroups(
      [finding(1, "scripts/a.sh"), finding(2, "scripts/a.sh")],
      undefined,
      { openBatches: [{ number: 99, affectedFile: "scripts/a.sh", members: [1], memberCount: 7 }] },
    );
    assert.deepEqual(plan.extensions, [{ batch: 99, key: "scripts/a.sh", members: [2] }]);
    assert.deepEqual(plan.groups, []);
  });

  it("uses urgency and path risk instead of excluding every P2 finding", () => {
    assert.equal(batchExclusionReason({ labels: ["priority:P2"], affectedFile: "scripts/a.sh" }), null);
    assert.equal(batchExclusionReason({ labels: ["priority:P1"], affectedFile: "scripts/a.sh" }), "urgency");
    assert.equal(batchExclusionReason({ labels: ["priority:P2"], affectedFile: "infra/migrations/0333_credit_balance.sql" }), "domain");
    assert.equal(batchExclusionReason({ labels: ["priority:P2"], affectedFile: "services/api/app/billing/charge.py" }), "domain");
    assert.equal(batchExclusionReason({ labels: ["priority:P2"], affectedFile: ".env.example" }), "high-blast-radius");
  });
});
