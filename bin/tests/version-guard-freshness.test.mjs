// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const versionGuard = fs.readFileSync(path.join(root, '.github/workflows/version-guard.yml'), 'utf8');
const publish = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
const checkCommands = fs.readFileSync(path.join(root, '.github/workflows/check-commands.yml'), 'utf8');

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return 'failure';
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] < parsedRight[index]) return 'failure';
    if (parsedLeft[index] > parsedRight[index]) return 'success';
  }
  return 'success';
}

function revalidate(baseVersion, headVersion, priorStatus = 'success') {
  const statuses = [{ state: priorStatus, baseVersion, headVersion }];
  statuses.push({ state: 'pending', baseVersion, headVersion });
  statuses.push({
    state: compareVersions(headVersion, baseVersion),
    baseVersion,
    headVersion,
  });
  return statuses;
}

test('base-only advancement invalidates a prior green result before revalidation', () => {
  const headSha = 'a'.repeat(40);
  const statuses = revalidate('1.8.0', '1.7.1');

  assert.deepEqual(statuses.map((status) => status.state), ['success', 'pending', 'failure']);
  assert.equal(statuses[1].headVersion, '1.7.1');
  assert.equal(headSha.length, 40);
  assert.equal(statuses.at(-1).baseVersion, '1.8.0');
});

test('fresh comparison passes equal and newer versions and blocks lower versions', () => {
  assert.equal(compareVersions('1.7.1', '1.8.0'), 'failure');
  assert.equal(compareVersions('1.8.0', '1.8.0'), 'success');
  assert.equal(compareVersions('1.8.1', '1.8.0'), 'success');
});

test('missing, malformed, and non-semver metadata fails closed', () => {
  assert.equal(compareVersions(undefined, '1.8.0'), 'failure');
  assert.equal(compareVersions('1.8.0', null), 'failure');
  assert.equal(compareVersions('not-json', '1.8.0'), 'failure');
  assert.equal(compareVersions('1.8', '1.8.0'), 'failure');
});

test('version guard has one exact-head, status-backed freshness contract', () => {
  for (const required of [
    'workflow_dispatch:',
    'expected_head_sha:',
    'expected_base_sha:',
    'concurrency:',
    'cancel-in-progress: true',
    'contents: read',
    'pull-requests: read',
    'statuses: write',
    'STATUS_CONTEXT: forgedock/version-guard',
    'contents/package.json?ref=${ref}',
    'Mark current PR head pending',
    'Revalidate refs before final status',
  ]) {
    assert.match(versionGuard, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.ok(versionGuard.indexOf('Mark current PR head pending') < versionGuard.indexOf('Compare head against current main'));
  assert.ok(versionGuard.indexOf('Compare head against current main') < versionGuard.indexOf('Publish final freshness status'));
  assert.doesNotMatch(versionGuard, /actions\/checkout/);
  assert.doesNotMatch(versionGuard, /pull_request_target/);
  assert.doesNotMatch(versionGuard, /npm (ci|install|publish)/);
});

test('publisher invalidates and dispatches every open main-targeting PR after pushing main', () => {
  const pushIndex = publish.indexOf('- name: Push version bump');
  const handoffIndex = publish.indexOf('- name: Revalidate open deploy PRs after main advances');
  assert.ok(pushIndex >= 0);
  assert.ok(handoffIndex > pushIndex);

  for (const required of [
    'actions: write',
    'pull-requests: read',
    'statuses: write',
    'repos/${REPOSITORY}/pulls?state=open&base=main&per_page=100',
    'state=pending',
    'context="${STATUS_CONTEXT}"',
    'gh workflow run version-guard.yml',
    'expected_head_sha=${HEAD_SHA}',
    'expected_base_sha=${BASE_SHA}',
    "if: always() && github.ref == 'refs/heads/main'",
    ".github/workflows/version-guard.yml",
    ".github/workflows/check-commands.yml",
  ]) {
    assert.match(publish, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('command checks run freshness coverage when either workflow or the test wiring changes', () => {
  const expectedPaths = [
    '.github/workflows/version-guard.yml',
    '.github/workflows/publish.yml',
    'bin/tests/version-guard-freshness.test.mjs',
    '.github/workflows/check-commands.yml',
  ];
  const pullRequestPaths = checkCommands.slice(checkCommands.indexOf('  pull_request:'), checkCommands.indexOf('  push:'));
  const pushPaths = checkCommands.slice(checkCommands.indexOf('  push:'), checkCommands.indexOf('\n\nconcurrency:'));

  for (const file of expectedPaths) {
    assert.match(pullRequestPaths, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(pushPaths, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(checkCommands, /node --test bin\/tests\/version-guard-freshness\.test\.mjs/);
});
