import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  addDays,
  hasFileOverlap,
  isWithinWindow,
  buildTable,
  lookupCell,
} from '../../scripts/calibration.mjs';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: defaults', () => {
  const args = parseArgs(['node', 'calibration.mjs']);
  assert.equal(args.repo, null);
  assert.equal(args.windowDays, 14);
  assert.equal(args.minSamples, 10);
  assert.equal(args.publish, false);
  assert.equal(args.dryRun, false);
  assert.equal(args.verbose, false);
  assert.equal(args.issue, null);
});

test('parseArgs: explicit flags', () => {
  const args = parseArgs([
    'node', 'calibration.mjs',
    '--repo', 'acme/repo',
    '--window', '30',
    '--min-samples', '5',
    '--publish',
    '--dry-run',
    '--verbose',
    '--issue', '1741',
  ]);
  assert.equal(args.repo, 'acme/repo');
  assert.equal(args.windowDays, 30);
  assert.equal(args.minSamples, 5);
  assert.equal(args.publish, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.verbose, true);
  assert.equal(args.issue, 1741);
});

// ---------------------------------------------------------------------------
// addDays
// ---------------------------------------------------------------------------

test('addDays: adds days correctly', () => {
  const result = addDays('2026-01-01T00:00:00Z', 14);
  assert.equal(result.toISOString().slice(0, 10), '2026-01-15');
});

test('addDays: crosses month boundary', () => {
  const result = addDays('2026-01-25T00:00:00Z', 14);
  assert.equal(result.toISOString().slice(0, 10), '2026-02-08');
});

test('addDays: zero days', () => {
  const result = addDays('2026-06-01T00:00:00Z', 0);
  assert.equal(result.toISOString().slice(0, 10), '2026-06-01');
});

// ---------------------------------------------------------------------------
// hasFileOverlap
// ---------------------------------------------------------------------------

test('hasFileOverlap: exact match', () => {
  assert.equal(hasFileOverlap(['scripts/foo.mjs'], ['scripts/foo.mjs']), true);
});

test('hasFileOverlap: no match', () => {
  assert.equal(hasFileOverlap(['scripts/foo.mjs'], ['scripts/bar.mjs']), false);
});

test('hasFileOverlap: case-insensitive', () => {
  assert.equal(hasFileOverlap(['Scripts/Foo.mjs'], ['scripts/foo.mjs']), true);
});

test('hasFileOverlap: leading slash normalized', () => {
  assert.equal(hasFileOverlap(['/scripts/foo.mjs'], ['scripts/foo.mjs']), true);
});

test('hasFileOverlap: partial overlap in larger sets', () => {
  assert.equal(
    hasFileOverlap(
      ['a.js', 'b.js', 'scripts/calibration.mjs'],
      ['c.js', 'scripts/calibration.mjs', 'd.js']
    ),
    true
  );
});

test('hasFileOverlap: empty arrays return false', () => {
  assert.equal(hasFileOverlap([], ['scripts/foo.mjs']), false);
  assert.equal(hasFileOverlap(['scripts/foo.mjs'], []), false);
  assert.equal(hasFileOverlap([], []), false);
});

test('hasFileOverlap: null inputs return false', () => {
  assert.equal(hasFileOverlap(null, ['scripts/foo.mjs']), false);
  assert.equal(hasFileOverlap(['scripts/foo.mjs'], null), false);
});

// ---------------------------------------------------------------------------
// isWithinWindow — 14-day boundary tests
// ---------------------------------------------------------------------------

test('isWithinWindow: event before merge returns false', () => {
  assert.equal(
    isWithinWindow('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    false
  );
});

test('isWithinWindow: event at merge date returns false (strictly after)', () => {
  assert.equal(
    isWithinWindow('2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    false
  );
});

test('isWithinWindow: event 1 day after merge returns true (survived 13 days remaining)', () => {
  assert.equal(
    isWithinWindow('2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    true
  );
});

test('isWithinWindow: event 13 days after merge (1 day before boundary) returns true', () => {
  // merge: Jan 2, window end: Jan 16 (14 days later). 13 days after merge = Jan 15, which is <= Jan 16
  assert.equal(
    isWithinWindow('2026-01-15T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    true
  );
});

test('isWithinWindow: event exactly at window boundary returns true (inclusive)', () => {
  // merge: Jan 2, window end: Jan 16. Jan 16 <= Jan 16 → true
  assert.equal(
    isWithinWindow('2026-01-16T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    true
  );
});

test('isWithinWindow: event 15 days after merge (outside window) returns false', () => {
  // merge: Jan 2, window end: Jan 16. Jan 17 > Jan 16 → false
  assert.equal(
    isWithinWindow('2026-01-17T00:00:00Z', '2026-01-02T00:00:00Z', 14),
    false
  );
});

test('isWithinWindow: missing date returns false', () => {
  assert.equal(isWithinWindow(null, '2026-01-02T00:00:00Z', 14), false);
  assert.equal(isWithinWindow('2026-01-03T00:00:00Z', null, 14), false);
});

// ---------------------------------------------------------------------------
// buildTable
// ---------------------------------------------------------------------------

test('buildTable: empty runs produces empty table', () => {
  const table = buildTable([], 10);
  assert.equal(table.rows.length, 0);
  assert.equal(table.totalRuns, 0);
  assert.equal(table.schemaVersion, 1);
});

test('buildTable: computes survival rate correctly', () => {
  const runs = [
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' },
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' },
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'failed' },
  ];
  const table = buildTable(runs, 3);
  const row = table.rows.find(r => r.taskType === 'Bug Fix' && r.confidence === 'HIGH');
  assert.ok(row, 'Bug Fix × HIGH row should exist');
  assert.equal(row.survived, 2);
  assert.equal(row.failed, 1);
  assert.equal(row.sampleCount, 3);
  assert.ok(Math.abs(row.survivalRate - 2 / 3) < 0.001, 'survival rate should be ~0.667');
  assert.equal(row.trusted, true, 'should be trusted with 3 samples at minSamples=3');
});

test('buildTable: untrusted cell when below minSamples', () => {
  const runs = [
    { taskType: 'Feature', confidence: 'MEDIUM', outcome: 'survived' },
    { taskType: 'Feature', confidence: 'MEDIUM', outcome: 'survived' },
  ];
  const table = buildTable(runs, 10);
  const row = table.rows.find(r => r.taskType === 'Feature' && r.confidence === 'MEDIUM');
  assert.ok(row, 'row should exist');
  assert.equal(row.trusted, false, 'should be untrusted with 2 samples at minSamples=10');
  assert.equal(row.flag, null, 'untrusted cells should have no flag');
});

test('buildTable: flags overconfidence for HIGH < 0.8 survival', () => {
  // 7 survived, 3 failed out of 10 = 70% survival rate → below 0.8 → overconfidence
  const runs = Array.from({ length: 7 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' }))
    .concat(Array.from({ length: 3 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'failed' })));
  const table = buildTable(runs, 10);
  const row = table.rows.find(r => r.taskType === 'Bug Fix' && r.confidence === 'HIGH');
  assert.equal(row.flag, 'overconfidence', 'should flag overconfidence');
});

test('buildTable: no overconfidence flag for HIGH >= 0.8 survival', () => {
  // 9 survived, 1 failed out of 10 = 90% → no overconfidence flag
  const runs = Array.from({ length: 9 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' }))
    .concat(Array.from({ length: 1 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'failed' })));
  const table = buildTable(runs, 10);
  const row = table.rows.find(r => r.taskType === 'Bug Fix' && r.confidence === 'HIGH');
  assert.equal(row.flag, null, 'should not flag at 90% survival');
});

test('buildTable: flags overcaution-candidate for > 0.95 survival', () => {
  // 10 survived, 0 failed → 100% → overcaution-candidate
  const runs = Array.from({ length: 10 }, () => ({ taskType: 'Maintenance', confidence: 'LOW', outcome: 'survived' }));
  const table = buildTable(runs, 10);
  const row = table.rows.find(r => r.taskType === 'Maintenance' && r.confidence === 'LOW');
  assert.equal(row.flag, 'overcaution-candidate', 'should flag overcaution-candidate');
});

test('buildTable: multiple task types are separate cells', () => {
  const runs = [
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' },
    { taskType: 'Feature', confidence: 'HIGH', outcome: 'failed' },
    { taskType: 'Bug Fix', confidence: 'MEDIUM', outcome: 'survived' },
  ];
  const table = buildTable(runs, 1);
  assert.equal(table.rows.length, 3, 'should have 3 distinct cells');
  assert.equal(table.totalRuns, 3);
});

test('buildTable: skips runs with missing fields', () => {
  const runs = [
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' },
    { taskType: null, confidence: 'HIGH', outcome: 'survived' },  // missing taskType
    { taskType: 'Bug Fix', confidence: null, outcome: 'survived' },  // missing confidence
    { taskType: 'Bug Fix', confidence: 'HIGH', outcome: null },  // missing outcome
  ];
  const table = buildTable(runs, 1);
  // Only the first run is valid
  assert.equal(table.rows.length, 1, 'should have 1 cell (only valid run)');
});

// ---------------------------------------------------------------------------
// lookupCell
// ---------------------------------------------------------------------------

test('lookupCell: returns matching trusted cell', () => {
  const runs = Array.from({ length: 10 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' }));
  const table = buildTable(runs, 10);
  const cell = lookupCell(table, 'Bug Fix', 'HIGH');
  assert.ok(cell, 'should return a cell');
  assert.equal(cell.taskType, 'Bug Fix');
  assert.equal(cell.confidence, 'HIGH');
});

test('lookupCell: returns null for untrusted cell', () => {
  const runs = [{ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' }];
  const table = buildTable(runs, 10);  // minSamples=10, only 1 sample → untrusted
  const cell = lookupCell(table, 'Bug Fix', 'HIGH');
  assert.equal(cell, null, 'should return null for untrusted cell');
});

test('lookupCell: returns null for absent cell', () => {
  const table = buildTable([], 10);
  const cell = lookupCell(table, 'Bug Fix', 'HIGH');
  assert.equal(cell, null);
});

test('lookupCell: returns null on null table (fail-safe)', () => {
  assert.equal(lookupCell(null, 'Bug Fix', 'HIGH'), null);
  assert.equal(lookupCell(undefined, 'Bug Fix', 'HIGH'), null);
});

test('lookupCell: returns null on malformed table (fail-safe)', () => {
  assert.equal(lookupCell({ rows: null }, 'Bug Fix', 'HIGH'), null);
  assert.equal(lookupCell({}, 'Bug Fix', 'HIGH'), null);
});

// ---------------------------------------------------------------------------
// Sanity anchor: #1370/#1371 chain
// Verifies that the issue spec's sanity anchor scenario scores correctly.
// (Uses mock runs — cannot call real GitHub API in unit tests)
// ---------------------------------------------------------------------------

test('sanity anchor: #1370/#1371 HIGH-confidence failure scenario', () => {
  // Simulate the #1370/#1371 chain: HIGH-confidence fix was ineffective,
  // a review-finding landed on the same files within 14 days.
  // This should produce a 'failed' outcome and mark the cell as 'overconfidence'
  // if enough similar runs exist.
  const anchor = {
    issueNumber: 1370,
    taskType: 'Bug Fix',
    confidence: 'HIGH',
    outcome: 'failed',  // review-finding on same files within 14 days
    reason: 'review-finding #1370/#1371 created within 14 days (same files)',
  };

  // Build a table with 10 runs where 3 are failures (like #1370 chain)
  const runs = [
    ...Array.from({ length: 7 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'survived' })),
    ...Array.from({ length: 3 }, () => ({ taskType: 'Bug Fix', confidence: 'HIGH', outcome: 'failed' })),
  ];
  // Include the anchor run itself (it would come from the real corpus)
  runs.push({ taskType: anchor.taskType, confidence: anchor.confidence, outcome: anchor.outcome });

  const table = buildTable(runs, 10);
  const row = table.rows.find(r => r.taskType === 'Bug Fix' && r.confidence === 'HIGH');
  assert.ok(row, 'Bug Fix × HIGH cell should exist');
  assert.equal(row.trusted, true, 'should be trusted (11 samples)');
  // 7 survived / 11 total ≈ 0.636 < 0.8 → overconfidence flag
  assert.equal(row.flag, 'overconfidence', `should flag overconfidence (survival rate ${row.survivalRate})`);
});
