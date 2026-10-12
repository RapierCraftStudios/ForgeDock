// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// common.mjs - what every source adapter shares: turning a script into classified steps, and the rule that a step
// which installs system packages, deploys, or talks to a remote service is never run locally.

import fs from 'node:fs';
import path from 'node:path';
import { commandExists, shellSplit, parseYaml, Degraded } from '../lib.mjs';
import { splitBlock } from '../scoping.mjs';

const SYSTEM = /^(sudo|apt|apt-get|aptitude|yum|dnf|apk|brew|choco|snap|zypper|pacman|port|winget|scoop|systemctl|service)(\s|$)/;
const REMOTE = /^(docker\s+(push|login)|podman\s+push|kubectl|helm|terraform\s+(apply|destroy)|pulumi|aws|gcloud|az|gsutil|doctl|flyctl|fly\s+deploy|vercel|netlify|wrangler|heroku|firebase|npm\s+(publish|login|whoami|token)|yarn\s+npm\s+publish|pnpm\s+publish|twine\s+upload|cargo\s+(publish|login)|gem\s+push|git\s+push|git\s+remote\s+add|gh(\s|$)|curl\s+.*\|\s*(ba)?sh|ssh(\s|$)|scp(\s|$)|rsync\s+.*:|sentry-cli|codecov|slack)/;
const INSTALL = /^(npm\s+(ci|install|i)|pnpm\s+(install|i)|yarn(\s+install)?|bun\s+install|pip3?\s+install|python3?\s+-m\s+pip\s+install|poetry\s+install|uv\s+(sync|pip\s+install)|pipenv\s+install|bundle\s+install|composer\s+install|go\s+mod\s+(download|tidy)|cargo\s+fetch|mvn\s+.*dependency:|gradle(w)?\s+dependencies|dotnet\s+restore)(\s|$)/;
const SHELL_BUILTIN = new Set(['cd', 'echo', 'test', '[', '[[', 'export', 'set', 'true', 'false', 'exit', 'printf', 'source', '.', 'read', 'eval', 'exec', 'trap', 'unset', 'command', 'type', ':', 'if', 'for', 'while', 'case', 'until', 'function', 'local', 'declare', 'shift', 'wait', 'return', 'mkdir', 'rm', 'cp', 'mv', 'cat', 'ls', 'pwd', 'sleep', 'grep', 'sed', 'awk', 'find', 'sort', 'head', 'tail', 'wc', 'tr', 'cut', 'xargs', 'diff', 'touch', 'chmod', 'env', 'bash', 'sh', 'git', 'tee', 'basename', 'dirname', 'date', 'uname', 'which', 'tar', 'unzip', 'jq', 'yq', 'make', 'node', 'npm', 'npx']);

// Classify one command line. Returns { kind, defer?, noop?, note? }.
// Every command segment of a line: split on `&&`, `||`, `;`, `|`, `&`, newlines, `$(`, backticks and grouping, then drop
// leading env assignments and control words, so `cd x && aws s3 sync` is judged on `aws`, not on `cd`. A quoted separator
// over-splits, which only ever defers more (the safe direction).
const LEAD_WORD = /^(?:(?:then|do|else|elif|if|while|until|time|exec|command|env|nohup|!)\s+)+/;
function segments(cmd) {
  return cmd.split(/&&|\|\||[;|&\n`(){}]|\$\(/).map((p) => p.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(LEAD_WORD, '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')).filter(Boolean);
}

export function classifyCommand(cmd, repo, cwdRel) {
  const first = cmd.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  const head3 = (t) => t.split(/\s+/).slice(0, 3).join(' ');
  for (const seg of segments(cmd)) {
    if (SYSTEM.test(seg)) return { kind: 'system', defer: `system-level command: ${head3(seg)}` };
    if (REMOTE.test(seg)) return { kind: 'remote', defer: `remote-mutating or service command: ${head3(seg)}` };
  }
  // `curl ... | sh` spans a pipe, so it is matched on the whole line as well as per segment.
  if (/\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/.test(cmd)) return { kind: 'remote', defer: `remote-mutating or service command: ${head3(first)}` };
  if (INSTALL.test(first)) {
    if (/^(npm|pnpm|yarn|bun)\b/.test(first)) {
      const nm = path.join(repo, cwdRel || '.', 'node_modules');
      return fs.existsSync(nm) ? { kind: 'install', noop: true, note: 'node_modules present' } : { kind: 'install', note: 'dependency install (offline failure defers the job)' };
    }
    if (/^(go|cargo|mvn|gradle|dotnet)/.test(first)) return { kind: 'install', noop: true, note: 'the build tool fetches dependencies on demand' };
    return { kind: 'install', noop: true, note: 'python/ruby/php dependency install is not run on the host; assumes a provisioned environment' };
  }
  return { kind: 'check' };
}

// Missing local tool for a simple command: the job is deferred, never failed for an absent binary.
export function missingTool(cmd) {
  const toks = shellSplit(cmd);
  if (!toks) return '';
  const i = toks.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const t = i >= 0 ? toks[i] : '';
  if (!t || t.includes('/') || SHELL_BUILTIN.has(t) || t.startsWith('.')) return '';
  return commandExists(t) ? '' : t;
}

// Build normalised step objects for one `run` script. Lines are split only when provably independent.
export function stepsFromScript(script, o) {
  const parts = splitBlock(script);
  const out = []; let defer = '';
  parts.forEach((cmd, idx) => {
    const c = classifyCommand(cmd, o.repo, o.cwd);
    if (c.defer && !defer) defer = c.defer;
    // A multi-line block is also scanned line by line for deferrable commands.
    if (parts.length === 1 && cmd.includes('\n')) for (const l of cmd.split('\n')) { const lc = classifyCommand(l, o.repo, o.cwd); if (lc.defer && !defer) defer = lc.defer; }
    if (c.noop) { out.push({ name: `${o.name || 'run'}`, command: cmd, cwd: o.cwd, env: o.env || {}, shell: o.shell, kind: 'install', noop: true, note: c.note }); return; }
    out.push({
      name: parts.length > 1 ? `${o.name || 'run'} [${idx + 1}/${parts.length}]` : (o.name || 'run'),
      group: parts.length > 1 ? (o.name || 'run') : undefined,
      command: cmd, cwd: o.cwd, env: o.env || {}, shell: o.shell, kind: c.kind, note: c.note,
      continue_on_error: !!o.continue_on_error, timeout_s: o.timeout_s,
    });
  });
  return { steps: out, defer };
}

// Resolve the shell invocation (argv minus the script file) for a CI `shell:` value; null when it cannot run here.
export function shellArgv(shell) {
  const s = (shell || '').trim();
  if (!s) return ['bash', '-e'];
  if (s === 'bash') return ['bash', '--noprofile', '--norc', '-eo', 'pipefail'];
  if (s === 'sh') return ['sh', '-e'];
  if (/^bash\b/.test(s)) return s.replace(/\s*\{0\}\s*$/, '').split(/\s+/);
  if (/^sh\b/.test(s)) return s.replace(/\s*\{0\}\s*$/, '').split(/\s+/);
  if (s === 'python') return ['python3'];
  return null;
}

export function deepMerge(a, b) {
  if (b === undefined) return a;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v; return out;
  }
  return b;
}

// Trusted base definition merged with the PR's own edits (PR wins per key; a PR cannot delete a base job).
export function loadDoc(a, file, parse) {
  const { base, head } = a.readDefs(file);
  const b = base != null ? parse(base) : null; const h = head != null ? parse(head) : null;
  if (b === undefined || h === undefined) return undefined;
  if (!b) return h; if (!h) return b;
  return deepMerge(b, h);
}

export function parseSafe(text) {
  // parseYaml throws Degraded when yq is absent (propagate) and Error on malformed YAML (undefined = unreadable).
  try { return parseYaml(text); } catch (e) { if (e instanceof Degraded) throw e; return undefined; }
}

// Env and checkout conventions for jobs derived from non-GitHub CI systems.
export function baseJob(o) {
  return { id: o.id, source: o.source, name: o.name, cwd: '.', env: o.env || {}, services: o.services || [], steps: o.steps || [], needs: o.needs || [], timeout_s: o.timeout_s, deferred_reason: null, warnings: o.warnings || [], matrix: o.matrix };
}

export function globList(v) { return [].concat(v || []).filter((x) => typeof x === 'string'); }
