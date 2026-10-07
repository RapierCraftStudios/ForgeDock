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
 * Evidence this config surface addresses (see forge#2234 issue body): a
 * cascade admitted via the pre-#2234 `--allow-gen2` all-or-nothing CLI flag
 * (forge#2231) ran generation 2 -> 3 -> 4, drifting from "the engine silently
 * kills entire batches" (gen 2, real value) to "a log sanitizer does not
 * neutralize Unicode bidi-override characters" (gen 4, diminishing value).
 * A binary flag cannot express "admit gen-2, stop at gen-3" or "admit
 * cascade until N tokens spent" — `max_generation` and `token_budget` below
 * are independent levers precisely so that shape of policy is expressible.
 *
 * Billing findings are never batched. Security-relevant P3 findings may only
 * batch with findings in the same coarse class, with a maximum of three
 * members. The prose mirrors use `classifyBatchSafety` as their reference.
 */

/** Sentinel string accepted anywhere an "int | unlimited" lever is read. */
export const UNLIMITED = "unlimited";

const BATCH_SAFETY_CLASSES = [
  ["billing", /\bbilling\b/i],
  ["auth", /\b(?:[A-Za-z0-9]*[A-Z][A-Za-z0-9]*[Aa][Uu][Tt][Hh][A-Za-z0-9]*|[Aa][Uu][Tt][Hh](?:[NnZz]?_|[A-Z]))\b|\b(?:authentication|authorization|authn|authz)\b/i],
  ["injection", /\b(?:inject|injection|xss|csrf|ssrf|deserializ|rce)\w*/i],
  ["access-control", /\b(?:bypass|escalat|privilege)\w*/i],
  ["credential", /\b(?:credential|secret|token|password|pgpassword|htpasswd)\w*/i],
  ["redaction", /\b(?:redact|sanitiz)\w*/i],
  ["scheme", /\bscheme\b/i],
  ["traversal", /\btraversal\b/i],
  ["security", /\b(?:security|anti-bot)\b/i],
];

/**
 * Return the batching safety class for title/Problem text. `null` is routine
 * work; `billing` is an absolute exclusion; every other value is eligible only
 * for a same-class, maximum-three-member security batch.
 *
 * `auth` deliberately matches camelCase/PascalCase and underscore identifiers
 * (MaintenanceAuth, AdminAuth, authz_check) without matching authority_source.
 * @param {string} text
 * @returns {string|null}
 */
export function classifyBatchSafety(text) {
  const findingText = text.replace(/^\*\*Agent\*\*:.*$/gim, "");
  const explicitClass = findingText.match(/<!--\s*FORGE:CLASS:\s*([a-z0-9-]+)\s*-->/i)?.[1];
  if (explicitClass) return explicitClass.toLowerCase();
  return BATCH_SAFETY_CLASSES.find(([, pattern]) => pattern.test(findingText))?.[0] ?? null;
}

/**
 * True only for the narrow automated-alert duplicate case. Human-authored
 * reports and alerts without a stable generator/trigger identity always stay
 * for investigation.
 *
 * @param {Object} canonical
 * @param {Object} candidate
 * @returns {boolean}
 */
export function canDeduplicateAutomatedAlert(canonical, candidate) {
  const isAutomated = (issue) =>
    issue?.authorType === "Bot" || /\[bot\]$/i.test(issue?.authorLogin || "");
  const normalizeTitle = (title) => String(title || "").trim().replace(/\s+/g, " ").toLowerCase();
  const hasIdentity = (value) => typeof value === "string" && value.trim() !== "";

  return (
    isAutomated(canonical) &&
    isAutomated(candidate) &&
    normalizeTitle(canonical.title) !== "" &&
    normalizeTitle(canonical.title) === normalizeTitle(candidate.title) &&
    hasIdentity(canonical.generator) &&
    hasIdentity(candidate.generator) &&
    canonical.generator === candidate.generator &&
    hasIdentity(canonical.trigger) &&
    hasIdentity(candidate.trigger) &&
    canonical.trigger === candidate.trigger
  );
}

/**
 * @typedef {Object} CascadePolicy
 * @property {number|typeof UNLIMITED} maxGeneration - Max cascade generation depth
 *   admitted. 1 = only original (non-review-finding-spawned) issues; a
 *   review-finding whose source is itself a review-finding is generation 2,
 *   and so on up the chain. `unlimited` removes the cap entirely.
 * @property {number} batchMaxGeneration - Deepest review-finding generation that
 *   may be absorbed into a P3 batch. This is deliberately always finite: batching
 *   is a bounded aggregation exception to autonomous cascade admission, not an
 *   alternate path to unlimited recursion.
 * @property {number|typeof UNLIMITED} tokenBudget - Per-batch token ceiling for
 *   Step 4C's review-finding cascade dispatch (mirrors, and by default reads
 *   through to, `pipeline.token_budget_per_batch`). `unlimited` removes the cap.
 * @property {boolean} deferOnBatchGated - Whether a fully-human-gated original
 *   batch (forge#1814's `BATCH_FULLY_GATED`) suppresses further cascade dispatch.
 * @property {boolean} keywordHeuristic - Whether the comment/typo title keyword
 *   heuristic defers P3-and-below findings.
 * @property {boolean} p3SameFileDefer - Whether a P3 finding sharing a file with
 *   the active batch is deferred.
 * @property {number|null} maxAmplification - Maximum findings spawned per merged
 *   unit before same-lineage refinements are deferred. `null` disables the bound.
 * @property {number} convergenceWindow - Merged-unit window used to warn when
 *   amplification remains at or above 1.0.
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
    batchMaxGeneration: 2,
    tokenBudget: UNLIMITED,
    deferOnBatchGated: false,
    keywordHeuristic: false,
    p3SameFileDefer: false,
  }),
  balanced: Object.freeze({
    maxGeneration: 1,
    batchMaxGeneration: 2,
    tokenBudget: 900000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
  conservative: Object.freeze({
    maxGeneration: 1,
    batchMaxGeneration: 2,
    tokenBudget: 450000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
});

export const DEFAULT_CASCADE_POLICY_NAME = "balanced";

/** Parse an optional positive decimal used for an opt-in ratio ceiling. */
export function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null || raw === "null" || raw === "" || raw === "off") {
    return { value: null, warning: null };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isFinite(n) && n > 0) return { value: n, warning: null };
  return {
    value: null,
    warning: `not a positive number or "off" ("${raw}") — disabling the bound`,
  };
}

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
 * @param {number|string} [config.batch_max_generation]
 * @param {number|string} [config.token_budget]
 * @param {boolean} [config.defer_on_batch_gated]
 * @param {boolean} [config.keyword_heuristic]
 * @param {boolean} [config.p3_same_file_defer]
 * @param {number|string} [config.max_amplification]
 * @param {number|string} [config.convergence_window]
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

  // Unlike explicit Phase 1 admission, automated batching must retain a finite
  // recursion bound even under policy: all. Do not accept the unlimited sentinel.
  const rawBatchMaxGeneration = config.batch_max_generation;
  const parsedBatchMaxGeneration = Number(rawBatchMaxGeneration);
  const batchMaxGeneration =
    rawBatchMaxGeneration === undefined || rawBatchMaxGeneration === null || rawBatchMaxGeneration === ""
      ? preset.batchMaxGeneration
      : Number.isInteger(parsedBatchMaxGeneration) && parsedBatchMaxGeneration > 0
        ? parsedBatchMaxGeneration
        : preset.batchMaxGeneration;
  if (
    rawBatchMaxGeneration !== undefined &&
    rawBatchMaxGeneration !== null &&
    rawBatchMaxGeneration !== "" &&
    !(Number.isInteger(parsedBatchMaxGeneration) && parsedBatchMaxGeneration > 0)
  ) {
    warnings.push(
      `orchestration.cascade.batch_max_generation is not a positive integer ("${rawBatchMaxGeneration}") — falling back to default ${preset.batchMaxGeneration}`,
    );
  }

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
  const maxAmplification = parseOptionalPositiveNumber(config.max_amplification);
  if (maxAmplification.warning) warnings.push(`orchestration.cascade.max_amplification ${maxAmplification.warning}`);
  const convergenceWindow = parseIntOrUnlimited(config.convergence_window, 3);
  if (convergenceWindow.warning || convergenceWindow.value === UNLIMITED) {
    warnings.push(
      convergenceWindow.warning
        ? `orchestration.cascade.convergence_window ${convergenceWindow.warning}`
        : 'orchestration.cascade.convergence_window cannot be "unlimited" — falling back to default 3',
    );
  }

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
      batchMaxGeneration,
      tokenBudget: tokenBudget.value,
      deferOnBatchGated,
      keywordHeuristic,
      p3SameFileDefer,
      maxAmplification: maxAmplification.value,
      convergenceWindow: convergenceWindow.value === UNLIMITED ? 3 : convergenceWindow.value,
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
 * P3 batches may aggregate deferred findings only through this finite ceiling.
 * The resulting batch must record its maximum member generation for auditability.
 *
 * @param {number} generation
 * @param {CascadePolicy} policy
 * @returns {boolean}
 */
export function admitsBatchGeneration(generation, policy) {
  return generation <= policy.batchMaxGeneration;
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
 * Compute the observable cascade amplification signal and opt-in bound state.
 * The bound is deliberately not an admission decision: callers only apply it
 * to same-lineage refinements, never to unrelated or high-value findings.
 */
export function evaluateAmplification(mergedUnits, findingsSpawned, policy) {
  const ratio = mergedUnits > 0 ? findingsSpawned / mergedUnits : 0;
  return {
    ratio,
    exceedsBound: policy.maxAmplification !== null && ratio > policy.maxAmplification,
  };
}

/**
 * Evaluate the Step 4C rule chain for a single cascade-spawned finding.
 * Mirrors `commands/orchestrate/phase-4-execution.md` Step 4C's "Evaluation
 * order" (rules 0-5) exactly, with rules 0/3/4 gated by the policy's
 * corresponding toggle and rule 1 governed by `admitsGeneration`. Rule 1
 * (generation cap) is evaluated for the finding's *computed* generation —
 * NOT hardcoded to a single-hop "is my source a review-finding" boolean —
 * so a `max_generation: 3` policy actually distinguishes gen 2 from gen 3,
 * per the exact gap forge#2234 exists to close (a binary flag cannot say
 * "admit gen-2, stop at gen-3").
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

/**
 * Deterministic P3 batching rules mirrored by the orchestration specs.
 * Grouping order is deliberately strongest-context first: a finding can only
 * belong to one group, so earlier rules claim it before broader rules run.
 */
export const P3_BATCHING_RULES = Object.freeze({
  maxMembers: 8,
  sameFileMinimum: 2,
  sourcePrMinimum: 2,
  defectClassMinimum: 2,
  leafDirectoryMinimum: 3,
});

const HIGH_BLAST_RADIUS = /(?:^|\/)(?:\.env\.example|docker-compose[^/]*|compose[^/]*|index\.[^/]+|main\.[^/]+)$/i;

function priorityOf(finding) {
  const labels = (finding.labels || []).map((label) => typeof label === "string" ? label : label?.name);
  return labels.find((label) => /^priority:P[0-3]$/.test(label))?.slice(-2) || labels.find((label) => /^P[0-3]$/.test(label)) || "P3";
}

/** Priority is urgency, not risk: only P0/P1 stay individual for latency. */
export function batchExclusionReason(finding, dangerZones = []) {
  if (["P0", "P1"].includes(priorityOf(finding))) return "urgency";
  const file = finding.affectedFile || "";
  if (/^infra\/migrations\/.*credit_balance/i.test(file) || /^services\/api\/app\/billing\//i.test(file)) return "domain";
  if (dangerZones.some((zone) => file === zone || file.startsWith(`${zone}/`))) return "domain";
  if (/\/migrations?\//i.test(file) || HIGH_BLAST_RADIUS.test(file)) return "high-blast-radius";
  return classifyBatchSafety(`${finding.title || ""}\n${finding.body || ""}`) === "billing" ? "domain" : null;
}

function sourcePr(body = "") {
  return body.match(/^\*\*Source\*\*: PR #(\d+)\b/m)?.[1] || null;
}

function defectClass(body = "") {
  return body.match(/<!-- FORGE:CLASS: ([a-z0-9]+(?:-[a-z0-9]+)*) -->/)?.[1] || null;
}

function leafDirectory(file = "") {
  const slash = file.lastIndexOf("/");
  return slash > 0 ? file.slice(0, slash) : null;
}

/**
 * Plan P3 batches from already safety-filtered, open, unbatched, undispatched
 * findings. The caller executes these groups and preserves unclaimed findings
 * for a later full-queue sweep.
 */
export function planP3BatchGroups(findings, rules = P3_BATCHING_RULES, { openBatches = [], dangerZones = [] } = {}) {
  const remaining = new Map(
    findings
      .filter((finding) => finding?.number && finding.affectedFile && !batchExclusionReason(finding, dangerZones))
      .map((finding) => [finding.number, finding]),
  );
  const groups = [];
  const extensions = [];

  for (const batch of openBatches) {
    const key = batch.affectedFile || batch.key;
    const headroom = rules.maxMembers - (batch.memberCount ?? batch.members?.length ?? 0);
    if (!key || headroom <= 0) continue;
    for (const member of batch.members || []) remaining.delete(typeof member === "object" ? member.number : member);
    const members = [...remaining.values()].filter((finding) => finding.affectedFile === key).slice(0, headroom);
    if (members.length) {
      extensions.push({ batch: batch.number, key, members: members.map((finding) => finding.number) });
      members.forEach((finding) => remaining.delete(finding.number));
    }
  }

  const claim = (kind, key, minimum) => {
    const byKey = new Map();
    for (const finding of remaining.values()) {
      const groupKey = key(finding);
      if (!groupKey) continue;
      const members = byKey.get(groupKey) || [];
      members.push(finding);
      byKey.set(groupKey, members);
    }
    for (const [groupKey, members] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      while (members.length >= minimum) {
        const chunk = members.splice(0, rules.maxMembers);
        groups.push({ kind, key: groupKey, members: chunk.map((finding) => finding.number) });
        chunk.forEach((finding) => remaining.delete(finding.number));
      }
    }
  };

  claim("same-file", (finding) => finding.affectedFile, rules.sameFileMinimum);
  claim("source-pr", (finding) => sourcePr(finding.body), rules.sourcePrMinimum);
  claim("defect-class", (finding) => defectClass(finding.body), rules.defectClassMinimum);
  claim("leaf-directory", (finding) => leafDirectory(finding.affectedFile), rules.leafDirectoryMinimum);

  return { groups, extensions, ungrouped: [...remaining.keys()] };
}
