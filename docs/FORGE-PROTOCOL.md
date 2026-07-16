# FORGE Annotation Protocol — Deprecated

> **This document is no longer the authoritative reference.**
>
> The formal, published specification is:
> **[`docs/spec/forge-protocol-v1.md`](spec/forge-protocol-v1.md)**
>
> The spec in `docs/spec/forge-protocol-v1.md` is the complete, current document.
> It supersedes this file entirely. Please update any bookmarks or links.
>
> **License note**: The authoritative spec is licensed under
> [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) — freely shareable
> and usable in any product with attribution. This older draft was mistakenly
> marked AGPL-3.0; the protocol description itself has always been intended for
> open, license-compatible adoption.

---

## Forge Ledger — Derived Artifact of the Protocol

The **Forge Ledger** is the persistent, file/symbol-keyed knowledge index built from FORGE
annotations. It is a _derived artifact_ of the protocol: the ledger is rebuilt by re-parsing
the annotation corpus on GitHub (source of truth), not by maintaining separate authoritative
state.

### Architecture

```
GitHub Issues/PRs (annotation corpus, source of truth)
          │
          ▼
scripts/build-knowledge-index.mjs   ← incremental indexer (watermarked by issue.updated_at)
          │   uses packages/protocol/src/parse.js (FORGE annotation parser)
          ▼
~/.forge/index/
  knowledge.jsonl    ← card records (one JSON per line, keyed by issue/kind/seq)
  postings.json      ← BM25-lite inverted index (term → card IDs with per-field tf)
  manifest.json      ← issue → content-hash map + watermark + card count
  renames.jsonl      ← git rename log (old path → new path for query-time resolution)
          │
          ▼ (mirrored to orphan branch)
forge-knowledge branch  ← versioned, diffable, hydratable by any clone or CI
```

### Card Schema

Cards are keyed by provenance (`{issue}/{kind}/{seq}`), never by file path. Paths are
attributes maintained by the indexer; renames are metadata updates, not re-keys.

```json
{
  "schemaVersion": 1,
  "id": "1370/pattern/0",
  "kind": "pattern",
  "issue": 1370,
  "pattern": "...",
  "rootCause": "...",
  "prevention": "...",
  "paths": ["bin/runner.mjs"],
  "symbols": ["scrubEnv"],
  "anchor": { "path": "bin/runner.mjs", "symbol": "scrubEnv" },
  "status": "fresh",
  "createdAt": "2026-07-04"
}
```

### CLI

```
# Query by file path (exact lookup):
forge recall --file bin/runner.mjs --json

# Query by symbol:
forge recall --symbol scrubEnv --json

# Free-text BM25 search:
forge recall "env scrub proc environ" --k 5

# Index health:
forge recall --doctor

# Rebuild index from scratch:
node scripts/build-knowledge-index.mjs --full-rebuild

# Incremental update (used by close phase):
node scripts/build-knowledge-index.mjs --issue {NUMBER}
```

### Invariants

- **Full rebuild = incremental parity**: running a full rebuild produces byte-identical
  card content to a sequence of incremental runs over the same issue range.
- **Idempotency**: re-indexing the same issue twice produces the same card content (card IDs
  are deterministic; content is a pure function of current annotation state).
- **GitHub wins**: the index is always rebuildable from the annotation corpus alone. Deleting
  `~/.forge/index/` loses nothing — a rebuild restores the same state.
- **Non-blocking**: ledger indexing at close time never stalls the pipeline. Failure is logged
  and the close phase continues.

### Staleness Detection (tiered, cheapest first)

1. Current blob sha of `anchor.path` matches stored blob sha → **FRESH**
2. `anchor.symbol` is still defined in the current file → **FRESH**
3. Rolling-hash scan finds `snippetHash` elsewhere in file → **MOVED** (re-anchor)
4. `snippetHash` found in a file touched by rename log → **MOVED** (re-anchor path)
5. Otherwise → **STALE** (excluded from binding injection; recallable with `--include-stale`)

### Integration Points

- **`commands/work-on/build/context.md` Phase C1**: uses `forge recall --file` for exact
  file-path lookup; falls back to live `gh issue list --search` when index is absent.
- **`commands/work-on/close.md` Phase C5.3**: calls `build-knowledge-index.mjs --issue`
  after merge to index the just-closed issue; advances watermark.

See issue [#1732](https://github.com/RapierCraftStudios/ForgeDock/issues/1732) for the
implementation history and design decisions.
