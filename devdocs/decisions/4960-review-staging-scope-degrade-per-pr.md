# 4960 — Staging scope degrades per PR, reads run in parallel

**Context:** On a ~290-PR bundle the serial per-PR gh reads took 25+ minutes, and one failed read set `SCOPE_MODE=full` for the whole bundle.

**Decision:** Per-PR reads run in parallel (`FORGE_SCOPE_PARALLELISM`, default 8) and retry via `gh_retry`. A PR whose read still fails is degraded: it gets no review credit, so its commits stay unreviewed (widening for that PR only), and it is named in `scope.json` `degraded_prs`. Only global failures still fall open to `full`.

**Why safe:** a degraded PR is never credited as reviewed, so scope only widens (NORTHSTAR non-negotiable 4). The gate subcommand (`gate-read-failure`) is unchanged.
