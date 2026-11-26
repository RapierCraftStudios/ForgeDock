# 5931: blocker signature gates readmission; engine skew is an environment outcome

- The #5986 ledger entry now carries a blocker signature (code, normalized detail, contract hash, engine version the lane ran, placement, referenced env keys). A readmit with an unchanged signature is refused; a changed engine version, placement, contract hash or referenced env key admits and logs the reason.
- Two identical signatures park the issue (one upserted FORGE:ESCALATION), not three.
- A remote lane that ran another engine major.minor than the host ends `env.engine_skew` (held), never conformance.
- A credentials block naming `ops_credentials` sets `hostPin` in the ledger; placement then returns local on readmit.
- FACTS, NEEDS_HUMAN and AMENDMENT-STATE are edited in place per contract hash (`decidePost` with `contractHash`).
