/**
 * Cascade admission policy — orchestration.cascade config surface (forge#2234).
 *
 * `/orchestrate`'s resource limits (`orchestration.max_concurrent`,
 * `pipeline.token_budget_per_batch`, `pipeline.stall_timeout_minutes`, ...)
 * were configurable, but the *admission policy* deciding whether a
 * cascade-spawned review-finding is picked up was not — every rule
 * (generation >= 2 cap, BATCH_FULLY_GATED idle defer, comment/typo keyword
 * heuristic, P3 + same-file overlap) was a hardcoded constant baked into
 * `commands/orchestrate/phase-4-execution.md` prose (see forge#1814,
 * forge#1858, forge#2231). This module gives that policy a typed, unit-tested
 * home: preset expansion + independently-settable granular levers, with the
 * same validate-warn-fall-back idiom the rest of `orchestration.*`/`pipeline.*`
 * already uses (see phase-4-execution.md L108-119 for the bash mirror of this
 * idiom applied to `orchestration.max_concurrent`).
 *
 * This module is the typed reference implementation of the policy the prose
 * specs (`commands/orchestrate/phase-4-execution.md`,
 * `commands/orchestrate/phase-1-resolve.md`) read via `yq` at runtime — the
 * bash blocks in those files mirror the resolution rules below by hand
 * (the orchestrator is LLM-executed prose, not a `bin/engine/` call site),
 * so any change to the preset table or defaults here MUST be mirrored there
 * too. Keeping this module in `bin/engine/` gives the resolution logic a
 * place to be unit-tested in isolation from the prose pipeline.
 *
 * Wiring status (intentional, by design — see forge#2455): none of this
 * module's exports are imported by any prose spec via a `node -e`/dynamic
 * `import()` call site — unlike `bin/engine/resolve.mjs` (forge#2236), whose
 * `classifyInputPattern`/`shouldReResolve`/`foldNewMatches` ARE invoked that
 * way from `phase-1-resolve.md` and `phase-4-execution.md`. This module stays
 * reference-only; the only automated check tying it to the hand-written bash
 * mirror is the CI parity check (`scripts/check-admission-parity.mjs`), which
 * diffs `CASCADE_PRESETS` against the `phase-4-execution.md` Step 4A.pre bash
 * case arms and fails the build on drift. That script's own header comment
 * says it plainly: "The logic actually EXECUTED at runtime is a hand-written
 * bash/yq mirror... the two are kept in sync by hand."
 *
 * Evidence this config surface addresses (see forge#2234 issue body): a
 * cascade admitted via the pre-#2234 `--allow-gen2` all-or-nothing CLI flag
 * (forge#2231) ran generation 2 -> 3 -> 4, drifting from "the engine silently
 * kills entire batches" (gen 2, real value) to "a log sanitizer does not
 * neutralize Unicode bidi-override characters" (gen 4, diminishing value).
 * A binary flag cannot express "admit gen-2, stop at gen-3" or "admit
 * cascade until N tokens spent" — `max_generation` and `token_budget` below
 * are independent levers precisely so that shape of policy is expressible.
 *
 * Hard invariant (NOT configurable by design): safety exclusions — findings
 * whose `## Problem` section indicates security/billing/anti-bot/auth
 * concerns — are never batched and never auto-admitted by ANY policy,
 * including `all`. That exclusion lives upstream of this module (the P3
 * batching eligibility check in `phase-1-resolve.md` / the surface-area
 * batching check in `phase-4-execution.md`) and is intentionally absent
 * from the levers this module resolves.
 */

/** Sentinel string accepted anywhere an "int | unlimited" lever is read. */
export const UNLIMITED = "unlimited";

/**
 * @typedef {Object} CascadePolicy
 * @property {number|typeof UNLIMITED} maxGeneration - Max cascade generation depth
 *   admitted. 1 = only original (non-review-finding-spawned) issues; a
 *   review-finding whose source is itself a review-finding is generation 2,
 *   and so on up the chain. `unlimited` removes the cap entirely.
 * @property {number|typeof UNLIMITED} tokenBudget - Per-batch token ceiling for
 *   Step 4C's review-finding cascade dispatch (mirrors, and by default reads
 *   through to, `pipeline.token_budget_per_batch`). `unlimited` removes the cap.
 * @property {boolean} deferOnBatchGated - Whether a fully-human-gated original
 *   batch (forge#1814's `BATCH_FULLY_GATED`) suppresses further cascade dispatch.
 * @property {boolean} keywordHeuristic - Whether the comment/typo title keyword
 *   heuristic defers P3-and-below findings.
 * @property {boolean} p3SameFileDefer - Whether a P3 finding sharing a file with
 *   the active batch is deferred.
 */

/**
 * Named presets. Each expands to a full `CascadePolicy` — every field can
 * still be overridden individually on top of a preset (see `resolveCascadePolicy`).
 *
 * - `balanced` (default): the pre-#2234 hardcoded behavior, unchanged so an
 *   absent `orchestration.cascade` section is a no-op.
 * - `all`: "pick up everything" — a maintainer draining a backlog. Removes
 *   both caps and disables every heuristic-based defer. Safety exclusions
 *   (see module docstring) still apply — they are not part of this table.
 * - `conservative`: same admission shape as `balanced`, but a materially
 *   lower token ceiling for cost-sensitive or noisy repos.
 *
 * @type {Record<string, CascadePolicy>}
 */
export const CASCADE_PRESETS = Object.freeze({
  all: Object.freeze({
    maxGeneration: UNLIMITED,
    tokenBudget: UNLIMITED,
    deferOnBatchGated: false,
    keywordHeuristic: false,
    p3SameFileDefer: false,
  }),
  balanced: Object.freeze({
    maxGeneration: 1,
    tokenBudget: 900000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
  conservative: Object.freeze({
    maxGeneration: 1,
    tokenBudget: 450000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
});

export const DEFAULT_CASCADE_POLICY_NAME = "balanced";

/**
 * Parse a raw config value that may be a positive integer, the literal
 * string "unlimited" (case-insensitive), or absent/invalid. Mirrors the
 * validate-warn-fall-back idiom used for `orchestration.max_concurrent`
 * (phase-4-execution.md L112-119: `grep -qP '^[1-9][0-9]*$'` -> warn + default)
 * but additionally threads the `unlimited` sentinel through, which that
 * plain positive-int check would otherwise reject (see forge#2234 "Known
 * Pitfalls": an `unlimited` value hitting the un-updated int-only validator
 * silently degrades to the default and the uncap becomes a no-op).
 *
 * @param {unknown} raw
 * @param {number|typeof UNLIMITED} fallback
 * @returns {{ value: number|typeof UNLIMITED, warning: string|null }}
 */
export function parseIntOrUnlimited(raw, fallback) {
  if (raw === undefined || raw === null || raw === "null" || raw === "") {
    return { value: fallback, warning: null };
  }
  if (typeof raw === "string" && raw.trim().toLowerCase() === UNLIMITED) {
    return { value: UNLIMITED, warning: null };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n > 0) {
    return { value: n, warning: null };
  }
  return {
    value: fallback,
    warning: `not a positive integer or "unlimited" ("${raw}") — falling back to default ${fallback}`,
  };
}

/**
 * Expand `orchestration.cascade` config into a fully-resolved `CascadePolicy`.
 * Precedence: explicit granular key > preset value > `balanced` preset value.
 * An unrecognized `policy` name falls back to `balanced` with a warning,
 * following the same validate-warn-fall-back idiom as every other
 * `orchestration.*`/`pipeline.*` key.
 *
 * @param {Object} [config] - Parsed `orchestration.cascade` object from
 *   forge.yaml (or undefined/empty when the section is absent — a no-op
 *   that resolves to `balanced` exactly like today's hardcoded behavior).
 * @param {string} [config.policy]
 * @param {number|string} [config.max_generation]
 * @param {number|string} [config.token_budget]
 * @param {boolean} [config.defer_on_batch_gated]
 * @param {boolean} [config.keyword_heuristic]
 * @param {boolean} [config.p3_same_file_defer]
 * @param {number|string} [legacyTokenBudgetPerBatch] - Deprecated-alias fallback:
 *   `pipeline.token_budget_per_batch`, read when `config.token_budget` is absent
 *   so existing configs keep working unchanged (see forge#1858).
 * @returns {{ policy: CascadePolicy, policyName: string, bothUncapped: boolean, warnings: string[] }}
 */
export function resolveCascadePolicy(config = {}, legacyTokenBudgetPerBatch) {
  const warnings = [];
  const requestedName =
    typeof config.policy === "string" && config.policy.trim() !== ""
      ? config.policy.trim()
      : DEFAULT_CASCADE_POLICY_NAME;

  let policyName = requestedName;
  let preset = CASCADE_PRESETS[requestedName];
  if (!preset) {
    warnings.push(
      `orchestration.cascade.policy "${requestedName}" is not one of: ${Object.keys(CASCADE_PRESETS).join(", ")} — falling back to "${DEFAULT_CASCADE_POLICY_NAME}"`,
    );
    policyName = DEFAULT_CASCADE_POLICY_NAME;
    preset = CASCADE_PRESETS[DEFAULT_CASCADE_POLICY_NAME];
  }

  const maxGen = parseIntOrUnlimited(config.max_generation, preset.maxGeneration);
  if (maxGen.warning) warnings.push(`orchestration.cascade.max_generation ${maxGen.warning}`);

  // token_budget precedence: orchestration.cascade.token_budget (new home) >
  // pipeline.token_budget_per_batch (deprecated alias, forge#1858) > preset default.
  // The legacy fallback is validated through parseIntOrUnlimited itself before use —
  // NOT trusted as-is — so a malformed legacy value (0, negative, NaN, a
  // case-mismatched sentinel like "UNLIMITED") cannot silently bypass validation
  // the way a bare pass-through would (forge#2302).
  const { value: validatedLegacyFallback, warning: legacyWarning } = parseIntOrUnlimited(
    legacyTokenBudgetPerBatch,
    preset.tokenBudget,
  );
  if (legacyWarning) warnings.push(`pipeline.token_budget_per_batch (legacy alias) ${legacyWarning}`);
  const tokenBudgetFallback =
    legacyTokenBudgetPerBatch !== undefined ? validatedLegacyFallback : preset.tokenBudget;
  const tokenBudget = parseIntOrUnlimited(config.token_budget, tokenBudgetFallback);
  if (tokenBudget.warning) warnings.push(`orchestration.cascade.token_budget ${tokenBudget.warning}`);

  const deferOnBatchGated =
    typeof config.defer_on_batch_gated === "boolean" ? config.defer_on_batch_gated : preset.deferOnBatchGated;
  const keywordHeuristic =
    typeof config.keyword_heuristic === "boolean" ? config.keyword_heuristic : preset.keywordHeuristic;
  const p3SameFileDefer =
    typeof config.p3_same_file_defer === "boolean" ? config.p3_same_file_defer : preset.p3SameFileDefer;

  // Both-uncapped notice: neither generation depth nor token spend is bounded this
  // run. This is never a preset default (no preset in CASCADE_PRESETS sets both to
  // UNLIMITED... except "all", which does so deliberately) — surface it loudly so an
  // operator running `policy: all` (or an equivalent granular-override combination)
  // sees the tradeoff explicitly rather than discovering it from an unexpectedly long
  // cascade tail. Distinct from the per-parse `warnings` above (which flag malformed
  // config); this is a policy-shape notice about a valid, fully-resolved configuration.
  const bothUncapped = maxGen.value === UNLIMITED && tokenBudget.value === UNLIMITED;
  if (bothUncapped) {
    warnings.push(
      "orchestration.cascade: both max_generation and token_budget are unlimited — cascade admission has no upper bound on generation depth or token spend for this run.",
    );
  }

  return {
    policy: {
      maxGeneration: maxGen.value,
      tokenBudget: tokenBudget.value,
      deferOnBatchGated,
      keywordHeuristic,
      p3SameFileDefer,
    },
    policyName,
    bothUncapped,
    warnings,
  };
}

/**
 * @param {number|typeof UNLIMITED} generation - 1-indexed cascade depth of the
 *   finding being evaluated (1 = original issue, not spawned from a
 *   review-finding; 2 = spawned from a review-finding; 3 = spawned from a
 *   finding that was itself spawned from a review-finding; ...).
 * @param {CascadePolicy} policy
 * @returns {boolean} true if this generation is admitted by the policy.
 */
export function admitsGeneration(generation, policy) {
  if (policy.maxGeneration === UNLIMITED) return true;
  return generation <= policy.maxGeneration;
}

/**
 * @param {number} projectedSpend - BATCH_TOKEN_SPEND if this unit were admitted.
 * @param {CascadePolicy} policy
 * @returns {boolean} true if there is still headroom under the token budget.
 */
export function admitsTokenSpend(projectedSpend, policy) {
  if (policy.tokenBudget === UNLIMITED) return true;
  return projectedSpend <= policy.tokenBudget;
}

/**
 * Evaluate the general cascade admission rule chain for a single finding.
 * Models the same rule *shape* as `commands/orchestrate/phase-4-execution.md`
 * Step 4C's "Evaluation order" (rules 0-5) — defer-on-gated, generation cap,
 * priority passthrough, keyword heuristic, same-file defer, token budget —
 * with rules 0/3/4 gated by the policy's corresponding toggle and rule 1
 * evaluated via `admitsGeneration`.
 *
 * Rule 1 here is NOT a live substitute for Step 4C's own generation-cap rule:
 * per `docs/CONFIG.md` and `phase-1-resolve.md` ("Cascade / Review-Finding
 * Resolution"), `orchestration.cascade.max_generation` governs Phase 1
 * resolve-time admission only — Step 4C's own generation >= 2 defer during
 * autonomous cascade dispatch (`phase-4-execution.md` Step 4C rule 1) stays
 * hardcoded and absolute regardless of this policy, by design (an unattended
 * run must not cascade forever). This function's generation check instead
 * models the *configurable* Phase-1-resolve-time shape — "admit gen-2, stop
 * at gen-3" (`max_generation: 3`), the exact gap forge#2234 closes for that
 * entry point (a binary flag could not say that) — not Step 4C's
 * non-configurable rule 1.
 *
 * @param {Object} finding
 * @param {number} finding.generation - 1-indexed, see `admitsGeneration`.
 * @param {"P1"|"P2"|"P3"|string} finding.priority
 * @param {string} finding.title
 * @param {boolean} finding.sameFileAsBatch
 * @param {boolean} finding.batchFullyGated
 * @param {number} finding.projectedTokenSpend
 * @param {CascadePolicy} policy
 * @returns {{ admit: boolean, reason: string|null }}
 */
export function evaluateCascadeFinding(finding, policy) {
  if (policy.deferOnBatchGated && finding.batchFullyGated) {
    return { admit: false, reason: "batch fully human-gated — idle policy" };
  }
  if (!admitsGeneration(finding.generation, policy)) {
    return {
      admit: false,
      reason: `generation ${finding.generation} exceeds orchestration.cascade.max_generation (${policy.maxGeneration})`,
    };
  }
  if (finding.priority === "P1" || finding.priority === "P2") {
    return { admit: true, reason: null };
  }
  if (policy.keywordHeuristic && /comment|typo/i.test(finding.title || "")) {
    return { admit: false, reason: "comment/typo heuristic" };
  }
  if (policy.p3SameFileDefer && finding.priority === "P3" && finding.sameFileAsBatch) {
    return { admit: false, reason: "P3 + same file as batch" };
  }
  if (!admitsTokenSpend(finding.projectedTokenSpend, policy)) {
    return { admit: false, reason: `per-batch token budget exhausted (orchestration.cascade.token_budget=${policy.tokenBudget})` };
  }
  return { admit: true, reason: null };
}
