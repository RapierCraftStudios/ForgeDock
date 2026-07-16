/**
 * Issue-set resolution predicate model — standing-query re-resolution (forge#2236).
 *
 * `/orchestrate`'s Phase 1 (`commands/orchestrate/phase-1-resolve.md`) turns
 * `$ARGUMENTS` into a concrete list of issue numbers exactly once, at T0, and
 * that list is frozen for the rest of the run (`commands/orchestrate/phase-4-execution.md`
 * states this plainly: "Phase 1 only runs once, at the start."). Of the 8
 * input patterns Phase 1 accepts, only one (`#1 #2 #3` — an explicit literal
 * set) is actually a one-time snapshot by nature. The other 7
 * (`milestone <slug>`, `next <N>`, `next <N> all-repos`, `fast-lane`,
 * `priority:P0`/`priority:P1`/..., `mcp:fast`/`n8n:next 3`, a bare `<slug>`)
 * are standing queries/predicates — "work all P0s", "work this milestone" —
 * and a new issue matching that predicate mid-run is currently invisible to
 * the DAG until the operator re-invokes `/orchestrate` by hand.
 *
 * This module is the typed reference implementation for two decisions Phase 1
 * and Phase 4 need to make about that gap:
 *
 *   1. `classifyInputPattern` — is this input a `literal` set (never
 *      re-resolve — the list of numbers IS the intent) or a `query`
 *      (re-resolve periodically — the predicate is the intent)?
 *   2. `shouldReResolve` — given that classification and the run's
 *      `orchestration.reresolve` config, should Phase 4's Step 4B loop
 *      actually re-run the query this round?
 *   3. `foldNewMatches` — of the issue numbers a re-resolution just
 *      returned, which ones are genuinely new (not already in this run's
 *      processed-issue registry) and therefore candidates to fold into the
 *      live DAG?
 *
 * As with `bin/engine/admission.mjs` (forge#2234), this module does not
 * itself shell out to `gh`/`yq` — the orchestrator is LLM-executed prose,
 * not a `bin/engine/` call site, so `commands/orchestrate/phase-1-resolve.md`
 * and `commands/orchestrate/phase-4-execution.md` mirror these rules by hand
 * in bash. Any change to the classification table or defaults here MUST be
 * mirrored there too (see forge#1837 — mirrored-logic drift between grep ERE
 * and a typed reference is a recurring review-finding class in this pair of
 * files).
 *
 * Hard invariant (by design, not configurable): `foldNewMatches` only ever
 * narrows a re-resolved set down to "not yet processed" — it does not itself
 * decide admission. Every folded-in issue (`newMatches`) MUST still be
 * dispatched through the exact same path a T0-resolved issue takes —
 * standard DAG dependency analysis (`phase-3-dependency.md`) followed by
 * Step 4A/4B's `dispatch_headroom`-gated dispatch (see
 * `phase-4-execution.md` Step 4B.6) — before an agent is dispatched on it.
 * This is deliberately **not** Step 4C's `admission.mjs`'s
 * `evaluateCascadeFinding` chain: that gate's rules (comment/typo keyword
 * heuristic, P3+same-file defer, generation cap) are shaped for
 * cascade-spawned review-findings — a different issue-origin stream — and
 * would incorrectly restrict legitimate re-resolved standing-query issues
 * if applied here. A mid-run check that detects new work but never
 * actually wires into dispatch is exactly the dead-code failure class
 * documented in forge#1832 (`SURFACE_BATCHED_FINDINGS`) — this module must
 * not become a second instance of it.
 */

/**
 * @typedef {"literal"|"query"} InputKind
 */

/**
 * @typedef {Object} ClassifiedInput
 * @property {InputKind} kind
 * @property {string} pattern - Canonical name of the matched pattern, e.g.
 *   "literal-numbers", "milestone", "next-n", "next-n-all-repos",
 *   "fast-lane", "priority", "repo-scoped", "bare-slug".
 * @property {string[]} args - The raw argument tokens (excluding the pattern
 *   keyword itself) that produced this classification, preserved so a
 *   re-resolution round can replay the exact same query.
 */

/**
 * Classify a raw `/orchestrate` input string per the Phase 1 input-pattern
 * table (`commands/orchestrate/phase-1-resolve.md` "Input Patterns").
 *
 * Only an explicit list of bare/`#`-prefixed, optionally repo-prefixed issue
 * numbers (`#1 #2 #3`, `1 2 3`, `#123 mcp:5 n8n:12`) classifies as `literal`.
 * Every other recognized pattern is a `query` — the predicate, not the
 * resolved list, is the caller's actual intent, per the issue's finding that
 * a query re-run mid-batch is what a standing predicate like `priority:P0`
 * or `fast-lane` implies. An input that matches no known pattern still
 * classifies as `query` with `pattern: "unknown"` — unrecognized input is
 * handed to Phase 1's existing milestone/label fallback resolution, which is
 * itself a query (bare `<slug>` row), not a literal set.
 *
 * @param {string} input - Raw `$ARGUMENTS` string (already trimmed).
 * @returns {ClassifiedInput}
 */
export function classifyInputPattern(input) {
  const trimmed = (input ?? "").trim();
  const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

  // literal-numbers: every token is a bare integer or a (optionally
  // repo-prefixed) `#`-prefixed integer, e.g. "1 2 3", "#1 #2 #3",
  // "#123 mcp:5 n8n:12". At least one token is required — empty input is
  // not a literal set, it falls through to "unknown".
  const literalNumberToken = /^([a-zA-Z0-9_-]+:)?#?\d+$/;
  if (tokens.length > 0 && tokens.every((t) => literalNumberToken.test(t))) {
    return { kind: "literal", pattern: "literal-numbers", args: tokens };
  }

  const lower = trimmed.toLowerCase();

  if (/^milestone\s+/.test(lower)) {
    return { kind: "query", pattern: "milestone", args: tokens.slice(1) };
  }

  if (/^next\s+\d+\s+all-repos$/.test(lower)) {
    return { kind: "query", pattern: "next-n-all-repos", args: tokens.slice(1) };
  }

  if (/^next\s+\d+$/.test(lower)) {
    return { kind: "query", pattern: "next-n", args: tokens.slice(1) };
  }

  if (lower === "fast-lane" || lower === "fast") {
    return { kind: "query", pattern: "fast-lane", args: [] };
  }

  if (/^priority:p\d+$/.test(lower) || /^[a-zA-Z0-9_-]+:priority:p\d+$/.test(lower)) {
    return { kind: "query", pattern: "priority", args: tokens };
  }

  // repo-scoped queries: "mcp:fast", "n8n:next 3", "mcp:cascade", etc. — a
  // repo prefix followed by a colon and a recognized query keyword. Checked
  // after the more specific patterns above so e.g. "mcp:5" (a repo-prefixed
  // literal number) is not mis-classified here — literalNumberToken already
  // claimed that shape.
  if (/^[a-zA-Z0-9_-]+:(fast-lane|fast|next|cascade|review-findings|findings)\b/.test(lower)) {
    return { kind: "query", pattern: "repo-scoped", args: tokens };
  }

  if (/^(cascade|review-findings|findings)\b/.test(lower)) {
    return { kind: "query", pattern: "cascade", args: tokens.slice(1) };
  }

  if (tokens.length === 1 && tokens[0].length > 0) {
    // bare `<slug>` — try milestone first, then label search (Phase 1's own
    // fallback order). Still a query: the slug's membership can change.
    return { kind: "query", pattern: "bare-slug", args: tokens };
  }

  return { kind: "query", pattern: "unknown", args: tokens };
}

/**
 * @typedef {Object} ReResolveConfig
 * @property {boolean|string} [enabled] - Explicit off switch. `false` or the
 *   string `"off"` (case-insensitive) disables re-resolution regardless of
 *   `kind`. Absent/`undefined`/`true`/`"on"` leaves the default (on for
 *   query-kind input) in effect. This mirrors the validate-warn-fall-back
 *   idiom's spirit but re-resolution has only two valid states, so an
 *   unrecognized value is treated as `true` (default-on) rather than an
 *   error — the safer default in this context is "keep the existing
 *   behavior of periodic re-check", not "silently stop tracking a standing
 *   predicate".
 * @property {number} [maxRounds] - Bound on how many times a single run may
 *   re-resolve the same predicate. Required to satisfy the issue's
 *   "termination is bounded" acceptance criterion — a standing predicate
 *   that keeps matching must not re-resolve forever. `undefined`/absent
 *   means "no additional bound beyond the caller's own token-budget /
 *   generation caps" (those are enforced downstream, by `admission.mjs`,
 *   not here).
 */

/**
 * Decide whether Phase 4's Step 4B loop should re-run the originating query
 * this round.
 *
 * @param {ClassifiedInput} classified - Result of `classifyInputPattern`.
 * @param {ReResolveConfig} [config]
 * @param {number} [roundsSoFar] - How many re-resolution rounds have already
 *   run this batch (0 on the first call).
 * @returns {{ reResolve: boolean, reason: string }}
 */
export function shouldReResolve(classified, config = {}, roundsSoFar = 0) {
  if (classified.kind === "literal") {
    return {
      reResolve: false,
      reason: "literal issue-number set — the list IS the intent, never re-resolve",
    };
  }

  const enabledRaw = config.enabled;
  const disabled =
    enabledRaw === false || (typeof enabledRaw === "string" && enabledRaw.trim().toLowerCase() === "off");
  if (disabled) {
    return { reResolve: false, reason: "orchestration.reresolve.enabled is off" };
  }

  if (typeof config.maxRounds === "number" && Number.isFinite(config.maxRounds) && roundsSoFar >= config.maxRounds) {
    return {
      reResolve: false,
      reason: `orchestration.reresolve.max_rounds (${config.maxRounds}) reached — bounded termination`,
    };
  }

  return {
    reResolve: true,
    reason: `query pattern "${classified.pattern}" is a standing predicate — re-resolving`,
  };
}

/**
 * Narrow a freshly re-resolved issue-number list down to genuinely new
 * issues — ones not already present in the run's processed-issue registry
 * (T0-resolved issues plus any already admitted in a prior re-resolution
 * round). This function does NOT decide admission; every returned number
 * (`newMatches`) must still be dispatched through the same path a
 * T0-resolved issue takes — standard DAG dependency analysis followed by
 * Step 4A/4B's dispatch (`phase-4-execution.md` Step 4B.6) — NOT through
 * Step 4C's `admission.mjs`'s `evaluateCascadeFinding` chain, which is
 * reserved for the cascade-spawned review-finding stream — see module
 * docstring's "Hard invariant".
 *
 * @param {number[]} reResolvedNumbers - Issue numbers the query returned this round.
 * @param {Iterable<number>} processedRegistry - Issue numbers already
 *   resolved at T0 or admitted in an earlier re-resolution round this run.
 * @returns {{ newMatches: number[], alreadyProcessed: number[] }}
 */
export function foldNewMatches(reResolvedNumbers, processedRegistry) {
  const processed = new Set(processedRegistry);
  const newMatches = [];
  const alreadyProcessed = [];
  const seenThisCall = new Set();

  for (const n of reResolvedNumbers ?? []) {
    if (seenThisCall.has(n)) continue; // de-dupe within the same re-resolution result
    seenThisCall.add(n);
    if (processed.has(n)) {
      alreadyProcessed.push(n);
    } else {
      newMatches.push(n);
    }
  }

  return { newMatches, alreadyProcessed };
}
