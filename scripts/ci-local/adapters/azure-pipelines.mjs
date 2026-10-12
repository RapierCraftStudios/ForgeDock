// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// azure-pipelines.mjs - azure-pipelines.yml -> normalised jobs. pr: triggers, stages/jobs/steps, script/bash steps,
// a small set of known no-op tasks, $(Var) macros from declared and predefined variables. Templates, deployment jobs,
// variable groups, container jobs and unknown tasks are deferred-to-ci.

import os from 'node:os';
import { Unsupported, branchMatches, matchesFilter, jobId, deferred, notApplicable, hostClass, DEPLOY_NAME } from '../lib.mjs';
import { stepsFromScript, loadDoc, parseSafe, baseJob } from './common.mjs';

export const id = 'azure-pipelines';
export const DEF_RE = /^azure-pipelines\.ya?ml$/;
const NOOP_TASKS = /^(NodeTool|UsePythonVersion|GoTool|JavaToolInstaller|UseDotNet|Cache|PublishBuildArtifacts|PublishTestResults|PublishCodeCoverageResults|PublishPipelineArtifact)@/;

function varMap(v) {
  const m = {}; if (!v) return m;
  if (Array.isArray(v)) { for (const x of v) { if (x.group) throw new Unsupported('variable group'); if (x.template) throw new Unsupported('variable template'); if (x.name) m[x.name] = String(x.value ?? ''); } } else for (const [k, x] of Object.entries(v)) m[k] = String(x && typeof x === 'object' ? x.value ?? '' : x);
  return m;
}

function expandMacros(text, vars) {
  if (/\$\{\{/.test(text)) throw new Unsupported('compile-time ${{ }} expression');
  return String(text).replace(/\$\(([A-Za-z0-9_.]+)\)/g, (_, n) => { if (n in vars) return vars[n]; throw new Unsupported(`variable $(${n})`); });
}

function prOk(doc, a) {
  const pr = doc.pr;
  if (pr === 'none' || pr === false) return 'pr: none';
  if (pr === undefined || pr === null) return '';
  const br = Array.isArray(pr) ? { include: pr } : (pr.branches || {});
  if (br.include && !branchMatches(a.baseBranch, [].concat(br.include))) return `pr branches exclude base ${a.baseBranch}`;
  if (br.exclude && branchMatches(a.baseBranch, [].concat(br.exclude))) return `pr branches exclude base ${a.baseBranch}`;
  if (pr.paths && a.changed.length) {
    const inc = pr.paths.include || []; const exc = pr.paths.exclude || [];
    if (!a.changed.some((f) => (!inc.length || matchesFilter(f, inc)) && !matchesFilter(f, exc.length ? exc : ['\0']))) return 'pr paths select none of the changed files';
  }
  return '';
}

function condOk(cond) {
  if (cond === undefined) return true;
  const c = String(cond).replace(/\s+/g, '');
  if (/^(succeeded\(\)|succeeded\('[^']*'\)|always\(\)|succeededOrFailed\(\))$/.test(c)) return true;
  if (/^eq\(variables\['Build\.Reason'\],'PullRequest'\)$/.test(c)) return true;
  if (/^ne\(variables\['Build\.Reason'\],'(Manual|Schedule|IndividualCI|BatchedCI)'\)$/.test(c)) return true;
  if (/^(eq|ne)\(variables\['Build\.Reason'\],/.test(c)) return false;
  throw new Unsupported('condition ' + String(cond).slice(0, 60));
}

function osOf(pool) { const img = String((pool && (pool.vmImage || pool.name)) || '').toLowerCase(); if (/windows/.test(img)) return 'win32'; if (/mac/.test(img)) return 'darwin'; if (/ubuntu|linux/.test(img)) return 'linux'; return ''; }
const runnable = (o) => (o === 'linux' ? hostClass() !== 'win32' : o === hostClass());

export function plan(a) {
  const out = []; const warnings = []; const used = [];
  for (const file of a.defFiles(DEF_RE)) {
    const doc = loadDoc(a, file, parseSafe);
    if (doc === undefined) { out.push(deferred(jobId('azure', 'pipeline'), 'azure-pipelines', file, 'pipeline YAML unreadable')); continue; }
    if (!doc || typeof doc !== 'object') continue;
    used.push(file);
    const why = prOk(doc, a);
    if (why) { out.push(notApplicable(jobId('azure', 'pipeline'), 'azure-pipelines', file, why)); continue; }
    let gvars;
    try { gvars = varMap(doc.variables); } catch (e) { out.push(deferred(jobId('azure', 'pipeline'), 'azure-pipelines', file, e.message)); continue; }
    const jobs = [];
    if (Array.isArray(doc.stages)) for (const st of doc.stages) for (const j of st.jobs || []) jobs.push({ j, pool: doc.pool, stage: st.stage });
    else if (Array.isArray(doc.jobs)) for (const j of doc.jobs) jobs.push({ j, pool: doc.pool });
    else if (Array.isArray(doc.steps)) jobs.push({ j: { job: 'build', steps: doc.steps }, pool: doc.pool });
    for (const { j, pool, stage } of jobs) {
      const key = j.job || j.deployment || j.template || 'job';
      const jid = jobId('azure', stage || '', key); const name = j.displayName || key;
      const def = (r) => out.push(deferred(jid, 'azure-pipelines', name, r));
      try {
        if (j.template) { def('job template'); continue; }
        if (j.deployment) { def('deployment job'); continue; }
        if (j.container || j.services) { def('container/service job'); continue; }
        if (DEPLOY_NAME.test(key)) { def('deploy/publish job'); continue; }
        if (!condOk(j.condition)) { out.push(notApplicable(jid, 'azure-pipelines', name, 'condition is false for pull requests')); continue; }
        const jvars = { ...gvars, ...varMap(j.variables) };
        const p = j.pool || pool; const o = osOf(p);
        if (!o) { def('unknown agent pool'); continue; }
        if (!runnable(o)) { def(`${o} agent (host is ${hostClass()})`); continue; }
        const pre = { 'Build.SourcesDirectory': a.repo, 'Build.Repository.LocalPath': a.repo, 'Build.SourceVersion': a.headSha, 'Build.SourceBranch': `refs/heads/${a.headBranch || ''}`, 'Build.SourceBranchName': a.headBranch || '', 'System.PullRequest.TargetBranch': a.baseBranch, 'System.PullRequest.SourceBranch': a.headBranch || '', 'Build.Reason': 'PullRequest', 'Agent.OS': { linux: 'Linux', darwin: 'Darwin', win32: 'Windows_NT' }[hostClass()], 'Agent.TempDirectory': os.tmpdir(), 'Pipeline.Workspace': a.repo, 'Build.ArtifactStagingDirectory': os.tmpdir() };
        const vars = { ...pre, ...jvars };
        let combos = [{}]; let tag; let variants = 0;
        const mx = j.strategy && j.strategy.matrix;
        if (mx && typeof mx === 'object') { const ks = Object.keys(mx); combos = ks.map((k) => ({ __n: k, ...mx[k] })); variants = combos.length - 1; tag = ks[0]; }
        const env = {}; for (const [k, v] of Object.entries(combos[0])) if (k !== '__n') { env[k] = String(v); vars[k] = String(v); }
        const steps = []; let defer = '';
        for (const s of j.steps || []) {
          if (s.condition !== undefined && !condOk(s.condition)) continue;
          if (s.template || s.download || s.getPackage) { defer = defer || 'step template/download'; break; }
          if (s.checkout !== undefined) continue;
          if (s.task) {
            if (NOOP_TASKS.test(s.task)) continue;
            if (/^Npm@1$/.test(s.task) && s.inputs && ['ci', 'install'].includes(s.inputs.command || 'install')) { steps.push({ name: s.displayName || 'npm ' + (s.inputs.command || 'install'), command: 'npm ' + (s.inputs.command || 'install'), cwd: '.', env: {}, kind: 'install' }); continue; }
            defer = defer || `unknown task ${s.task}`; break;
          }
          const body = s.script ?? s.bash;
          if (body === undefined) { defer = defer || (s.pwsh || s.powershell ? 'PowerShell step' : 'unsupported step'); break; }
          const sh = s.bash !== undefined ? 'bash' : undefined;
          const r = stepsFromScript(expandMacros(body, vars), { name: s.displayName || 'script', cwd: s.workingDirectory ? expandMacros(s.workingDirectory, vars) : '.', env: Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, expandMacros(v, vars)])), shell: sh, repo: a.repo, continue_on_error: s.continueOnError === true });
          if (r.defer) { defer = defer || r.defer; break; }
          steps.push(...r.steps);
        }
        if (defer) { def(defer); continue; }
        out.push(baseJob({ id: jid, source: 'azure-pipelines', name, env: { ...env, BUILD_SOURCESDIRECTORY: a.repo }, steps, needs: [].concat(j.dependsOn || []).map((d) => jobId('azure', stage || '', d)), matrix: tag, timeout_s: j.timeoutInMinutes ? Number(j.timeoutInMinutes) * 60 : undefined }));
        if (variants) out.push(deferred(jobId(jid, 'variants'), 'azure-pipelines', name, `${variants} matrix variant(s) not run locally`));
      } catch (e) { if (e instanceof Unsupported) { def(`unsupported construct: ${e.message}`); continue; } throw e; }
    }
  }
  return { jobs: out, warnings, used };
}
