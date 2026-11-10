---
description: Conversational setup of the Actions-minutes budget and ci.mode (remote / local-first / local-attested / auto) in forge.yaml
argument-hint: "<plain-language request, e.g. keep me under 2,000 minutes, run tests locally first>"
install: extras
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /forgedock-ci-setup — Actions budget and CI placement

**Input**: $ARGUMENTS

Turn a plain-language request about GitHub Actions minutes into a valid `ci` block in `forge.yaml`. Deterministic facts come from `forgedock ci budget`; you only map the request to keys and confirm.

## Steps

1. Read plan and usage: `forgedock ci budget --json`. It gives `plan`, `includedMinutes`, `monthToDate` (across the account), `projected`, `public`, `mode`. A public repo is free hosted minutes: say so and recommend `auto` (it never switches there).
2. Map the request to keys (flat, under `ci:`):
   - "keep me under N minutes" -> `monthly_minutes: N`; "leave headroom" -> `reserve_pct` (0-90, default 10).
   - "run tests locally first" -> `mode: local-first` (host checks must pass before anything is pushed that triggers paid CI).
   - "post the local result as a status" -> `mode: local-attested`. Tell the user the trade-off: the status is attested by ForgeDock, not run by Actions, the same trust as a self-hosted runner.
   - "just handle it" / no preference -> `mode: auto` (remote while the projection stays under budget, then local-first with a warning).
   - "keep current behaviour" -> `mode: remote`.
3. Show the projection per mode: `remote` spends about `projected` minutes; `local-first` and `local-attested` spend paid CI only on release or nightly runs. State the budget and reserve you will write.
4. Ask the user to confirm. Only then write it: `forgedock ci budget --set-mode <mode> --budget <N> [--reserve <P>] [--plan <free|pro|team|enterprise>]`. This keeps any `milestone_integration` keys in the `ci:` block.
5. Re-run `forgedock ci budget` and print the resulting mode. To see which local commands match the repo's workflows (same tool pins): `forgedock ci budget --propose --base origin/<base>`.

Never write a key the user did not ask for, and never guess a plan: if `plan` is `unknown`, ask for the included minutes (`--budget`).
