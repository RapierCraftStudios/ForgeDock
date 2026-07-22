# Native CLI Provenance

ForgeDock CLI contains source derived from OpenCode under the MIT License.

- Upstream repository: https://github.com/anomalyco/opencode
- Upstream version: `v1.18.4`
- Upstream commit: `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`
- Import method: Git subtree rooted at `native/`
- Upstream license: [`LICENSE`](LICENSE)

The upstream copyright and MIT permission notice are retained verbatim.
ForgeDock modifications are distributed under the repository's AGPL-3.0
license while retaining all applicable third-party notices.

## Product Boundary

The root `forgedock` package remains ForgeDock's workflow installer and control
command. This workspace builds the separate `forgedock-cli` native agent
application and its platform packages.

The shipped ForgeDock CLI must not require an `opencode` executable, package,
configuration directory, credential store, hosted service, or environment
variable at runtime. Internal upstream-derived module names may remain during
the migration but are not public product surfaces.

## Upstream Sync

Import future upstream versions with `git subtree pull --prefix=native` from a
pinned tag or commit. Reapply and verify ForgeDock's branding, storage,
configuration, network-service, workflow, and permission boundaries before
accepting the update.
