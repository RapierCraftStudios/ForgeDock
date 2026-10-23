---
issue: 4470
status: fresh
anchor: scripts/review-staging-pre.sh
created: 2026-10-23
---

# ADR: the staging open-review-finding gate fails closed on unread state

## Context

`scripts/review-staging-pre.sh gate` (#4358) kept the spec's read idioms: `gh pr view ... || echo "false"` for the `review-degraded` label and an unchecked `gh issue list | jq` for open findings (no pipefail). A rate limit, 5xx or expired auth therefore read as "not degraded, no findings", and the gate posted a genuine `FORGE:GATE_PASS` that gate-marker-check then trusted. An empty bundle list passed vacuously: `bundle` ignored a failed `git fetch`, its `grep -P` is absent from BSD grep, and the engine only checked exit codes. Found by the staging review of #4462.

## Choice

- `gate` captures each gh read in a variable and tests its own status, as the scope step already does. A label value other than `true`/`false`, a failed `gh issue list` or a non-array reply is a read failure. Any read failure prints `RESULT: BLOCK DEPLOY`, posts `FORGE:GATE_FAILURE:TYPE=gate-read-failure` and exits 1 before the override is consulted. An override waives known findings, and unread state is not a known finding.
- An empty `--prs-file` blocks `gate`. `bundle` exits 1 on a failed fetch or an empty PR set and uses `grep -E`/`sed` instead of `grep -P`. `bin/review-staging.mjs` reads the bundle file after `bundle` and stops BLOCKED when it holds no PR number.
- The GATE_PASS/GATE_FAILURE bodies of the existing gate types and the `FINDING_PR_FILTER` line are unchanged.

## Rejected

- `set -o pipefail` for the whole script: it changes every other pipeline in `bundle` and `scope` (e.g. `grep -c ... || echo unknown`) for one gate.
- Retrying failed reads inside the gate: a re-run of the staging review is the retry, and a blocked gate costs one re-run while a false pass ships unreviewed findings.
