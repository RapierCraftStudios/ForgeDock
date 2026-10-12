// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// github-actions.mjs - GitHub Actions workflows -> normalised jobs.
// Reads workflows from the base ref (trusted) plus the PR's own edits, applies on.pull_request/push path filters,
// dorny/paths-filter outputs and job `if:` conditions, and defers anything that cannot be proven locally.

import path from 'node:path';
import {
  Unsupported, Degraded, parseYaml, branchMatches, matchesFilter, evalExpr, interpolate, condTrue, hostClass, jobId, deferred, notApplicable,
  SECRET_REF, DEPLOY_NAME, commandExists, run, majorOf,
} from '../lib.mjs';
import { stepsFromScript, shellArgv } from './common.mjs';

export const id = 'github-actions';
export const DEF_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

const NOOP_ACTIONS = /^(actions\/checkout|actions\/cache(\/(restore|save))?|actions\/upload-artifact|step-security\/harden-runner|Swatinem\/rust-cache)(@|$)/;
const SETUP = {
  'actions/setup-node': { tool: 'node', key: 'node-version', local: () => process.version },
  'actions/setup-python': { tool: 'python3', key: 'python-version', local: () => run('python3', ['--version']).out.trim() },
  'actions/setup-go': { tool: 'go', key: 'go-version', local: () => run('go', ['version']).out.trim() },
  'actions/setup-java': { tool: 'java', key: 'java-version', local: () => { const r = run('java', ['-version']); return (r.err + r.out).split('\n')[0]; } },
  'actions/setup-dotnet': { tool: 'dotnet', key: 'dotnet-version', local: () => run('dotnet', ['--version']).out.trim() },
  'ruby/setup-ruby': { tool: 'ruby', key: 'ruby-version', local: () => run('ruby', ['--version']).out.trim() },
  'oven-sh/setup-bun': { tool: 'bun', key: 'bun-version', local: () => run('bun', ['--version']).out.trim() },
  'astral-sh/setup-uv': { tool: 'uv', key: 'version', local: () => run('uv', ['--version']).out.trim() },
  'pnpm/action-setup': { tool: 'pnpm', key: 'version', local: () => run('pnpm', ['--version']).out.trim() },
  'dtolnay/rust-toolchain': { tool: 'cargo', key: 'toolchain', local: () => run('cargo', ['--version']).out.trim() },
  'shivammathur/setup-php': { tool: 'php', key: 'php-version', local: () => run('php', ['--version']).out.split('\n')[0] },
  'denoland/setup-deno': { tool: 'deno', key: 'deno-version', local: () => run('deno', ['--version']).out.split('\n')[0] },
};
const SHELLCHECK_ACTIONS = /^(ludeeus\/action-shellcheck|reviewdog\/action-shellcheck)(@|$)/;

function events(on) {
  if (on === undefined || on === null) return {};
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
  return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v && typeof v === 'object' ? v : {}]));
}

function pathsOk(cfg, changed) {
  if (!changed.length) return true;
  if (Array.isArray(cfg.paths)) return changed.some((f) => matchesFilter(f, cfg.paths));
  if (Array.isArray(cfg['paths-ignore'])) return changed.some((f) => !matchesFilter(f, cfg['paths-ignore']));
  return true;
}

function branchOk(cfg, branch) {
  if (Array.isArray(cfg.branches)) return branchMatches(branch, cfg.branches);
  if (Array.isArray(cfg['branches-ignore'])) return !branchMatches(branch, cfg['branches-ignore']);
  return true;
}

// Does this workflow gate a pull request into the base branch? Returns '' when yes, else the reason it does not.
function gateReason(ev, a) {
  const names = Object.keys(ev);
  if (ev.pull_request) {
    const c = ev.pull_request;
    if (!branchOk(c, a.baseBranch)) return `pull_request branches filter excludes base ${a.baseBranch}`;
    if (!pathsOk(c, a.changed)) return 'pull_request path filter selects none of the changed files';
    return '';
  }
  if (ev.push) {
    const c = ev.push;
    if (Array.isArray(c.tags) && !Array.isArray(c.branches) && !Array.isArray(c['branches-ignore'])) return 'push is tag-only';
    if (!branchOk(c, a.headBranch || '')) return `push branches filter excludes ${a.headBranch}`;
    if (!pathsOk(c, a.changed)) return 'push path filter selects none of the changed files';
    return '';
  }
  return `not a pull-request gate (events: ${names.join(', ') || 'none'})`;
}

function mergeDocs(baseText, headText) {
  const b = baseText != null ? safe(baseText) : null; const h = headText != null ? safe(headText) : null;
  if (b === undefined || h === undefined) return undefined;
  if (!b) return h; if (!h) return b;
  return { ...h, jobs: { ...(b.jobs || {}), ...(h.jobs || {}) } };
}
function safe(t) { try { return parseYaml(t); } catch (e) { if (e instanceof Degraded) throw e; return undefined; } }

function topo(jobs) {
  const ids = Object.keys(jobs); const done = new Set(); const out = [];
  const needsOf = (j) => [].concat(jobs[j].needs || []).filter((n) => typeof n === 'string');
  let guard = ids.length + 2;
  while (out.length < ids.length && guard-- > 0) for (const j of ids) if (!done.has(j) && needsOf(j).every((n) => done.has(n) || !(n in jobs))) { done.add(j); out.push(j); }
  for (const j of ids) if (!done.has(j)) out.push(j); // cycles: processed last, deferred by missing needs
  return out;
}

function expandMatrix(m, ctx) {
  if (m === undefined || m === null) return [{}];
  if (typeof m === 'string') throw new Unsupported('dynamic matrix');
  const base = {}; for (const [k, v] of Object.entries(m)) if (!['include', 'exclude'].includes(k)) { let val = v; if (typeof val === 'string') val = interpolate(val, ctx); if (!Array.isArray(val)) throw new Unsupported('dynamic matrix axis ' + k); base[k] = val; }
  let combos = [{}];
  for (const [k, vals] of Object.entries(base)) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  if (!Object.keys(base).length) combos = [];
  const ex = Array.isArray(m.exclude) ? m.exclude : [];
  combos = combos.filter((c) => !ex.some((e) => Object.entries(e).every(([k, v]) => c[k] === v)));
  for (const inc of Array.isArray(m.include) ? m.include : []) {
    const keys = Object.keys(inc).filter((k) => k in base);
    const targets = combos.filter((c) => keys.every((k) => c[k] === inc[k]));
    if (keys.length && targets.length) for (const t of targets) for (const [k, v] of Object.entries(inc)) if (!(k in base)) t[k] = v;
    else combos.push({ ...inc });
    if (!keys.length) combos.push({ ...inc });
  }
  return combos.length ? combos : [{}];
}

function osClass(runsOn) {
  const labels = [].concat(runsOn && runsOn.labels ? runsOn.labels : runsOn).filter((x) => typeof x === 'string').map((x) => x.toLowerCase());
  if (!labels.length) return { reason: 'runs-on missing' };
  if (labels.includes('self-hosted') || (runsOn && runsOn.group)) return { reason: 'self-hosted runner' };
  for (const l of labels) { if (/windows/.test(l)) return { os: 'win32', label: l }; if (/macos|mac-?os/.test(l)) return { os: 'darwin', label: l }; if (/ubuntu|linux|debian|arm64|x64/.test(l)) return { os: 'linux', label: l }; }
  return { reason: `unknown runner label ${labels.join(',')}` };
}
function hostRuns(os) { const h = hostClass(); return os === 'linux' ? h === 'linux' || h === 'darwin' : os === h; }

function versionNote(action, step, ctx) {
  const spec = SETUP[action]; if (!spec) return '';
  const want = interpolate(String((step.with || {})[spec.key] ?? ''), ctx);
  if (!want || /lts|latest|stable|nightly|[<>~^*]|file/i.test(want) || /^\W*$/.test(want)) return '';
  const w = majorOf(want); if (w === null) return '';
  const l = majorOf(spec.local() || '');
  return l !== null && l !== w ? `${action} wants ${spec.key} ${want}; local is ${String(spec.local()).slice(0, 40)} (major differs)` : '';
}

function shellcheckStep(action, step, ctx, a) {
  const w = step.with || {};
  const isLudeeus = action.startsWith('ludeeus');
  const dir = String(interpolate(String(isLudeeus ? (w.scandir || '.') : (w.path || '.')), ctx)).replace(/^\.\//, '') || '.';
  const ign = String(w.ignore_paths || w.exclude || '').split(/\s+/).filter(Boolean).map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''));
  const ignNames = String(w.ignore_names || '').split(/\s+/).filter(Boolean);
  const extra = String(w.additional_files || '').split(/\s+/).filter(Boolean);
  const sev = isLudeeus ? w.severity : null;
  const files = a.tracked.filter((f) => /\.(sh|bash|ksh)$/.test(f) && (dir === '.' || f === dir || f.startsWith(dir.replace(/\/$/, '') + '/')) && !ign.some((p) => f === p || f.startsWith(p + '/')) && !ignNames.includes(path.posix.basename(f)));
  for (const f of extra) if (a.tracked.includes(f) && !files.includes(f)) files.push(f);
  const flags = [];
  if (sev) flags.push('-S', String(sev));
  if (!isLudeeus && w.shellcheck_flags !== '') flags.push(...String(w.shellcheck_flags ?? '--external-sources').split(/\s+/).filter(Boolean));
  if (isLudeeus && w.shellcheck_opts) flags.push(...String(w.shellcheck_opts).split(/\s+/).filter(Boolean));
  if (!commandExists('shellcheck')) return { missing: 'shellcheck' };
  if (!files.length) return { noop: true, note: `no shell files under ${dir}` };
  return { command: ['shellcheck', ...flags, ...files.sort()].map((t) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`)).join(' ') };
}

// dorny/paths-filter: evaluate each filter against the changed files; returns { name: 'true'|'false', changes: json }.
function pathsFilterOutputs(step, ctx, a) {
  const w = step.with || {};
  let text = w.filters;
  if (typeof text !== 'string') throw new Unsupported('paths-filter without inline filters');
  text = interpolate(text, ctx);
  if (!/\n/.test(text) && /\.ya?ml$/.test(text.trim())) {
    const f = text.trim().replace(/^\.\//, '');
    const body = a.readDefs(f); const t = body.head != null ? body.head : body.base;
    if (t == null) throw new Unsupported('paths-filter file ' + f);
    text = t;
  }
  const doc = parseYaml(text);
  if (!doc || typeof doc !== 'object') throw new Unsupported('paths-filter filters unreadable');
  const out = {}; const hit = [];
  const flat = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : []);
  for (const [name, spec] of Object.entries(doc)) {
    const pats = flat(spec);
    const ok = a.changed.some((f) => matchesFilter(f, pats));
    out[name] = ok ? 'true' : 'false'; if (ok) hit.push(name);
  }
  out.changes = JSON.stringify(hit);
  return out;
}

function parseServices(svcs, ctx) {
  const out = [];
  for (const [name, s] of Object.entries(svcs || {})) {
    if (!s || typeof s.image !== 'string') throw new Unsupported('service without image');
    if (s.credentials) throw new Unsupported('service credentials');
    const env = {}; for (const [k, v] of Object.entries(s.env || {})) env[k] = String(interpolate(String(v), ctx));
    out.push({ name, image: String(interpolate(s.image, ctx)), env, ports: (s.ports || []).map(String), options: s.options ? String(interpolate(String(s.options), ctx)) : '' });
  }
  return out;
}

export function plan(a) {
  const jobsOut = []; const warnings = []; const used = [];
  const files = a.defFiles(DEF_RE);
  for (const file of files) {
    const { base, head } = a.readDefs(file);
    const doc = mergeDocs(base, head);
    const wfName = path.posix.basename(file).replace(/\.ya?ml$/, '');
    if (doc === undefined) { warnings.push(`${file}: unreadable YAML; its jobs are deferred-to-ci`); jobsOut.push(deferred(jobId('gha', wfName), 'github-actions', file, 'workflow YAML unreadable')); continue; }
    if (!doc || typeof doc !== 'object' || !doc.jobs) continue;
    used.push(file);
    const ev = events(doc.on !== undefined ? doc.on : doc.true);
    if (ev.pull_request_target) { jobsOut.push(deferred(jobId('gha', wfName), 'github-actions', doc.name || file, 'pull_request_target workflow runs with base-branch secrets')); continue; }
    const why = gateReason(ev, a);
    if (why) { jobsOut.push(notApplicable(jobId('gha', wfName), 'github-actions', doc.name || file, why)); continue; }
    planWorkflow(file, wfName, doc, a, jobsOut, warnings);
  }
  return { jobs: jobsOut, warnings, used };
}

function planWorkflow(file, wfName, doc, a, out, warnings) {
  const wfEnv = doc.env || {};
  const base = { github: { event_name: 'pull_request', base_ref: a.baseBranch, head_ref: a.headBranch || '', ref: `refs/heads/${a.headBranch || ''}`, ref_name: a.headBranch || '', ref_type: 'branch', sha: a.headSha, repository: a.repository || '', workspace: a.repo, event: { pull_request: { base: { sha: a.baseSha, ref: a.baseBranch, repo: { full_name: a.repository || '' } }, head: { sha: a.headSha, ref: a.headBranch || '', repo: { fork: false, full_name: a.repository || '' } }, draft: false, labels: [] } } }, runner: { os: { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[hostClass()], arch: process.arch === 'arm64' ? 'ARM64' : 'X64', temp: process.env.TMPDIR || '/tmp' } };
  const jobs = doc.jobs; const results = {}; // jobKey -> { status, outputs }
  const planOne = (key) => {
    const job = jobs[key] || {};
    const jid = jobId('gha', wfName, key);
    let name = key;
    const needs = [].concat(job.needs || []).filter((n) => typeof n === 'string');
    const baseCtx = { ...base, env: {}, needs: {}, steps: undefined };
    for (const n of needs) if (results[n] && results[n].outputs) baseCtx.needs[n] = { outputs: results[n].outputs, result: results[n].status === 'applicable' ? 'success' : 'skipped' };
    try { if (typeof job.name === 'string') name = String(interpolate(job.name, { ...baseCtx, matrix: undefined })) || key; } catch { name = job.name; }
    const def = (reason, extra) => { out.push(deferred(jid, 'github-actions', name, reason, { needs: needs.map((n) => jobId('gha', wfName, n)), ...extra })); results[key] = { status: 'deferred', outputs: null }; };
    const na = (reason) => { out.push(notApplicable(jid, 'github-actions', name, reason)); results[key] = { status: 'skipped', outputs: {} }; };

    try {
      // needs: a deferred or missing dependency means the job cannot be proven here
      const badNeed = needs.find((n) => !results[n] || results[n].status === 'deferred');
      const skipNeed = needs.find((n) => results[n] && results[n].status === 'skipped');
      if (badNeed && !(typeof job.if === 'string' && /always\(\)/.test(job.if))) return def(`needs ${badNeed}, which is not run locally`);
      if (skipNeed && !(typeof job.if === 'string' && /always\(\)/.test(job.if))) return na(`needs ${skipNeed}, which was skipped`);
      if (job.uses) return def('reusable workflow job');
      if (job.container) return def('job runs in a container');
      if (job.environment) return def('environment-protected job (deploy)');
      if (job.if !== undefined && !condTrue(job.if, { ...baseCtx, env: wfEnv })) return na(`job if: ${String(job.if).trim().slice(0, 80)} is false`);
      if (DEPLOY_NAME.test(key) || DEPLOY_NAME.test(String(job.name || ''))) return def('deploy/publish job');
      const scanJob = JSON.stringify({ ...job, steps: (job.steps || []).map((s) => (s && s.uses && (NOOP_ACTIONS.test(s.uses) || SETUP[String(s.uses).split('@')[0]]) ? { ...s, with: undefined } : s)) });
      if (SECRET_REF.test(scanJob) || SECRET_REF.test(JSON.stringify(wfEnv))) return def('references secrets');
      if (job.permissions && job.permissions['id-token'] === 'write') return def('requests an OIDC token');

      const matrixCtx = { ...baseCtx, env: wfEnv };
      const combos = expandMatrix(job.strategy && job.strategy.matrix, matrixCtx);
      const variants = []; let chosen = null;
      for (const combo of combos) {
        const cctx = { ...baseCtx, matrix: combo, env: wfEnv };
        let ro = job['runs-on']; if (typeof ro === 'string') ro = interpolate(ro, cctx); else if (Array.isArray(ro)) ro = ro.map((x) => interpolate(x, cctx));
        const c = osClass(ro);
        const tag = Object.keys(combo).length ? Object.entries(combo).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(',') : '';
        if (c.reason) { variants.push(`${tag || 'default'}: ${c.reason}`); continue; }
        if (!hostRuns(c.os)) { variants.push(`${tag || c.label}: ${c.label} (host is ${hostClass()})`); continue; }
        if (chosen) { variants.push(`${tag || c.label}: matrix variant not run locally`); continue; }
        chosen = { combo, ctx: cctx, tag };
      }
      if (!chosen && combos.length === 1) return def(variants[0].replace(/^[^:]*: /, ''));
      if (variants.length) out.push(deferred(jobId(jid, 'variants'), 'github-actions', name, `${variants.length} variant(s) not run on this host: ${variants.slice(0, 3).join('; ')}${variants.length > 3 ? '; ...' : ''}`, { variants: variants.length }));
      if (!chosen) { results[key] = { status: 'deferred', outputs: null }; return; }
      const built = buildJob(file, wfName, key, jid, name, job, doc, chosen, needs, wfEnv, a, warnings);
      if (built.defer) return def(built.defer);
      results[key] = { status: 'applicable', outputs: built.outputs };
      out.push(built.job);
    } catch (e) {
      if (e instanceof Unsupported) return def(`unsupported construct: ${e.message}`);
      throw e;
    }
  };
  for (const key of topo(jobs)) planOne(key);
}

function buildJob(file, wfName, key, jid, name, job, doc, chosen, needs, wfEnv, a, warnings) {
  const ctx = chosen.ctx;
  const jobEnvRaw = { ...wfEnv, ...(job.env || {}) };
  const env = {};
  for (const [k, v] of Object.entries(jobEnvRaw)) env[k] = String(interpolate(String(v), ctx));
  ctx.env = env;
  const defaults = { ...(doc.defaults && doc.defaults.run), ...(job.defaults && job.defaults.run) };
  const steps = []; const notes = []; const stepsCtx = {}; ctx.steps = stepsCtx;
  const toolWarn = [];
  let outputs = {};
  for (const [i, st] of (job.steps || []).entries()) {
    if (!st) continue;
    if (st.if !== undefined && !condTrue(st.if, ctx)) continue;
    const label = st.name ? String(interpolate(String(st.name), ctx)) : (st.uses ? String(st.uses) : `step ${i + 1}`);
    const senv = {}; for (const [k, v] of Object.entries(st.env || {})) senv[k] = String(interpolate(String(v), ctx));
    if (st.uses) {
      const action = String(st.uses).split('@')[0];
      if (NOOP_ACTIONS.test(String(st.uses))) continue;
      if (SETUP[action]) {
        if (!commandExists(SETUP[action].tool)) return { defer: `toolchain not installed locally: ${SETUP[action].tool} (${action})` };
        const n = versionNote(action, st, ctx); if (n) toolWarn.push(n);
        continue;
      }
      if (/^dorny\/paths-filter$/.test(action)) { stepsCtx[st.id || `step${i}`] = { outputs: pathsFilterOutputs(st, ctx, a) }; continue; }
      if (SHELLCHECK_ACTIONS.test(String(st.uses))) {
        const sc = shellcheckStep(action, st, ctx, a);
        if (sc.missing) return { defer: `tool not installed: ${sc.missing}` };
        if (sc.noop) continue;
        steps.push({ name: label, command: sc.command, cwd: '.', env: { ...senv }, shell: 'bash', kind: 'check' });
        continue;
      }
      return { defer: `unknown action ${st.uses}` };
    }
    if (typeof st.run === 'string') {
      const script = String(interpolate(st.run, ctx));
      const cwd = st['working-directory'] || defaults['working-directory'] || '.';
      const shell = st.shell || defaults.shell;
      if (!shellArgv(shell)) return { defer: `shell ${shell} is not available locally` };
      const r = stepsFromScript(script, { name: label, cwd: String(interpolate(String(cwd), ctx)), env: senv, shell, repo: a.repo, continue_on_error: st['continue-on-error'] === true, timeout_s: st['timeout-minutes'] ? Number(st['timeout-minutes']) * 60 : undefined });
      if (r.defer) return { defer: r.defer };
      steps.push(...r.steps);
      continue;
    }
    return { defer: `unsupported step shape at index ${i}` };
  }
  // job outputs resolved from dorny steps (the `changes` job pattern)
  for (const [k, v] of Object.entries(job.outputs || {})) { try { outputs[k] = String(interpolate(String(v), ctx)); } catch { /* left unresolved: needs.X.outputs.k is Unsupported downstream */ } }
  if (!steps.length && !Object.keys(outputs).length && !(job.steps || []).length) return { defer: 'job has no steps' };
  let services = [];
  if (job.services) services = parseServices(job.services, ctx);
  warnings.push(...toolWarn.map((w) => `${jid}: ${w}`));
  const timeout_s = job['timeout-minutes'] ? Number(job['timeout-minutes']) * 60 : undefined;
  const j = { id: jid, source: 'github-actions', name, workflow: file, cwd: '.', env, services, steps, needs: needs.map((n) => jobId('gha', wfName, n)), timeout_s, matrix: chosen.tag || undefined, deferred_reason: null, warnings: toolWarn, resolves_outputs: Object.keys(outputs).length > 0 && !steps.length };
  if (!steps.length) { j.not_applicable = Object.keys(outputs).length ? 'resolved locally (path-filter outputs only)' : 'no runnable steps'; }
  return { job: j, outputs };
}
