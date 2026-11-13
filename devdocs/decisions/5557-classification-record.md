# 5557: classification record

Context: only prose headings described an issue; the engine could not decide lane, units or risk.

Choice: path facts (units, shared modules, migrations, contract) and risk are computed by `release-classify.mjs` from the unit map; the LLM supplies only type, severity, exists_in, flag and narrative. `exists_in: live` is kept only with a `git cat-file`-verified file:line on the live sha and a repro whose command fails (red) when run by `run(command, liveSha)` on a detached `git worktree add --detach` checkout of the live sha (`green_after` stays null until the fix lands), else `unknown` and `lane_hint: release`. Without `risk.rules` the six epic #5549 §4.3 defaults apply in order (migration, billing/auth/queue paths, rollout paths, contract, more than one unit, over 400 diff lines; else low); the matched rule index is recorded as `risk_rule`. Text-only records are capped at 0.5 and never trusted for `migrations: none`.

Rejected: LLM-typed unit lists (unreliable); a numeric risk score (no calibration data); a correction round for an invalid record (a text-only fallback costs no LLM call).
