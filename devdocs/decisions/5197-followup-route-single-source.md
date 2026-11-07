# 5197: follow-up routing has one source

`owner_route` and `host_route` in `scripts/file-deferred-followups.sh` used to repeat the post-promotion, pre-promotion,
external-need and read-only-prod patterns that `ownerRoute`/`hostRoute` in `bin/lean/conformance.mjs` also held, so each
routing change was made twice (#5189 had to). JS and POSIX ERE spell word boundaries differently, so one pattern string
cannot serve both. Decision: `conformance.mjs` is the single source and the shell calls `scripts/followup-route.mjs`
(`owner|host <why>`), which prints the route. A missing node or helper aborts the run (exit 2); it never guesses a route.
`scripts/owner-route-parity.test.sh` checks the shell functions against the JS exports and fails if an `*_ERE` is
re-declared in the shell. The helper lives in `scripts/` to keep the `bin/lean` file lists unchanged.
