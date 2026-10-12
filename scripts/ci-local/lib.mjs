// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// lib.mjs - shared helpers for scripts/ci-local (process, git, yaml, glob, expression, shell tokenizer).
// No dependencies beyond Node and the `yq` / `git` binaries. Nothing here ever talks to GitHub.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class Unsupported extends Error {}
export class Degraded extends Error {}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function run(cmd, args, opts = {}) {
  const t0 = process.env.FORGE_CI_LOCAL_DEBUG ? Date.now() : 0;
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 60000, cwd: opts.cwd, input: opts.input, env: opts.env || process.env });
  if (t0 && Date.now() - t0 > 40) process.stderr.write(`[ci-local debug] ${Date.now() - t0}ms ${cmd} ${args.slice(0, 6).join(' ').slice(0, 100)}\n`);
  return { code: r.status === null ? 124 : r.status, out: r.stdout || '', err: r.stderr || '' };
}

export const git = (repo, args, opts = {}) => run('git', ['-C', repo, ...args], opts);

export function commandExists(name) {
  const r = run('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name], { timeout: 5000 });
  return r.code === 0;
}

export function toolVersion(name) {
  if (!/^[A-Za-z0-9._+-]+$/.test(name) || !commandExists(name)) return '';
  const r = run(name, ['--version'], { timeout: 5000 });
  return (r.out || r.err).split('\n')[0].slice(0, 120);
}

export function hostClass() {
  return { linux: 'linux', darwin: 'darwin', win32: 'win32' }[process.platform] || process.platform;
}

// ---- YAML via yq (mikefarah v4 first, kislyuk-style fallback) ----
let yqMode = null;
export function yqAvailable() {
  if (yqMode !== null) return yqMode !== '';
  if (process.env.FORGE_CI_LOCAL_NO_YQ === '1') { yqMode = ''; return false; }
  if (!commandExists('yq')) { yqMode = ''; return false; }
  const ok = run('yq', ['-o=json', '.', '-'], { input: 'a: 1\n', timeout: 10000 });
  if (ok.code === 0 && /"a":\s*1/.test(ok.out)) { yqMode = 'mikefarah'; return true; }
  const alt = run('yq', ['.', '-'], { input: 'a: 1\n', timeout: 10000 });
  if (alt.code === 0 && /"a":\s*1/.test(alt.out)) { yqMode = 'kislyuk'; return true; }
  yqMode = ''; return false;
}

export function parseYaml(text) {
  if (!yqAvailable()) throw new Degraded('yq not found (mikefarah yq v4 is required to read CI definitions)');
  const args = yqMode === 'mikefarah' ? ['-o=json', '-I=0', '.', '-'] : ['.', '-'];
  const r = run('yq', args, { input: text, timeout: 30000 });
  if (r.code !== 0) throw new Error('yaml parse error: ' + r.err.split('\n')[0]);
  // Multi-document streams print one JSON value per document; keep the first document.
  const first = r.out.trim();
  if (first === '') return null;
  try { return JSON.parse(first); } catch (e) {
    const docs = []; let depth = 0, start = 0, inStr = false, esc = false;
    for (let i = 0; i < first.length; i++) {
      const c = first[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{' || c === '[') { if (depth === 0) start = i; depth++; } else if (c === '}' || c === ']') { depth--; if (depth === 0) docs.push(first.slice(start, i + 1)); }
    }
    if (!docs.length) throw new Error('yaml parse error: unreadable output');
    return JSON.parse(docs[0]);
  }
}

export const safeParseYaml = (text) => { try { return parseYaml(text); } catch (e) { if (e instanceof Degraded) throw e; return undefined; } };

// ---- repo state ----
export function resolveRef(repo, ref) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  return r.code === 0 ? r.out.trim() : '';
}

export function readAtRef(repo, ref, file) {
  const r = git(repo, ['show', `${ref}:${file}`]);
  return r.code === 0 ? r.out : null;
}

export function listAtRef(repo, ref) {
  const r = git(repo, ['ls-tree', '-r', '--name-only', ref]);
  return r.code === 0 ? r.out.split('\n').filter(Boolean) : [];
}

export function trackedFiles(repo) {
  const r = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return r.out.split('\0').filter(Boolean);
}

// Files this change touches: working tree (staged + unstaged) vs the merge base, plus untracked.
export function changedFiles(repo, baseRef) {
  const set = new Set();
  const mb = baseRef ? git(repo, ['merge-base', baseRef, 'HEAD']) : { code: 1, out: '' };
  const from = mb.code === 0 ? mb.out.trim() : (baseRef && resolveRef(repo, baseRef)) || 'HEAD';
  for (const args of [['diff', '--name-only', '--no-renames', from], ['ls-files', '--others', '--exclude-standard']]) {
    for (const f of git(repo, args).out.split('\n')) if (f) set.add(f);
  }
  return { files: [...set].sort(), from };
}

export function headSha(repo) { return git(repo, ['rev-parse', 'HEAD']).out.trim(); }

// A fingerprint of the exact tree state (index + unstaged diff + untracked contents).
export function treeFingerprint(repo) {
  const h = createHash('sha256');
  h.update(git(repo, ['ls-files', '-s']).out);
  h.update(git(repo, ['diff', '--no-ext-diff', '--binary']).out);
  for (const f of git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).out.split('\0').filter(Boolean)) {
    h.update(f); try { h.update(fs.readFileSync(path.join(repo, f))); } catch { /* vanished */ }
  }
  return h.digest('hex');
}

export function fileHash(repo, f) {
  try { return sha256(fs.readFileSync(path.join(repo, f))); } catch { return 'missing'; }
}

// ---- globs (GitHub path-filter semantics: * stops at /, ** crosses it) ----
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j > i + 1) { re += '[' + glob.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

// Ordered include/exclude list ('!' prefix excludes): the last matching pattern decides.
export function matchesFilter(file, patterns) {
  let hit = false;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    const neg = p.startsWith('!');
    const re = globToRegex((neg ? p.slice(1) : p).replace(/^\.?\//, ''));
    if (re.test(file)) hit = !neg;
  }
  return hit;
}

export function branchMatches(branch, patterns) {
  let hit = false;
  for (const p of patterns) {
    if (typeof p !== 'string') continue;
    const neg = p.startsWith('!');
    if (globToRegex(neg ? p.slice(1) : p).test(branch)) hit = !neg;
  }
  return hit;
}

// ---- GitHub-style expressions ----
function truthy(v) { return !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v)); }
function num(v) { if (v === null || v === undefined) return 0; if (typeof v === 'boolean') return v ? 1 : 0; if (typeof v === 'number') return v; if (v === '') return 0; const n = Number(v); return n; }
function looseEq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a === typeof b) return a === b;
  return num(a) === num(b);
}
export const str = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function tokenize(src) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") { let j = i + 1, s = ''; while (j < src.length) { if (src[j] === "'") { if (src[j + 1] === "'") { s += "'"; j += 2; continue; } break; } s += src[j++]; } if (j >= src.length) throw new Unsupported('unterminated string'); toks.push({ t: 'str', v: s }); i = j + 1; continue; }
    if (/[0-9]/.test(c)) { const m = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i)); toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i)); toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('!<>().,[]*'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Unsupported('unexpected character ' + c);
  }
  return toks;
}

const FUNCS = {
  contains: (a, b) => (Array.isArray(a) ? a.some((x) => looseEq(x, b)) : str(a).toLowerCase().includes(str(b).toLowerCase())),
  startsWith: (a, b) => str(a).toLowerCase().startsWith(str(b).toLowerCase()),
  endsWith: (a, b) => str(a).toLowerCase().endsWith(str(b).toLowerCase()),
  format: (f, ...a) => str(f).replace(/\{(\d+)\}/g, (_, n) => str(a[Number(n)])).replace(/\{\{/g, '{').replace(/\}\}/g, '}'),
  join: (a, sep = ',') => (Array.isArray(a) ? a.map(str).join(str(sep)) : str(a)),
  toJSON: (v) => JSON.stringify(v),
  success: () => true, always: () => true, failure: () => false, cancelled: () => false,
};

// Safe built-in names the evaluator may read from a context; anything else is Unsupported (never guessed).
const GITHUB_KEYS = new Set(['event_name', 'base_ref', 'head_ref', 'ref', 'ref_name', 'ref_type', 'sha', 'repository', 'workspace', 'event', 'server_url', 'repository_owner']);

const EVENT_PATHS = new Set(['pull_request', 'pull_request.base', 'pull_request.base.sha', 'pull_request.base.ref', 'pull_request.head', 'pull_request.head.sha', 'pull_request.head.ref', 'pull_request.draft', 'pull_request.labels', 'pull_request.labels.*.name', 'pull_request.head.repo', 'pull_request.head.repo.fork', 'pull_request.head.repo.full_name', 'pull_request.base.repo', 'pull_request.base.repo.full_name', 'before']);

export function evalExpr(src, ctx) {
  const toks = tokenize(src); let p = 0;
  const peek = () => toks[p]; const eat = (v) => { const t = toks[p]; if (t && t.t === 'op' && t.v === v) { p++; return true; } return false; };
  function primary() {
    const t = toks[p++];
    if (!t) throw new Unsupported('unexpected end');
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') { const v = or(); if (!eat(')')) throw new Unsupported('missing )'); return v; }
    if (t.t === 'op' && t.v === '!') return !truthy(primary());
    if (t.t === 'id') {
      if (t.v === 'true') return true; if (t.v === 'false') return false; if (t.v === 'null') return null;
      if (eat('(')) {
        const args = []; if (!eat(')')) { do { args.push(or()); } while (eat(',')); if (!eat(')')) throw new Unsupported('missing )'); }
        const fn = FUNCS[t.v];
        if (!fn) throw new Unsupported('function ' + t.v + '()');
        return fn(...args);
      }
      const segs = [t.v];
      for (;;) {
        if (eat('.')) { const n = toks[p++]; if (!n || n.t === 'op' && n.v !== '*') throw new Unsupported('bad member access'); if (n.t === 'op') { segs.push('*'); continue; } segs.push(String(n.v)); }
        else if (peek() && peek().t === 'op' && peek().v === '[') { p++; const k = or(); if (!eat(']')) throw new Unsupported('missing ]'); segs.push(str(k)); }
        else break;
      }
      return lookup(segs, ctx);
    }
    throw new Unsupported('unexpected token');
  }
  function cmp() { let l = primary(); while (peek() && peek().t === 'op' && ['<', '>', '<=', '>='].includes(peek().v)) { const o = toks[p++].v; const r = primary(); const a = num(l), b = num(r); l = o === '<' ? a < b : o === '>' ? a > b : o === '<=' ? a <= b : a >= b; } return l; }
  function eq() { let l = cmp(); while (peek() && peek().t === 'op' && (peek().v === '==' || peek().v === '!=')) { const o = toks[p++].v; const r = cmp(); l = o === '==' ? looseEq(l, r) : !looseEq(l, r); } return l; }
  function and() { let l = eq(); while (peek() && peek().t === 'op' && peek().v === '&&') { p++; const r = eq(); l = truthy(l) ? r : l; } return l; }
  function or() { let l = and(); while (peek() && peek().t === 'op' && peek().v === '||') { p++; const r = and(); l = truthy(l) ? l : r; } return l; }
  const v = or();
  if (p < toks.length) throw new Unsupported('trailing tokens');
  return v;
}

function lookup(segs, ctx) {
  const root = segs[0];
  if (ctx.__roots && root in ctx.__roots) {
    let cur = ctx.__roots[root];
    for (let i = 1; i < segs.length; i++) { if (cur === null || typeof cur !== 'object' || !(segs[i] in cur)) throw new Unsupported(segs.slice(0, i + 1).join('.')); cur = cur[segs[i]]; }
    return cur === undefined ? null : cur;
  }
  if (root === 'github') {
    if (!GITHUB_KEYS.has(segs[1])) throw new Unsupported('github.' + segs[1]);
    if (segs[1] === 'event' && !EVENT_PATHS.has(segs.slice(2).join('.'))) throw new Unsupported('github.event.' + segs.slice(2).join('.'));
    if (segs[1] === 'repository' && !ctx.github.repository) throw new Unsupported('github.repository');
  } else if (root === 'runner') {
    if (!['os', 'arch', 'temp'].includes(segs[1])) throw new Unsupported('runner.' + segs[1]);
  } else if (root === 'matrix' || root === 'env' || root === 'needs' || root === 'steps') {
    if (ctx[root] === undefined) throw new Unsupported(root + ' context');
  } else throw new Unsupported(root + ' context');
  let cur = ctx[root];
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] === '*') {
      if (cur === null || typeof cur !== 'object') return [];
      const rest = segs.slice(i + 1); const items = Array.isArray(cur) ? cur : Object.values(cur);
      return items.map((el) => { let c = el; for (const k of rest) { if (c === null || typeof c !== 'object') return null; c = c[k]; } return c === undefined ? null : c; });
    }
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    if (root === 'steps' && i === 1 && !(segs[i] in cur)) throw new Unsupported('steps.' + segs[i] + ' (not resolved locally)');
    if (root === 'steps' && i === 2 && segs[2] === 'outputs' && !('outputs' in cur)) throw new Unsupported('step outputs');
    if (root === 'needs' && i === 1 && !(segs[i] in cur)) throw new Unsupported('needs.' + segs[i]);
    if (root === 'needs' && i === 2 && !['outputs', 'result'].includes(segs[2])) throw new Unsupported('needs.' + segs[1] + '.' + segs[2]);
    if (root === 'needs' && i === 3 && !(segs[3] in cur)) throw new Unsupported('needs output ' + segs[3]);
    if (root === 'steps' && i === 3 && !(segs[3] in cur)) throw new Unsupported('steps output ' + segs[3]);
    cur = cur[segs[i]];
  }
  return cur === undefined ? null : cur;
}

// Replace every ${{ expr }} in a string. A string that is exactly one expression keeps the raw value type.
export function interpolate(text, ctx) {
  if (typeof text !== 'string' || !text.includes('${{')) return text;
  const only = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(text);
  if (only && !only[1].includes('}}')) return evalExpr(only[1], ctx);
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => str(evalExpr(e, ctx)));
}

export function condTrue(cond, ctx) {
  if (cond === undefined || cond === null || cond === true) return true;
  if (cond === false) return false;
  let c = String(cond).trim();
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(c);
  if (m) c = m[1].trim();
  return truthy(evalExpr(c, ctx));
}

// ---- shell tokenizer: returns tokens for a single simple command, or null when the line is not simple ----
export function shellSplit(cmd) {
  const toks = []; let cur = null, i = 0;
  const push = () => { if (cur !== null) { toks.push(cur); cur = null; } };
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\\') { if (i + 1 >= cmd.length) return null; if (cmd[i + 1] === '\n') { i += 2; continue; } cur = (cur || '') + cmd[i + 1]; i += 2; continue; }
    if (c === "'") { const j = cmd.indexOf("'", i + 1); if (j < 0) return null; cur = (cur || '') + cmd.slice(i + 1, j); i = j + 1; continue; }
    if (c === '"') { let j = i + 1, s = ''; while (j < cmd.length && cmd[j] !== '"') { if (cmd[j] === '\\' && '"\\$`'.includes(cmd[j + 1] || '')) { s += cmd[j + 1]; j += 2; continue; } if (cmd[j] === '$' || cmd[j] === '`') return null; s += cmd[j++]; } if (j >= cmd.length) return null; cur = (cur || '') + s; i = j + 1; continue; }
    if (/\s/.test(c)) { push(); i++; continue; }
    if ('|&;<>(){}`$'.includes(c) || (c === '#' && cur === null)) return null;
    cur = (cur || '') + c; i++;
  }
  push();
  return toks;
}

export function shellQuote(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---- environment hygiene: CI jobs run in a runner-like environment ----
// An allowlist, not a blacklist: remote CI starts from a clean environment, so ambient operator state (agent
// credentials, install-root overrides, git hook variables such as GIT_DIR/GIT_INDEX_FILE, FORGE_*/CLAUDE_* settings)
// must not reach the jobs. Toolchain variables are passed through; credential-looking names are always dropped.
const ENV_EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'COLORTERM', 'NO_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'DOCKER_HOST', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'GOFLAGS', 'GOCACHE', 'GOMODCACHE', 'GOPROXY', 'GOTOOLCHAIN', 'VIRTUAL_ENV', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'RUSTFLAGS', 'RUSTUP_HOME', 'SDKMAN_DIR', 'PNPM_HOME', 'BUN_INSTALL', 'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'RBENV_ROOT', 'PYENV_ROOT', 'ASDF_DIR', 'ASDF_DATA_DIR', 'MISE_DATA_DIR', 'HOMEBREW_PREFIX', 'ComSpec', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'MSYSTEM']);
const ENV_PREFIX = ['LC_', 'XDG_', 'CARGO_', 'MAVEN_', 'M2_', 'GRADLE_', 'DOTNET_', 'npm_config_', 'NPM_CONFIG_', 'YARN_', 'UV_', 'POETRY_', 'PIP_CACHE', 'FORGE_CI_LOCAL_'];
// Substring tokens are unambiguous; short ones (PASS, PAT, KEY, IDENT, CRED, SESSION, COOKIE) match only as whole
// name segments (or a trailing _KEY) so benign names such as FORGE_CI_LOCAL_PASSTHROUGH or PATH are kept.
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|SESSION|COOKIE)|(^|[^A-Za-z0-9])(PASS|PAT|IDENT|CRED|CREDS|KEY)([^A-Za-z0-9]|$)|_KEY$/i;
// URL-embedded credentials (scheme://user:pass@host) in proxy/index/registry variables: the userinfo is stripped, the
// rest of the value is kept so the job still reaches the same host.
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/?#\s@]*@/g;
export function stripUserinfo(v) { return typeof v === 'string' ? v.replace(URL_USERINFO, '$1') : v; }
export function scrubbedEnv(extra = {}) {
  const pass = new Set((process.env.FORGE_CI_LOCAL_PASSTHROUGH || '').split(',').map((x) => x.trim()).filter(Boolean));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k)) continue;
    if (ENV_EXACT.has(k) || pass.has(k) || ENV_PREFIX.some((p) => k.startsWith(p))) env[k] = stripUserinfo(v);
  }
  env.CI = 'true'; env.FORGE_CI_LOCAL = '1'; env.FORGE_TELEMETRY = 'off';
  return Object.assign(env, extra);
}

export function homeForgeDir() {
  return process.env.FORGE_CI_LOCAL_HOME || path.join(process.env.HOME || os.homedir(), '.forge');
}

export function majorOf(v) { const m = /(\d+)/.exec(String(v)); return m ? Number(m[1]) : null; }

export function dedupe(a) { return [...new Set(a)]; }

export function jobId(...parts) { return parts.filter((x) => x !== '' && x !== undefined && x !== null).join(':').replace(/[^A-Za-z0-9_.:@/-]+/g, '-'); }

// "Deferred" and "skipped" shapes shared by every adapter.
export function deferred(id, source, name, reason, extra = {}) { return { id, source, name, deferred_reason: reason, steps: [], services: [], env: {}, cwd: '.', ...extra }; }
export function notApplicable(id, source, name, reason) { return { id, source, name, not_applicable: reason, steps: [], services: [], env: {}, cwd: '.' }; }

export const SECRET_REF = /(secrets\.|\$\{?(?:\{\{ *)?secrets|CI_JOB_TOKEN|\bsecrets:)/;
export const DEPLOY_NAME = /(^|[^a-z])(deploy|deployment|publish|release|promote|rollout)([^a-z]|$)/i;

// A $VAR / ${VAR} reference whose name looks like a credential and is not defined in the CI file itself.
export function secretLikeVar(text, defined = new Set()) {
  const re = /\$\{?([A-Za-z][A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_?KEY|PRIVATE_?KEY|CREDENTIALS?))\}?/g;
  let m; while ((m = re.exec(text))) if (!defined.has(m[1])) return m[1];
  return '';
}

export function parseDuration(v) {
  if (typeof v === 'number') return v * 60;
  const m = /^(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?$/i.exec(String(v || '').trim());
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
