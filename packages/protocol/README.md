# @forgedock/protocol

Parse, validate, and emit [FORGE Annotation Protocol](https://github.com/RapierCraftStudios/ForgeDock)
annotations. MIT-licensed reference implementation.

FORGE annotations are the HTML-comment-wrapped, machine-readable markers
(`<!-- FORGE:INVESTIGATOR -->`, `<!-- FORGE:BUILDER:COMPLETE -->`, etc.) that
ForgeDock's pipeline agents post to GitHub issue and PR comments to create a
durable, greppable paper trail across investigate → build → review → merge.

## Install

```bash
npm install @forgedock/protocol
```

## Usage

```js
import { parse, validate, emit } from '@forgedock/protocol';

// Parse annotations from a GitHub issue/PR comment body
const annotations = parse(commentBody);

// Validate a parsed annotation against its reserved-type schema
const { valid, errors } = validate(annotations[0]);

// Emit a well-formed annotation comment
const comment = emit('BUILDER', { Branch: 'fix/example-123', Commits: '1', 'Files changed': '2' });
```

A CLI conformance runner is also included:

```bash
npx forge-protocol-conformance fixtures/
```

## Reserved Types

The full, current set of reserved annotation types — lifecycle (`§4.1`),
cross-artifact (`§4.2`), and control/error markers (`§4.3`) — is defined in
`src/types.js` (`RESERVED_TYPES`). Read that file directly for the
authoritative, always-current list; this README intentionally does not
restate a count or enumeration here, since that has previously gone stale
(see forge#2118). For the history of *when* each type was introduced, see
`CHANGELOG.md`.

## Versioning Policy

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Because `RESERVED_TYPES` is the wire contract every ForgeDock pipeline agent
and downstream consumer parses against, schema changes are versioned as
follows:

| Change | Bump |
|--------|------|
| New reserved annotation type added | **Minor** (e.g. `1.0.0` → `1.1.0`) |
| New optional field added to an existing type | **Minor** |
| Required field added/removed, or an existing field's semantics/enum values changed, on an existing type | **Major** |
| An existing reserved type is removed or renamed | **Major** |
| Documentation, comment, or non-schema-affecting fix (e.g. a stale comment) | **Patch** |
| Wire-encoding change to an existing type's serialized form, with no schema/type-shape change (e.g. an escaping fix that alters emitted bytes for some field values) | **Patch** — but the CHANGELOG entry MUST include an explicit mixed-version compatibility caveat, since encode/decode output changes even though no reserved type, field, or public export changed |

Every schema-affecting change MUST:

1. Update `CHANGELOG.md` with an entry under the target version, citing the
   originating issue (`forge#NNNN`).
2. Bump `version` in `package.json` accordingly in the same PR.

`.github/workflows/publish-protocol.yml` enforces this: it fails the build
if `src/**` changed on a push to `main` without an accompanying version bump.

## License

MIT — see `LICENSE`.
