# 6013: staging-health gate before a snapshot cut

Release preflight reads the check-runs of the staging head and refuses the cut while any is failed or pending, naming every failed check (cause: regression or runner) so one batched fix precedes the next snapshot. Default on; `release.allow_red_staging` proceeds with a warning. Unreadable check-run data does not block. The ledger records `rounds` per release (count, wall time, cause) and stats trends snapshot rounds per release. Lane-check parity (R3) lives in the target repo's CI and is deferred.
