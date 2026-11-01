# pool

ForgeDock's built-in remote compute pool (imported from computeshare; AGPL-3.0-or-later).

- `bin/pool/` router, agent, docker/http/store helpers and `cli.mjs` (`node bin/pool/cli.mjs router|agent|install-command ...`).
- `pool/image/` lane image recipe (Dockerfile, shims, entrypoint, `cs-cred` credential relay, `cs-relay` read-only capability relay: allowlisted commands executed on the dispatching host, #4778).
- `pool/install/` agent installers (Windows/WSL, native Linux, router).
  Native Linux agent (root, systemd): `pool/install/install-agent-linux.sh --router URL --token CODE [--name N --cpus N --mem GB --dry-run]`.
- Tests: `bin/tests/computeshare.test.mjs`.

The module boundary is the ForgeDock HTTP sandbox protocol: the router speaks it to the dispatcher and relays to agents over HTTP. Sandboxes receive only short-lived GitHub and Claude access tokens; refresh tokens stay on the router host.

The `forgedock pool` CLI wiring is tracked separately (#4544).
