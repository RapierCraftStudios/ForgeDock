# 5920: freeze-time rewrites apply to a reused frozen contract

On contract reuse (rerun/recovery, #5811), `bin/lean/lean.mjs` now re-runs `freezeRewrites`
(`validate.recipes`, worker venv, CI env) on the recovered contract and adopts only changed
validate/repro_test commands. The frozen hash is unchanged.

When a command changes, a FORGE:AMENDMENT of kind `rewrite-validate` naming the frozen hash is
posted as an audit trail. It carries no AMENDMENT-STATE, so it is never replayed, and it is
skipped if an identical comment already exists. A contract with no matching rewrite posts nothing.
