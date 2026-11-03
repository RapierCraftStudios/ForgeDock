# 4912: warm sandbox pool on the pool agent

**Context.** Every remote lane launches, clones and installs before work (#4909 handled the dep cache and capacity wait, and left warm sandboxes here).

**Choice.**
- The lane (`sandbox-remote.mjs`) claims before it launches, only when `execution.warm_sandboxes > 0`; any miss or error is the unchanged cold launch.
- A container's env is fixed at `docker run`, so a warm sandbox receives its lane through a 0600 claim file in a mounted `/claim` dir (env, command, ref), read once and deleted by the entrypoint.
- The pool size is learned from `spec.warm` of the launch and claim specs; the agent keeps no repo list (the router sends each repo's forge.yaml, so it has no repos map either).
- A claimed record keeps its warm id (the container's cred and relay URLs name it) and answers to the lane id through `alias`.
- Refresh is `git fetch origin <ref>` plus a hard reset (`warm-refresh.sh`): incremental, and ignored files such as installed dependencies stay.
- New logic is in `bin/pool/warm.mjs`; `agent.mjs` and `router.mjs` only wire it.

**Rejected.**
- Passing lane env through `docker exec`: secrets would reach argv.
- A repo list in the agent config: duplicates `execution` and the router's per-repo config.
- Installing dependencies with package-manager commands in the entrypoint: reimplements the target's tooling; the entrypoint primes the existing lockfile-keyed `depcache` instead.
