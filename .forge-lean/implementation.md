### Approach
This is a pull-based read-only relay (K1/K2). A sandbox runs `cs-relay <cmd>`, or a shim the entrypoint writes for each allowlisted name. The request goes to the pool agent, which checks the per-sandbox CS_CRED_TOKEN and forwards it to the router. The router only queues it. On its existing per-lane status poll, the dispatching host lists the pending requests and gates each against `execution.relay_commands`. It runs allowed commands with execFile (no shell, 120s timeout, 1 MB cap, output redacted), refuses all others with rc 126, and posts the answers back. Before launch, the host also runs the frozen contract's simple read-only validate and repro commands and ships their output in CS_RELAY_PREFETCH_B64. No LLM calls. The key and the wrapper stay on the host. This rerun found the earlier commits complete against the frozen contract, so it made no code changes. It re-ran every check.

### Changes
- bin/lean/relay.mjs (new): parseRelayCommands, relayGate, runRelayed, simpleArgv, relayPrefetchCommands, servicePending.
- bin/lean/sandbox-remote.mjs: httpTransport relayPending/relayAnswer; remoteProvider `relays`, CS_RELAY_COMMANDS/CS_RELAY_CAPS/CS_RELAY_PREFETCH_B64 at start, relay servicing in status() (in the background, never throws).
- bin/lean/execution.mjs: parseExecution reads `relay_commands` into `relay` (key only when non-empty); providerByName passes `prefetch`; header comment updated.
- bin/engine-cli.mjs: per-issue `prefetchOf` filled in readBody; `prefetch` passed to providerByName; readRelayCaps (CS_RELAY_CAPS) passed to runCore.
- bin/lean/lean.mjs: the #4785 pre-build gate skips relayed capabilities; hostCapabilityBlock unchanged; JSDoc for o.relayCaps.
- bin/pool/router.mjs: in-memory per-sandbox relay queue with owner check, limits and drop on delete.
- bin/pool/agent.mjs: CS_RELAY_BASE; sandbox relay routes authenticated by credToken and forwarded to the router.
- pool/image/cs-relay (new), pool/image/entrypoint.sh (shims), pool/image/Dockerfile (COPY/chmod).
- docs/CONFIG.md, devdocs/modules/lean.md, pool/README.md: documentation.
- Tests: bin/lean/relay.test.mjs, bin/tests/relay.e2e.test.mjs, bin/lean/lean.test.mjs (#4778 case).

### Acceptance Criteria Status
- R1 ✅ bin/lean/sandbox-remote.mjs:143 (`relays`), bin/lean/execution.mjs:118
- R2 ✅ bin/lean/relay.mjs:44 (gate), bin/lean/relay.mjs:128 (servicePending), bin/pool/router.mjs:36, bin/pool/agent.mjs:247
- R3 ✅ bin/lean/relay.mjs:60 (runs on the host, redacted); bin/lean/sandbox-remote.mjs:187 (the spec carries only command names, capabilities and redacted output)
- R4 ✅ bin/lean/relay.mjs:102, bin/lean/sandbox-remote.mjs:165, pool/image/cs-relay:15
- R5 ✅ bin/tests/relay.e2e.test.mjs:45 (allowlisted command runs, non-allowlisted refused with rc 126), bin/lean/relay.test.mjs

### Verification
- V1 relay.test + relay.e2e: exit 0 (13/13 pass)
- V2 computeshare + sandbox-provider.contract + execution tests: exit 0 (118/118)
- V3 lean.test + engine-outcome-codes, filtered to capabilit|relay: exit 0 (3/3)
- V4 bash -n on cs-relay and entrypoint.sh: exit 0
- V5 enumerating sibling tests: exit 0 (326 pass, 0 fail)
- scripts/check-devdocs-freshness.sh origin/staging: OK. `forgedock check`: PASS.
- The new tests fail without the fix: relay.mjs and the router/agent relay routes do not exist on origin/staging.

### Notes
- New forge.yaml key `execution.relay_commands` (`capability:command`, with a `name*` prefix glob). Without it, nothing changes (P6).
- New lane env: CS_RELAY_COMMANDS, CS_RELAY_CAPS, CS_RELAY_PREFETCH_B64 (contain no secrets), CS_RELAY_BASE (set by the agent), CS_RELAY_TIMEOUT_S (cs-relay, default 300).
- An old router or agent means no relay (cs-relay exits 125). The lane then blocks on credentials and is recovered locally once, as before.
