// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bitbucket.mjs - bitbucket-pipelines.yml -> normalised jobs. Pull-request (else default) pipeline, step/parallel/stage
// items, condition.changesets path filters, definition services on host networking. Pipes, deployments, manual
// triggers, OIDC and credential-like variables are deferred-to-ci.

import { Unsupported, branchMatches, matchesFilter, jobId, deferred, notApplicable, secretLikeVar, hostClass, DEPLOY_NAME } from '../lib.mjs';
import { stepsFromScript, loadDoc, parseSafe, baseJob, globList } from './common.mjs';

export const id = 'bitbucket';
export const DEF_RE = /^bitbucket-pipelines\.ya?ml$/;

function flatten(items, parallel = false, out = []) {
  for (const it of items || []) {
    if (it.step) out.push({ step: it.step, parallel });
    else if (it.parallel) flatten(Array.isArray(it.parallel) ? it.parallel : it.parallel.steps, true, out);
    else if (it.stage) flatten(it.stage.steps, parallel, out);
  }
  return out;
}

export function plan(a) {
  const out = []; const warnings = []; const used = [];
  for (const file of a.defFiles(DEF_RE)) {
    const doc = loadDoc(a, file, parseSafe);
    if (doc === undefined) { out.push(deferred(jobId('bitbucket', 'pipeline'), 'bitbucket', file, 'pipeline YAML unreadable')); continue; }
    if (!doc || !doc.pipelines) continue;
    used.push(file);
    let items = null; let which = 'default';
    const pr = doc.pipelines['pull-requests'];
    if (pr) for (const [pat, v] of Object.entries(pr)) if (branchMatches(a.headBranch || '', [pat])) { items = v; which = `pull-requests:${pat}`; break; }
    if (!items && Array.isArray(doc.pipelines.default)) items = doc.pipelines.default;
    if (!items) { out.push(notApplicable(jobId('bitbucket', 'pipeline'), 'bitbucket', file, 'no pull-request or default pipeline matches this branch')); continue; }
    const steps = flatten(items); let prev = []; let prevIds = [];
    steps.forEach((entry, idx) => {
      const s = entry.step; const name = s.name || `step-${idx + 1}`; const jid = jobId('bitbucket', which, String(idx + 1), name);
      const def = (r) => out.push(deferred(jid, 'bitbucket', name, r));
      const needs = entry.parallel ? prev : prevIds;
      const next = () => { if (!entry.parallel) { prevIds = [jid]; prev = [jid]; } else prev = prev.concat([jid]); };
      try {
        if (s.trigger === 'manual') { def('manual trigger'); next(); return; }
        if (s.deployment || DEPLOY_NAME.test(name)) { def('deployment step'); next(); return; }
        if (s.oidc) { def('OIDC token'); next(); return; }
        if (s['runs-on']) { def('self-hosted runner'); next(); return; }
        const inc = s.condition && s.condition.changesets && globList(s.condition.changesets.includePaths);
        if (inc && inc.length && a.changed.length && !a.changed.some((f) => matchesFilter(f, inc))) { out.push(notApplicable(jid, 'bitbucket', name, 'condition.changesets selects none of the changed files')); next(); return; }
        const script = s.script || [];
        if (script.some((l) => typeof l !== 'string')) { def('script uses a pipe'); next(); return; }
        const svcNames = (s.services || []).filter((x) => x !== 'docker');
        const services = svcNames.map((n) => { const d = doc.definitions && doc.definitions.services && doc.definitions.services[n]; if (!d || !d.image) throw new Unsupported(`service ${n}`); return { name: n, image: typeof d.image === 'string' ? d.image : d.image.name, env: d.variables || {}, ports: [], options: '', host_network: true }; });
        if (services.length && hostClass() !== 'linux') { def('service containers need host networking (Linux only)'); next(); return; }
        const sv = secretLikeVar(script.join('\n'));
        if (sv) { def(`references credential-like variable $${sv}`); next(); return; }
        const r = stepsFromScript(script.join('\n'), { name, cwd: '.', env: {}, repo: a.repo });
        if (r.defer) { def(r.defer); next(); return; }
        const env = { BITBUCKET_COMMIT: a.headSha, BITBUCKET_BRANCH: a.headBranch || '', BITBUCKET_PR_DESTINATION_BRANCH: a.baseBranch, BITBUCKET_CLONE_DIR: a.repo };
        out.push(baseJob({ id: jid, source: 'bitbucket', name, env, steps: r.steps, services, needs, timeout_s: s['max-time'] ? Number(s['max-time']) * 60 : undefined, warnings: s.image ? [`image ${typeof s.image === 'string' ? s.image : s.image.name} ignored; running with the host toolchain`] : [] }));
        next();
      } catch (e) { if (e instanceof Unsupported) { def(`unsupported construct: ${e.message}`); next(); return; } throw e; }
    });
  }
  return { jobs: out, warnings, used };
}
