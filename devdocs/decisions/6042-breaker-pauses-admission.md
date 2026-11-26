# 6042: a tripped breaker pauses admission, it does not end the batch

- `bin/lean/orchestrate.mjs`: with pending issues and nothing running, a tripped breaker now makes the runner poll (`pollMs`) instead of ending the run, when the breaker is clearable (environmental, transport, or a hosted `getClearBreaker` channel). A non-environmental breaker with no clear channel still ends the run and keeps pending issues for `--resume`.
- The environmental auto-reset (`decideAutoReset`) now runs for every batch, not only standing orders; pool health is optional.
- `bin/lean/schedd.mjs` (`rehostLater`, `rehostUnrun`) and `bin/lean/batch-health.mjs` (`evaluateDispatchStall`) treat an environmental breaker like a transport one: the batch is re-hosted and a dispatch stall is reported. A non-environmental breaker still waits for an operator.
- Consequence: a transport trip waits out its cooldown and resumes instead of ending held.
