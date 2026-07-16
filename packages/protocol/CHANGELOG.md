# Changelog

All notable changes to `@forgedock/protocol` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See `README.md` for the versioning policy that governs how schema changes map
to version bumps.

## [1.1.0] - 2026-07-16

Additive schema changes only — no breaking changes to any existing reserved
type. Consumers already on 1.0.0 remain fully compatible.

### Added

- **`CLAIM`** and **`CLAIM_RELEASED`** reserved types — claims board annotations
  for claim-level parallelism across concurrently orchestrated agents. (forge#1736)
- **`AUTOPILOT_CYCLE`** reserved type — durable record of one `/autopilot`
  execution cycle, enabling baseline-delta computation and cycle resume. (forge#1753)
- **`CARD`** reserved type — Base64url-encoded machine-surface cross-artifact
  annotation (`<!-- FORGE:CARD: v1 sha:<sha8> b64:<base64url> -->`). (forge#1727)

### Fixed

- `CARD` annotation format comment in `src/types.js` corrected to include the
  colon after `FORGE:CARD`, matching the actual emitted/parsed format. (forge#1845)

## [1.0.0] - 2026-07-04

Initial public release. (forge#1291, forge#1451)

### Added

Reference implementation (`parse`, `validate`, `emit`) for the FORGE Annotation
Protocol, covering the following reserved types:

- **Lifecycle** (`§4.1`): `INVESTIGATOR`, `DECOMPOSED`, `CONTRACT`, `CONTEXT`,
  `ARCHITECT`, `BUILDER`, `REVIEWER`, `TRAJECTORY`
- **Cross-artifact** (`§4.2`): `KNOWLEDGE_GIST`, `MILESTONE_INDEX`, `PRIOR_GIST`
- **Control/error markers** (`§4.3`): `REVIEW_STARTED`, `ANCESTRY_FAILED`,
  `GATE_FAILED`, `PUSH_BLOCKED`, `PUSH_FAILED`

Also included: a conformance test suite (`fixtures/` + `src/cli.js`) and an
MIT license for the reference implementation.

[1.1.0]: https://github.com/RapierCraftStudios/ForgeDock/tree/main/packages/protocol
[1.0.0]: https://github.com/RapierCraftStudios/ForgeDock/tree/main/packages/protocol
