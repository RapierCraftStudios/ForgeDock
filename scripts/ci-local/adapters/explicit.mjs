// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// explicit.mjs - commands the operator declared in forge.yaml -> verification.ci_local.extra_commands.
// Always merged into the plan. verification.commands is NOT repeated here: validate V2 already runs it as the fast pre-step.

import { jobId } from '../lib.mjs';
import { baseJob, stepsFromScript } from './common.mjs';

export const id = 'explicit';

export function plan(a) {
  const jobs = [];
  (a.config.extra_commands || []).forEach((c, i) => {
    const cmd = typeof c === 'string' ? c : c && c.command; if (!cmd) return;
    const name = typeof c === 'object' && c.name ? String(c.name) : cmd.split('\n')[0].slice(0, 60);
    const r = stepsFromScript(String(cmd), { name, cwd: '.', env: {}, repo: a.repo });
    jobs.push(baseJob({ id: jobId('explicit', String(i + 1)), source: 'explicit', name, steps: r.steps }));
  });
  return { jobs, warnings: [], used: [] };
}
