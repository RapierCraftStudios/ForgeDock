// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// cli.mjs - node entry behind scripts/ci-local.sh. Subcommands: plan, run.
// Exit codes: 0 pass, 1 a runnable job failed, 2 degraded or usage error (the gate could not run; never a pass).

import fs from 'node:fs';
import { Degraded } from './lib.mjs';
import { buildPlan, summarizePlan } from './plan.mjs';

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const take = () => { if (i + 1 >= argv.length) throw new Error(`${t} needs a value`); return argv[++i]; };
    if (t === '--repo') o.repo = take(); else if (t === '--base') o.base = take(); else if (t === '--base-branch') o.baseBranch = take();
    else if (t === '--head-branch') o.headBranch = take(); else if (t === '--files') o.files = take().split(/[\n ]+/).filter(Boolean);
    else if (t === '--files-from') o.files = fs.readFileSync(take(), 'utf8').split('\n').filter(Boolean);
    else if (t === '--out') o.out = take(); else if (t === '--plan') o.planFile = take(); else if (t === '--no-cache') o.noCache = true;
    else if (t === '--budget-minutes') o.budgetMinutes = Number(take()); else if (t === '--max-parallel') o.maxParallel = Number(take());
    else if (t === '--json') o.json = true; else if (t === '--result-file') o.resultFile = take(); else if (t === '--iteration') o.iteration = Number(take());
    else if (t === '--cache-dir') o.cacheDir = take(); else if (t === '--result-cache-dir') o.resultCacheDir = take();
    else if (t.startsWith('-')) throw new Error(`unknown option ${t}`); else o._.push(t);
  }
  return o;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (!['plan', 'run'].includes(sub)) { console.error('usage: ci-local.sh plan|run --repo PATH --base REF [--files "a b"] [--out FILE]'); return 2; }
  if (!o.repo) { console.error('ci-local: --repo is required'); return 2; }
  let plan;
  if (sub === 'run' && o.planFile) plan = JSON.parse(fs.readFileSync(o.planFile, 'utf8'));
  else plan = buildPlan(o);
  if (sub === 'plan') {
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(plan, null, 2));
    if (o.json) console.log(JSON.stringify(plan, null, 2)); else for (const l of summarizePlan(plan)) console.log(l);
    return 0;
  }
  const { runPlan } = await import('./run.mjs');
  return runPlan(plan, o);
}

// process.exitCode (not process.exit) so a large stdout pipe is flushed before the process ends.
main().then((c) => { process.exitCode = c; }, (e) => {
  const msg = String((e && e.message) || e).split('\n')[0];
  if (!(e instanceof Degraded)) console.error(`ci-local: ${msg}`);
  console.log(`CI_LOCAL_RESULT: DEGRADED reason=${msg}`); process.exitCode = 2;
});
