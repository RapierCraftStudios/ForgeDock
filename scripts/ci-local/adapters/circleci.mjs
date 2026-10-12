// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// circleci.mjs - .circleci/config.yml -> normalised jobs. Workflow job lists, branch filters, requires ordering,
// commands/executors with simple parameters, docker service containers (host network). Contexts (secrets), orbs,
// approvals, macOS executors off macOS, add_ssh_keys and deploy-named jobs are deferred-to-ci.

import { Unsupported, branchMatches, jobId, deferred, notApplicable, secretLikeVar, DEPLOY_NAME, hostClass, parseDuration } from '../lib.mjs';
import { stepsFromScript, loadDoc, parseSafe, baseJob } from './common.mjs';

export const id = 'circleci';
export const DEF_RE = /^\.circleci\/config\.ya?ml$/;
const NOOP = new Set(['checkout', 'restore_cache', 'save_cache', 'persist_to_workspace', 'attach_workspace', 'store_artifacts', 'store_test_results', 'setup_remote_docker']);

function subst(text, params) {
  return String(text).replace(/<<\s*parameters\.([A-Za-z0-9_-]+)\s*>>/g, (_, k) => { if (!(k in params)) throw new Unsupported(`parameter ${k}`); return String(params[k]); })
    .replace(/<<\s*(pipeline|[^>\s]+)[^>]*>>/g, (m) => { throw new Unsupported(`template ${m.slice(0, 40)}`); });
}

function expand(steps, doc, params, depth, out) {
  if (depth > 4) throw new Unsupported('command nesting');
  for (const st of steps || []) {
    if (typeof st === 'string') { if (NOOP.has(st)) continue; if (doc.commands && doc.commands[st]) { expand(doc.commands[st].steps, doc, defaultsOf(doc.commands[st], {}), depth + 1, out); continue; } throw new Unsupported(`step ${st}`); }
    const [k] = Object.keys(st); const v = st[k];
    if (NOOP.has(k)) continue;
    if (k === 'run') {
      const o = typeof v === 'string' ? { command: v } : v;
      if (o.when === 'on_fail' || o.when === 'never') continue;
      out.push({ name: o.name || 'run', command: subst(o.command, params), env: Object.fromEntries(Object.entries(o.environment || {}).map(([a, b]) => [a, subst(b, params)])), wd: o.working_directory ? subst(o.working_directory, params) : '.' });
      continue;
    }
    if (doc.commands && doc.commands[k]) { expand(doc.commands[k].steps, doc, defaultsOf(doc.commands[k], v || {}), depth + 1, out); continue; }
    throw new Unsupported(`step ${k}`);
  }
}
function defaultsOf(def, args) { const p = {}; for (const [k, d] of Object.entries(def.parameters || {})) p[k] = k in args ? args[k] : d && d.default; for (const [k, v] of Object.entries(args)) p[k] = v; return p; }

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, redis: 6379, mongo: 27017, rabbitmq: 5672, memcached: 11211, elasticsearch: 9200 };
export function declaredPorts(d) {
  if (Array.isArray(d.ports) && d.ports.length) return d.ports.map((p) => (/^\d+$/.test(String(p)) ? `${p}:${p}` : String(p)));
  const base = String(d.image || '').split('/').pop().split(':')[0].replace(/^cimg-/, '');
  const hit = DEFAULT_PORTS[base] || DEFAULT_PORTS[String(d.image || '').split('/').pop().split(':')[0]];
  return hit ? [`${hit}:${hit}`] : [];
}

export function plan(a) {
  const out = []; const warnings = []; const used = [];
  for (const file of a.defFiles(DEF_RE)) {
    const doc = loadDoc(a, file, parseSafe);
    if (doc === undefined) { out.push(deferred(jobId('circleci', 'config'), 'circleci', file, 'config YAML unreadable')); continue; }
    if (!doc || !doc.jobs) continue;
    used.push(file);
    if (doc.orbs) warnings.push(`${file}: orbs declared; jobs/commands from orbs are deferred-to-ci`);
    const entries = [];
    const wfs = Object.entries(doc.workflows || {}).filter(([k]) => k !== 'version');
    if (!wfs.length && doc.jobs.build) entries.push({ job: 'build', name: 'build', cfg: {} });
    for (const [wn, wf] of wfs) {
      if (wf.when !== undefined || wf.unless !== undefined) { out.push(deferred(jobId('circleci', wn), 'circleci', wn, 'workflow when/unless conditions are not evaluated')); continue; }
      for (const item of wf.jobs || []) {
        const [jn, cfg] = typeof item === 'string' ? [item, {}] : [Object.keys(item)[0], Object.values(item)[0] || {}];
        entries.push({ job: jn, name: cfg.name || jn, cfg, wf: wn });
      }
    }
    const nameToId = {}; for (const e of entries) nameToId[e.name] = jobId('circleci', e.wf || '', e.name);
    for (const e of entries) {
      const jid = nameToId[e.name]; const jobDef = doc.jobs[e.job];
      const def = (r) => out.push(deferred(jid, 'circleci', e.name, r));
      try {
        if (!jobDef) { def(`job ${e.job} defined by an orb or missing`); continue; }
        const f = e.cfg.filters && e.cfg.filters.branches;
        if (f && ((f.only && !branchMatches(a.headBranch || '', [].concat(f.only))) || (f.ignore && branchMatches(a.headBranch || '', [].concat(f.ignore))))) { out.push(notApplicable(jid, 'circleci', e.name, 'branch filter excludes this branch')); continue; }
        if (e.cfg.context) { def('uses a context (secrets)'); continue; }
        if (e.cfg.type === 'approval') { def('approval gate'); continue; }
        if (e.cfg.matrix) { def('matrix job'); continue; }
        if (DEPLOY_NAME.test(e.job)) { def('deploy/publish job'); continue; }
        let exec = jobDef; if (jobDef.executor) { const ex = typeof jobDef.executor === 'string' ? jobDef.executor : jobDef.executor.name; if (!doc.executors || !doc.executors[ex]) { def(`executor ${ex} is not defined in this file`); continue; } exec = { ...doc.executors[ex], ...jobDef }; }
        if (exec.macos && hostClass() !== 'darwin') { def('macOS executor'); continue; }
        if (exec.machine && exec.machine.image && /windows/i.test(exec.machine.image)) { def('Windows executor'); continue; }
        const params = defaultsOf(jobDef, Object.fromEntries(Object.entries(e.cfg).filter(([k]) => !['requires', 'filters', 'context', 'name', 'type', 'matrix'].includes(k))));
        const steps = []; expand(jobDef.steps, doc, params, 0, steps);
        if (jobDef.steps.some((s) => s && typeof s === 'object' && Object.keys(s)[0] === 'add_ssh_keys')) { def('add_ssh_keys'); continue; }
        const services = [];
        // forge#4040 (SEC-6): secondary containers never use host networking. Each runs on a per-job docker network and only
        // its declared ports (a `ports:` list, else the image's well-known default) are published on 127.0.0.1.
        if (Array.isArray(exec.docker) && exec.docker.length > 1) for (const d of exec.docker.slice(1)) services.push({ name: String(d.name || d.image).replace(/[^A-Za-z0-9_.-]/g, '-'), image: d.image, env: d.environment || {}, ports: declaredPorts(d), options: '' });
        { const blind = services.filter((sv) => !sv.ports.length); if (blind.length) { def(`unknown service ports: ${blind.map((sv) => sv.image).join(', ')} (no ports: declared and no well-known default; unreachable without host networking)`); continue; } }
        const env = Object.fromEntries(Object.entries({ ...(exec.environment || {}), ...(exec.docker && exec.docker[0] ? exec.docker[0].environment || {} : {}) }).map(([k, v]) => [k, subst(v, params)]));
        const defined = new Set(Object.keys(env));
        const all = steps.map((s) => s.command).join('\n');
        const sv = secretLikeVar(all, defined);
        if (sv) { def(`references credential-like variable $${sv}`); continue; }
        Object.assign(env, { CIRCLE_BRANCH: a.headBranch || '', CIRCLE_SHA1: a.headSha, CIRCLE_WORKING_DIRECTORY: a.repo, CIRCLE_JOB: e.job });
        const built = []; let defer = '';
        for (const s of steps) { const r = stepsFromScript(s.command, { name: s.name, cwd: s.wd, env: s.env, repo: a.repo }); if (r.defer) defer = defer || r.defer; built.push(...r.steps); }
        if (defer) { def(defer); continue; }
        out.push(baseJob({ id: jid, source: 'circleci', name: e.name, env, steps: built, services, needs: (e.cfg.requires || []).map((r) => nameToId[r]).filter(Boolean), timeout_s: parseDuration(jobDef.no_output_timeout) }));
      } catch (err) { if (err instanceof Unsupported) { def(`unsupported construct: ${err.message}`); continue; } throw err; }
    }
  }
  return { jobs: out, warnings, used };
}
