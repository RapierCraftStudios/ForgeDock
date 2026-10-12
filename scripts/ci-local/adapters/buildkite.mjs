// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// buildkite.mjs - .buildkite/pipeline.yml -> normalised jobs. Command steps, wait barriers, groups, branch filters and
// simple `if:` conditions. Plugins, block/input/trigger steps, buildkite-agent calls, parallelism/matrix and
// credential-like variables are deferred-to-ci.

import { Unsupported, evalExpr, branchMatches, jobId, deferred, notApplicable, secretLikeVar, hostClass, DEPLOY_NAME } from '../lib.mjs';
import { stepsFromScript, loadDoc, parseSafe, baseJob } from './common.mjs';

export const id = 'buildkite';
export const DEF_RE = /^(\.buildkite\/pipeline\.ya?ml|buildkite\.ya?ml)$/;

function flat(steps, out = []) { for (const s of steps || []) { if (s && s.group) flat(s.steps, out); else out.push(s); } return out; }

export function plan(a) {
  const out = []; const warnings = []; const used = [];
  for (const file of a.defFiles(DEF_RE)) {
    const doc = loadDoc(a, file, parseSafe);
    if (doc === undefined) { out.push(deferred(jobId('buildkite', 'pipeline'), 'buildkite', file, 'pipeline YAML unreadable')); continue; }
    if (!doc || !Array.isArray(doc.steps)) continue;
    used.push(file);
    const roots = { build: { branch: a.headBranch || '', source: 'webhook', pull_request: { id: '1', base_branch: a.baseBranch }, tag: '', message: '', commit: a.headSha }, pipeline: { slug: 'local' } };
    const keys = {}; let barrier = []; const emitted = [];
    const items = flat(doc.steps);
    items.forEach((s, idx) => {
      if (typeof s === 'string' || (s && (s.wait !== undefined || s.waiter !== undefined))) { barrier = emitted.slice(); return; }
      if (!s) return;
      const label = String(s.label || s.name || (typeof s.block === 'string' ? s.block : '') || (typeof s.input === 'string' ? s.input : '') || s.key || `step-${idx + 1}`); const jid = jobId('buildkite', s.key || String(idx + 1), label);
      if (s.key) keys[s.key] = jid;
      const def = (r) => { out.push(deferred(jid, 'buildkite', label, r)); emitted.push(jid); };
      try {
        if (s.block || s.input || s.trigger) { def('block/input/trigger step'); return; }
        if (s.command === undefined && s.commands === undefined) return;
        if (s.skip) { out.push(notApplicable(jid, 'buildkite', label, 'skip is set')); return; }
        if (s.branches && !branchMatches(a.headBranch || '', String(s.branches).split(/\s+/).filter(Boolean))) { out.push(notApplicable(jid, 'buildkite', label, 'branches filter excludes this branch')); return; }
        if (s.if !== undefined && !Boolean(evalExpr(String(s.if).replace(/"([^"]*)"/g, "'$1'"), { __roots: roots }))) { out.push(notApplicable(jid, 'buildkite', label, 'if: is false')); return; }
        if (s.plugins && (Array.isArray(s.plugins) ? s.plugins.length : Object.keys(s.plugins).length)) { def('uses plugins (docker/containers)'); return; }
        const ag = s.agents || {}; const agOs = String(Array.isArray(ag) ? '' : ag.os || '').toLowerCase();
        if (agOs && agOs !== hostClass() && !(agOs === 'linux' && hostClass() === 'darwin')) { def(`agent os=${agOs}`); return; }
        if (s.parallelism || s.matrix) { def('parallelism/matrix step'); return; }
        if (DEPLOY_NAME.test(label)) { def('deploy/publish step'); return; }
        const cmds = [].concat(s.commands || s.command).map(String);
        if (cmds.some((c) => /buildkite-agent/.test(c))) { def('uses buildkite-agent'); return; }
        const env = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, String(v)]));
        const sv = secretLikeVar(cmds.join('\n'), new Set(Object.keys(env)));
        if (sv) { def(`references credential-like variable $${sv}`); return; }
        const r = stepsFromScript(cmds.join('\n'), { name: label, cwd: '.', env: {}, repo: a.repo, continue_on_error: s.soft_fail === true, timeout_s: s.timeout_in_minutes ? Number(s.timeout_in_minutes) * 60 : undefined });
        if (r.defer) { def(r.defer); return; }
        const needs = (s.depends_on !== undefined ? [].concat(s.depends_on).map((k) => keys[typeof k === 'string' ? k : k && k.step]).filter(Boolean) : barrier);
        Object.assign(env, { BUILDKITE_BRANCH: a.headBranch || '', BUILDKITE_COMMIT: a.headSha, BUILDKITE_BUILD_CHECKOUT_PATH: a.repo, BUILDKITE_PULL_REQUEST_BASE_BRANCH: a.baseBranch });
        out.push(baseJob({ id: jid, source: 'buildkite', name: label, env, steps: r.steps, needs, timeout_s: s.timeout_in_minutes ? Number(s.timeout_in_minutes) * 60 : undefined }));
        emitted.push(jid);
      } catch (e) { if (e instanceof Unsupported) { def(`unsupported construct: ${e.message}`); return; } throw e; }
    });
  }
  return { jobs: out, warnings, used };
}
