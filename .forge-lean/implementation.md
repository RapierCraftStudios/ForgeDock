forge-stamp: issue=5923 contract=d00ed65b8089
### Approach
One NAT-pin template in health.mjs (rules, script, unit) used at agent start and embedded verbatim in install-agent.sh; netState reported in agent status/`/health` and `pool status`; lane side adds a typed deferred `sandbox.egress_timeout`.
### Changes
- bin/pool/health.mjs: natPinRules, natPinScript, natPinUnit, bridgeSubnets, ensureNatPin, netState.
- bin/pool/agent.mjs: wslNetworkFixup pins; `net` (60 s cache) in the status body.
- bin/pool/cli.mjs: `pool status` net line, DEGRADED.
- pool/install/install-agent.sh: WSL script + systemd unit.
- bin/lean/execution.mjs: isEgressTimeout, SANDBOX_EGRESS_TIMEOUT_CODE, egressDeferred.
- devdocs/modules/lean.md, devdocs/decisions/5923-wsl-mirrored-egress.md, .forge/post-deploy-checks.json.
- Tests: bin/tests/pool-nat-pin.test.mjs (new), bin/lean/lanecheck.test.mjs.
### Acceptance Criteria Status
- R1 ✅ health.mjs ensureNatPin / agent.mjs wslNetworkFixup / install-agent.sh
- R2 ✅ unit After/PartOf/WantedBy docker.service, idempotent -C before -I
- R3 ✅ agent.mjs status `net`, cli.mjs net line
- R4 ✅ netState degraded, cli DEGRADED
- R5 ✅ execution.mjs egressDeferred
- R6 ✅ devdocs/decisions/5923-wsl-mirrored-egress.md
- R7 ✅ pool-nat-pin.test.mjs
- R8 ✅ pool-nat-pin.test.mjs status test
- R9 ✅ lanecheck.test.mjs
- R10 post-deploy: check 5923-no-egress-timeout-after-pin
### Verification
V1 pass (8); V2 pass (lanecheck, pool-cli, pool-install, bundle); V3 pass; V4 pass; G1 pass (777); forgedock check PASS. New tests fail without the fix (functions absent / code retyped to engine-error). No formatter configured in the repo.
### Notes
`isEgressTimeout` does not match bare clone timeouts, so those keep `sandbox.clone`. `/health` data is the status body; `net` is additive. `iptables` needs root, so a non-root agent reports nat_pin=false.

Follow-up: bin/lean/execution.test.mjs imports and tests isEgressTimeout and SANDBOX_EGRESS_TIMEOUT_CODE (sibling list updated).
