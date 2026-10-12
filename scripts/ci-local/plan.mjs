// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// plan.mjs - derive the local check set for a change. Reads CI definitions from the trusted base ref plus the PR's own
// edits, runs every source adapter, applies exact scoping, and caches the plan keyed by the hash of the CI definitions
// plus everything the plan is derived from. Never talks to GitHub; never triggers a remote run.

import fs from 'node:fs';
import path from 'node:path';
import {
  Degraded, git, run, resolveRef, fileHash, readAtRef, listAtRef, changedFiles, headSha, sha256, hostClass, homeForgeDir, parseYaml, globToRegex,
} from './lib.mjs';
import { makeScopeCtx, scopeCommand } from './scoping.mjs';
import { missingTool } from './adapters/common.mjs';
import * as gha from './adapters/github-actions.mjs';
import * as gitlab from './adapters/gitlab-ci.mjs';
import * as circle from './adapters/circleci.mjs';
import * as azure from './adapters/azure-pipelines.mjs';
import * as bitbucket from './adapters/bitbucket.mjs';
import * as buildkite from './adapters/buildkite.mjs';
import * as tasks from './adapters/task-runners.mjs';
import * as explicit from './adapters/explicit.mjs';
import * as portability from './adapters/portability.mjs';

export const PLAN_VERSION = 1;
const CI_ADAPTERS = [gha, gitlab, circle, azure, bitbucket, buildkite];

function loadConfig(repo) {
  const candidates = [path.join(repo, 'forge.yaml')];
  const gc = git(repo, ['rev-parse', '--git-common-dir']).out.trim();
  if (gc) { const abs = path.resolve(repo, gc); candidates.push(path.join(path.dirname(abs), 'forge.yaml')); }
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    let doc; try { doc = parseYaml(fs.readFileSync(f, 'utf8')); } catch (e) { if (e instanceof Degraded) throw e; continue; }
    const c = (doc && doc.verification && doc.verification.ci_local) || {};
    return { file: f, exclude_jobs: [].concat(c.exclude_jobs || []), include_jobs: [].concat(c.include_jobs || []), extra_commands: [].concat(c.extra_commands || []), services: c.services === 'off' ? 'off' : 'auto', budget_minutes: Number(c.budget_minutes) > 0 ? Number(c.budget_minutes) : undefined, max_parallel: Number(c.max_parallel) > 0 ? Number(c.max_parallel) : undefined };
  }
  return { file: '', exclude_jobs: [], include_jobs: [], extra_commands: [], services: 'auto' };
}

function repoSlug(repo) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const u = git(repo, ['remote', 'get-url', 'origin']).out.trim();
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(u);
  return m ? m[1] : '';
}

export function buildPlan(opts) {
  const repo = path.resolve(opts.repo || '.');
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`not a git repository: ${repo}`);
  const warnings = [];
  const baseRef = opts.base || '';
  let baseSha = baseRef ? resolveRef(repo, baseRef) : '';
  if (baseRef && !baseSha) warnings.push(`base ref ${baseRef} did not resolve; CI definitions are read from the working tree (not the trusted base) and only uncommitted changes count as changed`);
  const baseBranch = (opts.baseBranch || baseRef.replace(/^(refs\/(remotes\/)?)?origin\//, '').replace(/^refs\/heads\//, '')) || 'main';
  const headBranch = opts.headBranch || git(repo, ['branch', '--show-current']).out.trim();
  let changed; let from;
  if (opts.files) { changed = opts.files.slice().sort(); from = baseSha || 'HEAD'; } else { const c = changedFiles(repo, baseSha ? baseRef : ''); changed = c.files; from = c.from; }
  const config = loadConfig(repo);
  const head = headSha(repo);
  const tracked = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).out.split('\0').filter(Boolean);
  const baseFiles = baseSha ? listAtRef(repo, baseRef) : [];

  const a = {
    repo, baseRef, baseSha, baseBranch, headBranch, headSha: head, changed, from, tracked, config, repository: repoSlug(repo),
    defFiles(re) { return [...new Set([...baseFiles, ...tracked].filter((f) => re.test(f)))].sort(); },
    readDefs(f) {
      const baseText = baseSha ? readAtRef(repo, baseRef, f) : null;
      let headText = null; try { headText = fs.readFileSync(path.join(repo, f), 'utf8'); } catch { /* absent in the working tree */ }
      return { base: baseText, head: headText };
    },
  };

  // ---- cache key: CI definitions + everything the plan derives from ----
  const defRe = new RegExp([gha, gitlab, circle, azure, bitbucket, buildkite].map((m) => m.DEF_RE.source).join('|'));
  const defContents = a.defFiles(defRe).map((f) => { const d = a.readDefs(f); return `${f}\n${d.base}\n${d.head}`; }).join('\n--\n');
  const changeContents = changed.map((f) => `${f}:${fileHash(repo, f)}`);
  const key = sha256(JSON.stringify([PLAN_VERSION, repo, defContents, changeContents, baseSha, baseBranch, headBranch, hostClass(), config, process.version, process.env.FORGE_CI_LOCAL_SERVICES || '', fs.existsSync(path.join(repo, 'package.json')) ? sha256(fs.readFileSync(path.join(repo, 'package.json'))) : '']));
  const cacheDir = path.join(opts.cacheDir || path.join(homeForgeDir(), 'ci-local', 'plans'));
  const cacheFile = path.join(cacheDir, key + '.json');
  if (!opts.noCache && fs.existsSync(cacheFile)) {
    try { const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); cached.plan_cache = 'hit'; return cached; } catch { /* rebuild */ }
  }

  // ---- adapters ----
  let jobs = [];
  for (const ad of CI_ADAPTERS) { const r = ad.plan(a); jobs.push(...r.jobs); warnings.push(...(r.warnings || [])); }
  const ciGates = jobs.some((j) => !j.not_applicable);
  const sources = [...new Set(jobs.map((j) => j.source))];
  if (!ciGates) { const r = tasks.plan(a); jobs.push(...r.jobs); warnings.push(...r.warnings); if (r.jobs.length) sources.push('task-runners'); }
  jobs.push(...explicit.plan(a).jobs, ...portability.plan(a).jobs);

  // ---- config filters ----
  const matches = (j, pats) => pats.some((p) => globToRegex(String(p)).test(j.id) || globToRegex(String(p)).test(String(j.name)) || String(p) === j.id);
  if (config.exclude_jobs.length) jobs = jobs.map((j) => (!j.not_applicable && matches(j, config.exclude_jobs) ? { ...j, not_applicable: 'excluded by verification.ci_local.exclude_jobs', steps: [], services: [] } : j));
  if (config.include_jobs.length) jobs = jobs.map((j) => (!j.not_applicable && !['explicit', 'portability'].includes(j.source) && !matches(j, config.include_jobs) ? { ...j, not_applicable: 'not in verification.ci_local.include_jobs', steps: [], services: [] } : j));

  // ---- exact scoping + tool availability ----
  const sctx = makeScopeCtx({ repo, baseRef, from, changed });
  for (const j of jobs) {
    if (j.not_applicable || j.deferred_reason) continue;
    for (const s of j.steps) {
      if (s.noop || s.builtin || s.kind === 'install') continue;
      s.original_command = s.command;
      if (s.prescoped) { s.scope = { mode: 'full', selector: 'explicit', widen_reason: '' }; continue; }
      const sc = scopeCommand(s.command, s.cwd && s.cwd !== '.' ? s.cwd : '', sctx);
      s.scope = { mode: sc.mode, selected: sc.selected, total: sc.total, selector: sc.selector || '', widen_reason: sc.widen_reason || '', files: sc.files };
      if (sc.action === 'skip') { s.skip = sc.reason; continue; }
      s.command = sc.command;
    }
    const live = j.steps.filter((s) => !s.noop && !s.skip && !s.builtin);
    for (const s of live) { const m = missingTool(s.command); if (m) { j.deferred_reason = `tool not installed locally: ${m}`; break; } }
  }

  // ---- services policy ----
  const servicesOff = config.services === 'off' || process.env.FORGE_CI_LOCAL_SERVICES === 'off';
  for (const j of jobs) {
    if (!j.not_applicable && !j.deferred_reason && j.services && j.services.length && servicesOff) j.deferred_reason = 'service containers disabled (verification.ci_local.services: off)';
  }

  const plan = {
    version: PLAN_VERSION, repo, base_ref: baseRef, base_sha: baseSha, base_branch: baseBranch, head_branch: headBranch, head_sha: head, merge_base: from,
    host: hostClass(), changed_files: changed, widen_reason: sctx.widen, sources, warnings: [...new Set(warnings)],
    config: { budget_minutes: config.budget_minutes, max_parallel: config.max_parallel, services: config.services, file: config.file },
    plan_key: key, plan_cache: 'miss', jobs,
  };
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(plan)); pruneOld(cacheDir); } catch { /* cache is best effort */ }
  return plan;
}

function pruneOld(dir) {
  const now = Date.now(); let n = 0;
  for (const f of fs.readdirSync(dir)) { if (++n > 400) break; try { const p = path.join(dir, f); if (now - fs.statSync(p).mtimeMs > 30 * 86400 * 1000) fs.unlinkSync(p); } catch { /* ignore */ } }
}

export function summarizePlan(plan) {
  const lines = [];
  lines.push(`CI_LOCAL_PLAN: base=${plan.base_ref || '-'} host=${plan.host} changed=${plan.changed_files.length} sources=${plan.sources.join(',') || 'none'} cache=${plan.plan_cache}${plan.widen_reason ? ` widened=${plan.widen_reason}` : ''}`);
  for (const w of plan.warnings) lines.push(`CI_LOCAL_WARNING: ${w}`);
  for (const j of plan.jobs) {
    if (j.not_applicable) { lines.push(`CI_LOCAL_JOB: not-applicable ${j.id} | ${j.name} | ${j.not_applicable}`); continue; }
    if (j.deferred_reason) { lines.push(`CI_LOCAL_JOB: deferred-to-ci ${j.id} | ${j.name} | ${j.deferred_reason}`); continue; }
    const live = j.steps.filter((s) => !s.noop);
    const skipped = live.filter((s) => s.skip).length;
    lines.push(`CI_LOCAL_JOB: runnable ${j.id} | ${j.name} | steps=${live.length} skipped-by-scope=${skipped}${j.services && j.services.length ? ` services=${j.services.map((s) => s.name).join(',')}` : ''}`);
  }
  return lines;
}
