# 5557: classification record

Context: only prose headings described an issue; the engine could not decide lane, units or risk.

Choice: path facts (units, shared modules, migrations, contract) and risk are computed by `release-classify.mjs` from the unit map; the LLM supplies only type, severity, exists_in, flag and narrative. `exists_in: live` is kept only with a `git cat-file`-verified file:line on the live sha and a red/green repro, else `unknown` and `lane_hint: release`. Text-only records are capped at 0.5 and never trusted for `migrations: none`.

Rejected: LLM-typed unit lists (unreliable); a numeric risk score (no calibration data); a correction round for an invalid record (a text-only fallback costs no LLM call).
