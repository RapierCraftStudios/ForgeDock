/**
 * forge#2724: direct unit tests for `assemblePack()`'s whole-pack (second-pass)
 * truncation budget, isolated from the full mineContext() -> assemblePack()
 * -> validateContextPack() pipeline exercised by contextpack.golden.test.mjs.
 *
 * This is a pure-function edge case, not an end-to-end mine/assemble/validate
 * concern, so it lives here as a direct unit test against `assemblePack()`
 * with hand-built `minedData` and small `opts.maxPackBytes` overrides —
 * mirroring the "opts exists purely so tests can exercise the
 * truncation/validation paths with small budgets" contract documented on
 * `assemblePack()` itself (`bin/engine/contextpack.mjs`).
 *
 * Root cause (PR #2722 review finding, forge#2724): the second-pass
 * whole-pack truncation block computed a raw-byte `shrunkBudget` and handed
 * it to `truncateToBytes()` once, then returned without re-measuring the
 * *serialized* (JSON-escaped) pack size. `truncateToBytes()`'s own
 * truncation marker starts with a literal "\n\n", which `JSON.stringify()`
 * always expands to the 4-byte escaped sequence "\n\n" — a guaranteed,
 * unavoidable inflation the one-shot budget calc never accounted for. The
 * fix iterates: truncate, re-measure the serialized size, and if still over
 * budget, shrink further and retry (bounded, with a safe empty-content
 * fallback).
 *
 * @license MIT
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assemblePack } from './contextpack.mjs';

/** Minimal minedData shape assemblePack() needs for the "investigate" slice
 * (see renderSliceContent()/renderIssueExcerpt() in contextpack.mjs): an
 * issue with a number and either a title or body. No annotations/affected
 * files/linked PRs are needed to exercise the truncation path. */
function minedDataWithBody(body) {
  return {
    issue: { number: 2724, title: 'assemblePack truncation budget edge case', body },
  };
}

describe('assemblePack() whole-pack truncation budget (forge#2724)', () => {
  it('never returns a pack whose JSON.stringify() byte length exceeds opts.maxPackBytes, even when maxPackBytes sits at the JSON envelope overhead size', () => {
    // A long body (with no quotes/backslashes of its own) so the *only*
    // source of JSON-escaping inflation is the truncation marker's own
    // literal "\n\n" prefix — isolates the exact bug class from forge#2724.
    const body = 'x'.repeat(5000);
    const minedData = minedDataWithBody(body);

    // maxSliceBytes deliberately larger than maxPackBytes so the per-slice
    // truncation pass does NOT already bring the pack under budget — forces
    // the second-pass whole-pack block to run (per assemblePack()'s own
    // doc comment: "a caller-supplied opts override... can legitimately set
    // maxSliceBytes close to or above maxPackBytes").
    const maxPackBytes = 200;
    const pack = assemblePack('investigate', minedData, {
      maxSliceBytes: 10000,
      maxPackBytes,
    });

    assert.ok(pack, 'assemblePack() should still return a pack, not null');
    const serializedBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
    assert.ok(
      serializedBytes <= maxPackBytes,
      `serialized pack is ${serializedBytes} bytes, exceeds opts.maxPackBytes=${maxPackBytes}`,
    );
    assert.equal(pack.truncated, true, 'pack.truncated must be set when the whole-pack budget forced truncation');
    assert.equal(pack.slices[0].truncated, true, 'slice.truncated must be set alongside pack.truncated');
  });

  it('never returns a pack whose JSON.stringify() byte length exceeds opts.maxPackBytes when the retained content is dense with JSON-escaped characters (quotes/backslashes)', () => {
    // Content that is almost entirely characters JSON must escape, so even
    // a "generous" raw-byte budget inflates heavily once serialized.
    const body = '"\\'.repeat(3000);
    const minedData = minedDataWithBody(body);

    const maxPackBytes = 150;
    const pack = assemblePack('investigate', minedData, {
      maxSliceBytes: 8000,
      maxPackBytes,
    });

    assert.ok(pack, 'assemblePack() should still return a pack, not null');
    const serializedBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
    assert.ok(
      serializedBytes <= maxPackBytes,
      `serialized pack is ${serializedBytes} bytes, exceeds opts.maxPackBytes=${maxPackBytes}`,
    );
  });

  it('degrades to empty slice content (never throws, never exceeds budget) when maxPackBytes is smaller than the JSON envelope alone can fit', () => {
    const minedData = minedDataWithBody('some content here that will need truncating down to nothing');
    const maxPackBytes = 10; // smaller than `{"schema_version":1,"issue":2724,"slices":[{"phase":"investigate","content":"","truncated":true}],"truncated":true}` can ever be
    const pack = assemblePack('investigate', minedData, {
      maxSliceBytes: 5000,
      maxPackBytes,
    });

    assert.ok(pack, 'assemblePack() should still return a pack, not null, even in the unsatisfiable-budget case');
    assert.equal(pack.slices[0].content, '', 'slice content should degrade to empty when the envelope alone cannot fit the budget');
  });

  it('does not run the whole-pack truncation path (control case) when the pack already fits within maxPackBytes', () => {
    const minedData = minedDataWithBody('short body');
    const pack = assemblePack('investigate', minedData, { maxPackBytes: 100000 });

    assert.ok(pack, 'assemblePack() should return a pack');
    assert.equal(pack.truncated, undefined, 'pack.truncated should be unset when no truncation was needed');
    const serializedBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
    assert.ok(serializedBytes <= 100000);
  });
});

/**
 * forge#2681: failure-memory (prior review-findings / closed-as-invalid
 * history on overlapping modules) slice-integration tests. Exercises
 * `assemblePack()`'s `renderSliceContent()` wiring directly with hand-built
 * `minedData.failureMemory` — the mining/ranking (`fetchFailureMemory()`,
 * `rankFailureMemory()`) is exercised separately in
 * `contextpack.mine.test.mjs` via the public `mineContext()` API.
 */
describe('assemblePack() — failure memory injection (forge#2681)', () => {
  const failureMemory = [
    { number: 2716, title: 'linked-PR fetch failures silently reported as empty', body: 'contextpack.mjs bug', closedAt: '2026-07-10T00:00:00Z', label: 'review-finding' },
    { number: 2706, title: 'size cap checked only after full JSON.stringify', body: 'contextpack-schema.js bug', closedAt: '2026-07-01T00:00:00Z', label: 'workflow:invalid' },
  ];

  it('injects a "Prior Failures / Findings" section into the investigate slice when failureMemory items match affectedFiles', () => {
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory,
    };
    const pack = assemblePack('investigate', minedData);
    assert.ok(pack, 'assemblePack() should return a pack');
    const content = pack.slices[0].content;
    assert.match(content, /Prior Failures \/ Findings on These Modules/);
    assert.match(content, /#2716/);
    assert.match(content, /review finding/);
  });

  it('injects the same section into the build slice', () => {
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory,
    };
    const pack = assemblePack('build', minedData);
    assert.ok(pack, 'assemblePack() should return a pack');
    assert.match(pack.slices[0].content, /Prior Failures \/ Findings on These Modules/);
  });

  it('never injects a failure-memory section into the review slice', () => {
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory,
      annotations: [{ type: 'BUILDER', body: 'Implementation Complete', commentIndex: 0 }],
    };
    const pack = assemblePack('review', minedData);
    assert.ok(pack, 'assemblePack() should return a pack');
    assert.doesNotMatch(pack.slices[0].content, /Prior Failures \/ Findings on These Modules/);
  });

  it('renders nothing (no section, no crash) when failureMemory is empty or absent', () => {
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory: [],
    };
    const pack = assemblePack('investigate', minedData);
    assert.ok(pack, 'assemblePack() should still return a pack from the issue excerpt alone');
    assert.doesNotMatch(pack.slices[0].content, /Prior Failures/);

    const minedDataNoField = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
    };
    assert.doesNotThrow(() => assemblePack('investigate', minedDataNoField));
  });

  it('drops items whose same-module hit count is 0 (title/body never mentions an affected-file basename) — the search-API-noise filter', () => {
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: 'some problem' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory: [
        { number: 9999, title: 'unrelated finding about a totally different module', body: 'no mention of the target file', closedAt: '2026-07-15T00:00:00Z', label: 'review-finding' },
      ],
    };
    const pack = assemblePack('investigate', minedData);
    assert.ok(pack);
    assert.doesNotMatch(pack.slices[0].content, /#9999/);
  });

  it('respects the existing MAX_SLICE_BYTES truncation path when failure-memory content alone is large', () => {
    const manyItems = Array.from({ length: 60 }, (_, i) => ({
      number: 3000 + i,
      title: `contextpack.mjs regression #${i} — long descriptive title padded to add bulk to this excerpt`,
      body: 'contextpack.mjs',
      closedAt: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
      label: 'review-finding',
    }));
    const minedData = {
      issue: { number: 2681, title: 'failure memory', body: '' },
      affectedFiles: ['bin/engine/contextpack.mjs'],
      failureMemory: manyItems,
    };
    // Small maxSliceBytes forces truncation via the exact same
    // truncateToBytes() path proven correct by forge#2724 — no new
    // truncation mechanism is introduced by this feature.
    const pack = assemblePack('investigate', minedData, { maxSliceBytes: 200 });
    assert.ok(pack);
    const serializedBytes = Buffer.byteLength(JSON.stringify(pack), 'utf-8');
    assert.ok(serializedBytes <= 32 * 1024, 'stays within MAX_PACK_BYTES default');
    assert.equal(pack.slices[0].truncated, true);
  });
});
