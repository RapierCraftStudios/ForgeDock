# ForgeDock Native CLI

This Bun workspace is the source for the self-contained `forgedock-cli`
application. It uses OpenCode's MIT-licensed architecture as a starting point,
not as a runtime dependency.

## Invariants

- `forgedock` and `forgedock-cli` are distinct executables and release trains.
- `forgedock-cli` compiles to ForgeDock-owned platform binaries.
- User-facing names, paths, schemas, update URLs, telemetry, and network
  services are ForgeDock-owned.
- Native state is isolated under ForgeDock data/config directories.
- Project-native extensions use `.forgedock-cli/`; the existing `.forgedock`
  marker may be a file and must not be treated as a directory.
- Root `commands/**/*.md` remains the authoritative workflow source.
- The ForgeDock durable engine owns workflow phase transitions; native agent
  sessions execute requested phases but do not invent competing phase state.
- A clean-host smoke test must pass without OpenCode installed.

## Build

The upstream toolchain is pinned in [`package.json`](package.json). Use the
exact Bun version declared there for reproducible builds.

The current import is a foundation, not a release candidate. A release remains
blocked until branding, upstream hosted-service removal, ForgeDock workflow
registration, permission integration, platform builds, and clean-host tests
are complete.
