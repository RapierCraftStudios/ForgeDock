// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './_tmp.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'build-knowledge-index.mjs');
const hasYq = spawnSync('yq', ['--version']).status === 0;

function run(yaml, extra = []) {
  const dir = tmpDir('bki-repo-');
  if (yaml !== null) writeFileSync(join(dir, 'forge.yaml'), yaml);
  return spawnSync('node', [SCRIPT, '--issue', '1', '--dry-run', '--no-mirror', ...extra], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, FORGE_REPO_PATH: dir, FORGE_DEBUG: '' },
  });
}

function assertCleanFailure(r) {
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cannot determine GitHub repo/);
  assert.match(r.stderr, /--repo/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
}

test('EDGE-e1 missing forge.yaml and no --repo exits 1 with a clean message', () => {
  assertCleanFailure(run(null));
});

test('EDGE-e2 partial forge.yaml (owner only) is unresolved, not "/"', { skip: !hasYq }, () => {
  const r = run('project:\n  owner: acme\n');
  assertCleanFailure(r);
  assert.doesNotMatch(r.stderr, /repo: acme\/|repo: \//);
});

test('empty owner and repo are unresolved', { skip: !hasYq }, () => {
  assertCleanFailure(run('project:\n  owner: ""\n  repo: ""\n'));
});

test('EDGE-e5 explicit --repo overrides a missing forge.yaml', () => {
  const r = run(null, ['--repo', 'acme/widgets']);
  assert.doesNotMatch(r.stderr, /Cannot determine GitHub repo/);
});
