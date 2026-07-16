# Changelog

All notable changes to `@forgedock/protocol` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See `README.md` for the versioning policy that governs how schema changes map
to version bumps.

## [1.2.1] - 2026-07-16

Patch — internal escaping bugfix only. No reserved type, field, or public
export changed. Consumers already on 1.2.0 remain fully compatible.

### Fixed

- `sanitizeFieldValue()` (emit.js) / `unescapeFieldValue()` (parse.js): the
  HTML-comment-delimiter escaping scheme was not injective — a field value
  that already contained literal entity-like text adjacent to `--` (e.g.
  `"<!--&gt;"` or `"&lt;!--"`) could encode to the same output as an
  unrelated value, making the round-tripped decoded value unrecoverable for
  one of them. Fixed by escaping `&` → `&amp;` first (before the delimiter
  escapes) on encode, and unescaping `&amp;` → `&` last (after the delimiter
  unescapes) on decode — the same fix was applied identically to
  `bin/engine/state.mjs`'s FORGE:STATE codec to keep the two escaping
  schemes unified (forge#2119). (forge#2137)

## [1.2.0] - 2026-07-16

Additive coverage/capability change only — no breaking changes to any
existing reserved type or public export. Consumers already on 1.1.0 remain
fully compatible.

### Added

- CARD codec (`canonicalJson`, `toBase64url`, `encodeCard`,
  `decodeCardInlineValue`) extracted from `src/cli.js` into a standalone
  `src/card.js` module and exported from the package's public API
  (`src/index.js`), so library consumers no longer need to reach into the
  CLI to encode/decode CARD's Base64url machine-surface form. (forge#2121)
- `validate()` now performs a CARD-specific integrity check: an inline value
  that fails to decode, or whose sha8 integrity prefix does not match, is now
  reported as invalid (previously any non-empty inline value passed). This
  only tightens acceptance of already-out-of-spec (corrupted/malformed)
  annotations — no well-formed CARD annotation is affected. (forge#2121)
- 4 new conformance fixtures under `fixtures/card-*.json`: a valid card, a
  valid card with a unicode payload, a card with a tampered sha8 prefix, and
  a card with a malformed Base64url segment. (forge#2121)
- `test/card.test.mjs` — round-trip property tests for the CARD codec
  covering unicode payloads, arrays/nested objects, and payloads whose string
  values contain literal HTML-comment-delimiter text (`-->`, `<!--`),
  verifying the Base64url encoding's structural safety guarantee. (forge#2121)

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

[1.2.0]: https://github.com/RapierCraftStudios/ForgeDock/tree/main/packages/protocol
[1.1.0]: https://github.com/RapierCraftStudios/ForgeDock/tree/main/packages/protocol
[1.0.0]: https://github.com/RapierCraftStudios/ForgeDock/tree/main/packages/protocol
