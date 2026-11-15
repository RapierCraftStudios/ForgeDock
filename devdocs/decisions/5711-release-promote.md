---
status: fresh
anchor: bin/lean/release-promote.mjs
created: 2026-11-15
---

# ADR: build once, promote — where the CI evidence lives and what the deploy side trusts

## Context

A clean deploy spent 23.7 of 77 minutes in a pre-gate that re-runs tests, image builds and the migration rehearsal on the merge commit, although the release PR head with the same tree had passed them (#5711). Nothing bound that CI result to what is deployed.

## Decision

- The attestation is the output of a `forge/promote-evidence` check run on the attested commit. GitHub binds a check run to a sha and names the app that posted it, the deploy side needs only a sha to find it, and `forge/release-gate` already uses this register (`release-gate.mjs`).
- Evidence is matched by **tree**, not commit: a merge commit of the attested head has another sha and the same tree when the default branch did not move. The lookup covers the commit, its parents and merged pull-request heads; the document must name the commit its check run is on.
- The deploy side does not trust the document alone: it re-reads the required checks on the attested commit, so a forged document cannot stand in for checks that did not pass, and a later red re-run revokes the skip.
- Digests are compared per service to be deployed; a service absent from the attestation is a mismatch. A config hash (required checks, service build inputs) catches a deploy side configured differently from the attesting side.
- Shadow first: decisions are `forge/promote-decision` check runs with the observed pre-gate outcome. Exit criterion: 10 observed would-skip decisions, 0 disagreements; then the owner sets `shadow: false`.
- Gate catalogue: `evidence_check` on a gate, mapped by `evidenceSkips`. Safety gates are never skipped by evidence.
- The image plan is pure; ForgeDock emits buildx arguments and the repo's workflow runs them.

## Rejected

- The release ledger (`forge-ledger/<id>`): keyed by release id, written only by the driver credential and off unless `release.managed`; a deploy job knows a sha, not an id.
- The `FORGE:RELEASE` PR-body marker: anyone who can edit the PR can write it.
- Local release state (`state.json`): host-local, invisible to a deploy job on another machine.
- Matching by commit sha only: the merge commit never equals the PR head, so nothing would ever be skipped.
- Skipping safety gates (backup freshness, migration immutability) on CI evidence: they check production state, not the tree.

## Consequences

Attesting needs an app token with `checks: write`. Anyone who can change workflows can post evidence as `github-actions`, which is the trust CI itself already has; the live re-read of the required checks bounds it. `release-deploy.mjs` (W6) does not call `promoteDecision` yet, so today the decision reaches a deploy through the repo's workflow (`skip_pre_gate` output).
