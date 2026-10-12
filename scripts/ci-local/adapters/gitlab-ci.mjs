// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gitlab-ci.mjs - .gitlab-ci.yml (+ local includes) -> normalised jobs. Merge-request pipeline semantics:
// rules/only/except with changes: path filters, stages and needs ordering, extends, variables. Services, triggers,
// environments, manual jobs and credential-like variables are deferred-to-ci.

import path from 'node:path';
import { Unsupported, matchesFilter, branchMatches, jobId, deferred, notApplicable, parseDuration, secretLikeVar, DEPLOY_NAME } from '../lib.mjs';
import { stepsFromScript, loadDoc, parseSafe, deepMerge, baseJob, globList } from './common.mjs';

export const id = 'gitlab-ci';
export const DEF_RE = /^\.gitlab-ci\.ya?ml$/;
const RESERVED = new Set(['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'before_script', 'after_script', 'cache', 'artifacts', 'pages', 'spec', 'inputs']);

// --- minimal GitLab rules:if evaluator ($VAR, strings, ==, !=, =~, !~, &&, ||, !, parens, null) ---
function evalRule(src, vars) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '$') { const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(src.slice(i)); if (!m) throw new Unsupported('rule syntax'); toks.push({ t: 'var', v: m[1] }); i += m[0].length; continue; }
    if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new Unsupported('rule string'); toks.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if (c === '/') { const m = /^\/((?:\\.|[^/\\])*)\/([a-z]*)/.exec(src.slice(i)); if (!m) throw new Unsupported('rule regex'); toks.push({ t: 're', v: new RegExp(m[1], m[2].replace(/[^imsu]/g, '')) }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '=~', '!~', '&&', '||'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()!'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (/^null\b/.test(src.slice(i))) { toks.push({ t: 'null' }); i += 4; continue; }
    throw new Unsupported('rule token ' + c);
  }
  let p = 0;
  const val = (t) => (t.t === 'var' ? (t.v in vars ? vars[t.v] : (() => { throw new Unsupported('variable $' + t.v); })()) : t.t === 'null' ? null : t.t === 'str' ? t.v : t.t === 're' ? t.v : (() => { throw new Unsupported('rule operand'); })());
  function prim() {
    const t = toks[p++]; if (!t) throw new Unsupported('rule end');
    if (t.t === 'op' && t.v === '(') { const v = or(); if (!(toks[p] && toks[p].v === ')')) throw new Unsupported('rule )'); p++; return v; }
    if (t.t === 'op' && t.v === '!') return !prim();
    const l = val(t); const n = toks[p];
    if (n && n.t === 'op' && ['==', '!=', '=~', '!~'].includes(n.v)) {
      p++; const r = val(toks[p++]);
      if (n.v === '==') return (l === null ? null : l) === (r === null ? null : r);
      if (n.v === '!=') return l !== r;
      const hit = l !== null && r instanceof RegExp && r.test(String(l)); return n.v === '=~' ? hit : !hit;
    }
    return l !== null && l !== '';
  }
  function and() { let l = prim(); while (toks[p] && toks[p].v === '&&') { p++; const r = prim(); l = l && r; } return l; }
  function or() { let l = and(); while (toks[p] && toks[p].v === '||') { p++; const r = and(); l = l || r; } return l; }
  const v = or(); if (p < toks.length) throw new Unsupported('rule trailing'); return !!v;
}

function refMatches(ref, a) {
  if (typeof ref !== 'string') return false;
  if (ref === 'merge_requests' || ref === 'branches' || ref === 'pushes' || ref === 'external_pull_requests') return true;
  if (['tags', 'schedules', 'api', 'triggers', 'web', 'pipelines', 'chat'].includes(ref)) return false;
  const m = /^\/(.*)\/([a-z]*)$/.exec(ref);
  return m ? new RegExp(m[1], m[2]).test(a.headBranch || '') : branchMatches(a.headBranch || '', [ref]);
}

function resolveExtends(name, jobs, depth = 0) {
  const j = jobs[name]; if (!j || typeof j !== 'object') throw new Unsupported(`extends target ${name}`);
  if (depth > 6) throw new Unsupported('extends depth');
  let merged = {};
  for (const e of [].concat(j.extends || [])) merged = deepMerge(merged, resolveExtends(e, jobs, depth + 1));
  const own = { ...j }; delete own.extends;
  return deepMerge(merged, own);
}

function loadWithIncludes(a, file, seen = new Set(), depth = 0) {
  const doc = loadDoc(a, file, parseSafe);
  if (doc === undefined) return undefined;
  if (!doc || typeof doc !== 'object') return doc;
  let merged = {};
  const warn = [];
  for (const inc of [].concat(doc.include || [])) {
    const loc = typeof inc === 'string' ? inc : inc && inc.local;
    if (!loc || /^https?:/.test(loc)) { warn.push(`include not resolved: ${typeof inc === 'string' ? inc : JSON.stringify(inc).slice(0, 60)}`); continue; }
    const f = loc.replace(/^\//, '');
    if (seen.has(f) || depth > 3) continue; seen.add(f);
    const sub = loadWithIncludes(a, f, seen, depth + 1);
    if (sub && typeof sub === 'object') { warn.push(...(sub.__warnings || [])); delete sub.__warnings; merged = deepMerge(merged, sub); }
  }
  const out = deepMerge(merged, doc); delete out.include; out.__warnings = warn; return out;
}

export function plan(a) {
  const out = []; const warnings = []; const used = [];
  for (const file of a.defFiles(DEF_RE)) {
    const doc = loadWithIncludes(a, file);
    if (doc === undefined) { out.push(deferred(jobId('gitlab', 'pipeline'), 'gitlab-ci', file, 'pipeline YAML unreadable')); continue; }
    if (!doc || typeof doc !== 'object') continue;
    used.push(file);
    for (const w of doc.__warnings || []) warnings.push(`${file}: ${w} (jobs from it are not in the plan)`);
    const stages = Array.isArray(doc.stages) ? doc.stages : ['.pre', 'build', 'test', 'deploy', '.post'];
    const gvars = vars(doc.variables); const defaults = doc.default || {};
    const defined = new Set([...Object.keys(gvars)]);
    const names = Object.keys(doc).filter((k) => !RESERVED.has(k) && !k.startsWith('.') && !k.startsWith('__') && doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k]));
    const results = {}; const byStage = {};
    for (const name of names) {
      const jid = jobId('gitlab', name);
      let job;
      try { job = doc[name].extends ? resolveExtends(name, doc) : doc[name]; } catch (e) { if (e instanceof Unsupported) { out.push(deferred(jid, 'gitlab-ci', name, e.message)); results[name] = 'deferred'; continue; } throw e; }
      if (!job.script && !job.trigger && !job.run) continue;
      const stage = job.stage || 'test';
      const env = { ...gvars, ...vars(job.variables) };
      const ctxVars = { CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: a.baseBranch, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: a.headBranch || '', CI_COMMIT_BRANCH: null, CI_COMMIT_TAG: null, CI_COMMIT_REF_NAME: a.headBranch || '', CI_COMMIT_SHA: a.headSha, ...env };
      const def = (r) => { out.push(deferred(jid, 'gitlab-ci', name, r)); results[name] = 'deferred'; };
      const na = (r) => { out.push(notApplicable(jid, 'gitlab-ci', name, r)); results[name] = 'skipped'; };
      try {
        const gate = gating(job, ctxVars, a);
        if (gate.na) { na(gate.na); continue; }
        if (gate.defer) { def(gate.defer); continue; }
        if (job.trigger) { def('trigger (child/multi-project pipeline)'); continue; }
        if (job.environment) { def('deploy environment'); continue; }
        if (job.secrets || job.id_tokens) { def('uses CI secrets / OIDC tokens'); continue; }
        if (DEPLOY_NAME.test(name) || stage === 'deploy') { def('deploy/publish job'); continue; }
        const services = job.services || defaults.services;
        if (services && services.length) { def('service containers need docker network aliases (not reproduced on the host)'); continue; }
        const lines = [].concat(defaults.before_script || [], job.before_script || [], job.script || []);
        if (lines.some((l) => typeof l !== 'string')) { def('script uses !reference or nested lists'); continue; }
        const sv = secretLikeVar(lines.join('\n'), defined) || secretLikeVar(JSON.stringify(env), defined);
        if (/CI_JOB_TOKEN|CI_REGISTRY_PASSWORD/.test(lines.join('\n'))) { def('uses CI_JOB_TOKEN / registry credentials'); continue; }
        if (sv) { def(`references credential-like variable $${sv}`); continue; }
        const warn = []; const image = job.image || defaults.image;
        if (image) warn.push(`image ${typeof image === 'string' ? image : image.name} ignored; running with the host toolchain`);
        let matrix; let variants = 0;
        if (job.parallel && typeof job.parallel === 'object' && job.parallel.matrix) {
          const combos = job.parallel.matrix.flatMap((m) => Object.entries(m).reduce((acc, [k, v]) => acc.flatMap((c) => [].concat(v).map((x) => ({ ...c, [k]: String(x) }))), [{}]));
          Object.assign(env, combos[0] || {}); matrix = Object.entries(combos[0] || {}).map(([k, v]) => `${k}=${v}`).join(','); variants = combos.length - 1;
        }
        Object.assign(env, { CI_PROJECT_DIR: a.repo, CI_COMMIT_SHA: a.headSha, CI_COMMIT_REF_NAME: a.headBranch || '', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: a.baseBranch, CI_PIPELINE_SOURCE: 'merge_request_event', CI_JOB_NAME: name });
        const r = stepsFromScript(lines.join('\n'), { name, cwd: '.', env: {}, repo: a.repo, continue_on_error: job.allow_failure === true, timeout_s: parseDuration(job.timeout) });
        if (r.defer) { def(r.defer); continue; }
        const needs = job.needs !== undefined ? [].concat(job.needs).map((n) => (typeof n === 'string' ? n : n && n.job)).filter(Boolean).map((n) => jobId('gitlab', n)) : null;
        const j = baseJob({ id: jid, source: 'gitlab-ci', name, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), steps: r.steps, warnings: warn, matrix, needs: needs || [], timeout_s: parseDuration(job.timeout) });
        j._stage = stage; j._explicitNeeds = needs !== null;
        (byStage[stage] = byStage[stage] || []).push(j);
        results[name] = 'applicable'; out.push(j);
        if (variants) out.push(deferred(jobId(jid, 'variants'), 'gitlab-ci', name, `${variants} parallel:matrix variant(s) not run locally`));
      } catch (e) { if (e instanceof Unsupported) { def(`unsupported construct: ${e.message}`); continue; } throw e; }
    }
    // stage ordering: a job without explicit needs waits for every runnable job of earlier stages
    for (const jobs of Object.values(byStage)) for (const j of jobs) {
      if (j._explicitNeeds) { delete j._stage; delete j._explicitNeeds; continue; }
      const idx = stages.indexOf(j._stage);
      j.needs = Object.entries(byStage).filter(([s]) => stages.indexOf(s) < idx && stages.indexOf(s) >= 0).flatMap(([, js]) => js.map((x) => x.id));
      delete j._stage; delete j._explicitNeeds;
    }
  }
  return { jobs: out, warnings, used };
}

function vars(v) { const o = {}; for (const [k, x] of Object.entries(v || {})) o[k] = x && typeof x === 'object' ? String(x.value ?? '') : String(x ?? ''); return o; }

function changesOk(list, a) { const pats = globList(list && list.paths ? list.paths : list); return !a.changed.length || a.changed.some((f) => matchesFilter(f, pats)); }

// -> { na } | { defer } | {} (job is selected)
function gating(job, v, a) {
  if (job.when === 'manual' || job.when === 'delayed') return { defer: `when: ${job.when}` };
  if (job.when === 'never') return { na: 'when: never' };
  if (Array.isArray(job.rules)) {
    for (const r of job.rules) {
      if (r.if !== undefined && !evalRule(String(r.if), v)) continue;
      if (r.changes !== undefined && !changesOk(r.changes, a)) continue;
      if (r.exists !== undefined) throw new Unsupported('rules:exists');
      if (r.when === 'never') return { na: 'matched a when: never rule' };
      if (r.when === 'manual' || r.when === 'delayed') return { defer: `rule when: ${r.when}` };
      return {};
    }
    return { na: 'no rule selects this merge-request pipeline' };
  }
  if (job.only !== undefined) {
    const o = Array.isArray(job.only) ? { refs: job.only } : job.only;
    const refs = globList(o.refs || (Array.isArray(job.only) ? job.only : []));
    if (refs.length && !refs.some((x) => refMatches(x, a))) return { na: 'only: refs do not select this pipeline' };
    if (o.changes && !changesOk(o.changes, a)) return { na: 'only: changes selects none of the changed files' };
  }
  if (job.except !== undefined) {
    const o = Array.isArray(job.except) ? { refs: job.except } : job.except;
    const refs = globList(o.refs || (Array.isArray(job.except) ? job.except : []));
    if (refs.some((x) => refMatches(x, a))) return { na: 'except: refs exclude this pipeline' };
    if (o.changes && changesOk(o.changes, a)) return { na: 'except: changes excludes this pipeline' };
  }
  return {};
}
