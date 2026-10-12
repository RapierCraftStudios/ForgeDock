// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// task-runners.mjs - repos with no CI definition that gates the change: derive the check set from the repo's own
// task runners and tool configuration (package.json scripts, Makefile, justfile, Taskfile, tox/nox, pre-commit,
// pyproject tools, Cargo, Go, Maven, Gradle). Only lint/test/check style tasks; never build/deploy/publish.

import fs from 'node:fs';
import path from 'node:path';
import { jobId } from '../lib.mjs';
import { parseSafe, baseJob } from './common.mjs';
import { stepsFromScript } from './common.mjs';

export const id = 'task-runners';
const NODE_SCRIPTS = ['lint', 'test', 'typecheck', 'type-check', 'check', 'tsc', 'format:check', 'test:unit'];
const TASK_NAMES = ['test', 'lint', 'check', 'ci', 'verify'];

const read = (a, f) => { try { return fs.readFileSync(path.join(a.repo, f), 'utf8'); } catch { return null; } };
const has = (a, f) => fs.existsSync(path.join(a.repo, f));

function mk(a, kind, name, command, extra = {}) {
  const r = stepsFromScript(command, { name, cwd: '.', env: {}, repo: a.repo });
  const steps = [...(extra.pre || []), ...r.steps];
  return baseJob({ id: jobId('task', kind, name), source: 'task-runners', name: `${kind}: ${name}`, steps, warnings: [] });
}

export function plan(a) {
  const jobs = []; const used = [];
  const add = (j) => jobs.push(j);

  const pjText = read(a, 'package.json');
  if (pjText) {
    let pj = null; try { pj = JSON.parse(pjText); } catch { /* malformed */ }
    const pm = has(a, 'pnpm-lock.yaml') ? 'pnpm' : has(a, 'yarn.lock') ? 'yarn' : (has(a, 'bun.lock') || has(a, 'bun.lockb')) ? 'bun' : 'npm';
    if (pj && pj.scripts) {
      used.push('package.json');
      const install = !has(a, 'node_modules') ? [{ name: 'install dependencies', command: pm === 'npm' ? (has(a, 'package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`, cwd: '.', env: {}, kind: 'install' }] : [];
      for (const s of NODE_SCRIPTS) if (typeof pj.scripts[s] === 'string' && !/^\s*echo\b.*(no test|not specified)/i.test(pj.scripts[s]) && !/Error: no test specified/.test(pj.scripts[s])) add(mk(a, pm, s, s === 'test' && pm === 'npm' ? 'npm test' : `${pm} run ${s}`, { pre: install }));
    }
  }
  const mf = read(a, 'Makefile') || read(a, 'makefile') || read(a, 'GNUmakefile');
  if (mf) { used.push('Makefile'); for (const t of TASK_NAMES) if (new RegExp(`^${t}\\s*:`, 'm').test(mf)) add(mk(a, 'make', t, `make ${t}`)); }
  const jf = read(a, 'justfile') || read(a, 'Justfile');
  if (jf) { used.push('justfile'); for (const t of TASK_NAMES) if (new RegExp(`^${t}\\b[^\\n:]*:`, 'm').test(jf)) add(mk(a, 'just', t, `just ${t}`)); }
  const tf = read(a, 'Taskfile.yml') || read(a, 'Taskfile.yaml');
  if (tf) { const d = parseSafe(tf); used.push('Taskfile'); if (d && d.tasks) for (const t of TASK_NAMES) if (d.tasks[t]) add(mk(a, 'task', t, `task ${t}`)); }
  if (has(a, 'tox.ini')) { used.push('tox.ini'); add(mk(a, 'python', 'tox', 'tox -q')); }
  if (has(a, 'noxfile.py')) { used.push('noxfile.py'); add(mk(a, 'python', 'nox', 'nox')); }
  const py = read(a, 'pyproject.toml');
  if (py) {
    used.push('pyproject.toml');
    if (/^\[tool\.ruff/m.test(py)) add(mk(a, 'python', 'ruff', 'ruff check .'));
    if (/^\[tool\.black/m.test(py)) add(mk(a, 'python', 'black', 'black --check .'));
    if (/^\[tool\.pytest/m.test(py) || has(a, 'pytest.ini')) add(mk(a, 'python', 'pytest', 'pytest'));
    if (/^\[tool\.mypy/m.test(py)) add(mk(a, 'python', 'mypy', 'mypy .'));
  } else if (has(a, 'pytest.ini')) add(mk(a, 'python', 'pytest', 'pytest'));
  if (has(a, '.pre-commit-config.yaml')) {
    used.push('.pre-commit-config.yaml');
    const files = a.changed.filter((f) => has(a, f));
    if (files.length) { const j = mk(a, 'pre-commit', 'run', 'pre-commit run --files ' + files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')); j.steps.forEach((s) => { s.prescoped = true; }); add(j); }
  }
  if (has(a, 'Cargo.toml')) { used.push('Cargo.toml'); add(mk(a, 'cargo', 'test', 'cargo test')); }
  if (has(a, 'go.mod')) { used.push('go.mod'); add(mk(a, 'go', 'vet', 'go vet ./...')); add(mk(a, 'go', 'test', 'go test ./...')); }
  if (has(a, 'pom.xml')) { used.push('pom.xml'); add(mk(a, 'maven', 'test', 'mvn -q -B test')); }
  if (has(a, 'build.gradle') || has(a, 'build.gradle.kts')) { used.push('gradle'); add(mk(a, 'gradle', 'test', has(a, 'gradlew') ? './gradlew test' : 'gradle test')); }
  return { jobs, warnings: [], used };
}
