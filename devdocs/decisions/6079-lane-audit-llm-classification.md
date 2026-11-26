# 6079: bounded small-model classification of unclassified lane failures

- `bin/lean/lane-audit-llm.mjs` `classifyWithLlm` makes one read-only `io.runner` call (role `lane-audit`, default `claude-haiku-5-5`, `resume:null`) over a size-capped, sanitized evidence bundle, and parses strict JSON `{class, signature, owner, action, matcher}`.
- It returns null (never throws) on no runner, error, timeout, bad JSON, invalid class or an invalid matcher regex, so the audit fails open to `unclassified`.
- `bin/lean/lane-audit.mjs` carries `matcher` and `proposed_by:"llm"` into the audit; llm results stay `proposed` and never reach the gap filer. Signature-table hits never call the model.
- `bin/lean/lean.mjs` wires `llm: (ev) => classifyWithLlm(ev, {runner: io.runner, cwd})` at the `runLaneAudit` call; terminal lane behaviour is unchanged.
