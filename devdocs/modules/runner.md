---
module: runner
glob: "bin/runner*"
authority: required
token_cost: 400
last_compacted: "2026-07-08"
---

# Module Dossier: bin/runner.mjs

Rolling per-module knowledge log. Each entry is 3–5 lines with a citation.
Hard cap: 150 lines. Entries are appended by close.md Phase C1.7 after each
PR that touches this module. When the file exceeds 150 lines, oldest entries
are compacted into the Summary block below (LLM compaction, in-run).

## Summary

`bin/runner.mjs` is the execution engine that runs pipeline commands as
subprocesses. Key invariants: model name is included in `runCommand()` return
value; timeout handling uses SIGTERM not ENOBUFS; env-scrub cannot bypass
`CI_TOKEN`; elapsed-time fallback is only reached after ENOBUFS check.

Known failure modes (compacted from historical findings):
- ENOBUFS / SIGTERM confusion: ENOBUFS must be checked before elapsed-time
  timeout fallback (fixed #1433). Any future timeout logic must preserve order.
- Model missing from return value: `runCommand()` must include `model` in its
  return object — callers depend on it for cost accounting (fixed #1668).
- Default model drift: baseline token measurements must be re-run when the
  default model changes (e.g. sonnet-4 → sonnet-5, fixed #1248/#1441).
- Env-scrub bypass: CI_TOKEN and other secrets must survive env-scrub in the
  subprocess spawn path — verify after any env-handling change.

## Entry 2026-07-08 — feat(memory): module dossiers (#1733)

PR #1733 introduced the module dossier system. `bin/runner.mjs` was NOT
changed in this PR — this entry seeds the dossier from historical findings.
Key gotcha: ENOBUFS check order and model return value are the two most
common regression sites. Cite: #1433, #1668, #1248.

## Entry 2026-07-17 — fix(runner): append non-empty stderr on CLI-backend success instead of dropping it (#2456)

PR #2476 touched `runCliBackend`'s success path. When the `--output-format
json` envelope parses with a non-null `.result`, `humanOutput` now appends
trimmed `stderr` after `parsedResult` instead of dropping it silently —
mirrors the same "combine streams" fix applied to `run_bash` in #1229. Key
gotcha: `JSON.parse` must still target `stdout` alone (forge#2422 invariant)
— do not regress this back to combined `output` when touching this block
again. Follow-up findings filed (non-blocking, POSSIBLE/LOW): #2483
(appended stderr reaches console unsanitized — no `sanitizeOutputExcerptForLog`
applied on this success-path sink) and #2484 (empty-string `.result` +
non-empty stderr produces a leading-newline-only logged string). Cite: #2456,
PR #2476, #2422, #1229.

## Entry 2026-07-17 — fix(batch): P3 review findings — bin/runner.mjs (#2522)

PR #2531 fixed the #2483/#2484 follow-ups from the entry above. Key gotcha:
`parsedResult !== null` is true even when `parsedResult === ""` — any future
edit to this ternary must gate on `parsedResult` truthiness (not `!== null`)
when deciding whether to prefix stderr, or an empty `.result` produces a
leading-newline-only artifact. Also: any untrusted stderr/stdout appended
into a NEW log sink in this file must be routed through
`sanitizeOutputExcerptForLog()` — this file now has 6 prior
output-sanitization findings (#2277, #2292, #2293, #2355, #2483, #2484).
Cite: #2522, PR #2531.
