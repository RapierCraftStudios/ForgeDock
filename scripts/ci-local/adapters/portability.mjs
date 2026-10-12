// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// portability.mjs - deterministic cross-platform checks that always run, because macOS/Windows CI jobs are deferred:
// Windows-invalid filename characters and reserved names, case-insensitive path collisions, CRLF in shell scripts,
// bash 3.2 constructs and GNU-only tool flags (added lines only), plus the repo's own check-shell-portability.sh
// when present. Findings are `PORTABILITY | <rule> | <file>[:line] | <detail>` lines.

import fs from 'node:fs';
import path from 'node:path';
import { git, jobId } from '../lib.mjs';
import { baseJob } from './common.mjs';

export const id = 'portability';
const WIN_BAD = /[<>:"|?*\u0000-\u001f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const SH_EXT = /\.(sh|bash)$/;

const BASH32 = [
  [/\b(mapfile|readarray)\b/, 'bash-4 builtin mapfile/readarray'],
  [/\b(declare|local|typeset)\s+-[A-Za-z]*A\b/, 'bash-4 associative array'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)\}|\$\{[A-Za-z_][A-Za-z0-9_]*[,^]\}/, 'bash-4 case modification expansion'],
  [/(^|[^|])\|&/, 'bash-4 |& redirection'],
  [/&>>/, 'bash-4 &>> redirection'],
  [/\bcoproc\b/, 'bash-4 coproc'],
  [/\bwait\s+-n\b/, 'bash-4.3 wait -n'],
  [/\[\[\s+-v\s/, 'bash-4.2 [[ -v ]]'],
  [/\b(local|declare)\s+-n\b/, 'bash-4.3 namerefs'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*@[AEPQUuLa]\}/, 'bash-4.4/5 parameter transformation'],
  [/\bread\s+(-[A-Za-z]*i\b)/, 'bash-4 read -i'],
  [/\$(EPOCHSECONDS|EPOCHREALTIME|SRANDOM|BASHPID)\b/, 'bash-4/5 special variable'],
  [/;;&|;&(\s|$)/, 'bash-4 case fallthrough'],
  [/\bshopt\s+-s\s+(globstar|lastpipe|inherit_errexit)\b/, 'bash-4 shopt option'],
];
const GNU = [
  [/\bgrep\s+(-[A-Za-z]*P\b|--perl-regexp)/, 'grep -P (PCRE) is GNU-only'],
  [/\bsed\s+-i\s+(?!['"])/, 'sed -i without a backup suffix argument is GNU-only'],
  [/\bsed\s+(-[A-Za-z]*r\b|--regexp-extended)/, 'sed -r is GNU-only (use -E)'],
  [/\bdate\s+(-d\b|--date)/, 'date -d is GNU-only'],
  [/\breadlink\s+-f\b/, 'readlink -f is GNU-only'],
  [/\bstat\s+-c\b/, 'stat -c is GNU-only'],
  [/\bxargs\s+(-r\b|--no-run-if-empty)/, 'xargs -r is GNU-only'],
  [/\bfind\b.*\s-printf\b/, 'find -printf is GNU-only'],
  [/\bsort\s+(-[A-Za-z]*V\b|--version-sort)/, 'sort -V is not on older BSD sort'],
  [/\bhead\s+-n\s*-[0-9]/, 'head -n -N is GNU-only'],
  [/\bls\s+--color\b/, 'ls --color is GNU-only'],
  [/\bcp\s+--parents\b/, 'cp --parents is GNU-only'],
];

export function plan(a) {
  if (!a.changed.length) return { jobs: [], warnings: [], used: [] };
  const steps = [{ name: 'portability checks (filenames, case collisions, CRLF, bash 3.2, GNU-only flags)', command: '(built-in portability checks)', cwd: '.', env: {}, kind: 'check', builtin: 'portability' }];
  if (a.changed.some((f) => /^scripts\/.*\.sh$/.test(f)) && fs.existsSync(path.join(a.repo, 'scripts/check-shell-portability.sh')) && fs.existsSync(path.join(a.repo, 'scripts'))) {
    steps.push({ name: 'repo check-shell-portability.sh', command: 'bash scripts/check-shell-portability.sh scripts', cwd: '.', env: {}, kind: 'check', prescoped: true });
  }
  return { jobs: [baseJob({ id: jobId('portability', 'builtin'), source: 'portability', name: 'portability checks', steps })], warnings: [], used: [] };
}

function addedLines(repo, from, f) {
  const tracked = git(repo, ['ls-files', '--error-unmatch', '--', f]).code === 0;
  if (!tracked) { try { return fs.readFileSync(path.join(repo, f), 'utf8').split('\n').map((t, i) => ({ n: i + 1, t })); } catch { return []; } }
  const d = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', from, '--', f]).out;
  const out = []; let n = 0;
  for (const l of d.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { n = Number(h[1]); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) { out.push({ n, t: l.slice(1) }); n++; }
  }
  return out;
}

// Run the built-in checks; returns an array of finding strings.
export function checkPortability({ repo, from, changed, tracked }) {
  const findings = [];
  const lower = new Map();
  for (const f of tracked) { const k = f.toLowerCase(); lower.set(k, (lower.get(k) || []).concat(f)); }
  for (const f of changed) {
    for (const seg of f.split('/')) {
      if (WIN_BAD.test(seg)) { findings.push(`PORTABILITY | windows-filename | ${f} | invalid character in "${seg}"`); break; }
      if (/[. ]$/.test(seg)) { findings.push(`PORTABILITY | windows-filename | ${f} | segment "${seg}" ends with a dot or space`); break; }
      if (WIN_RESERVED.test(seg)) { findings.push(`PORTABILITY | windows-filename | ${f} | reserved device name "${seg}"`); break; }
    }
    if (f.length > 240) findings.push(`PORTABILITY | windows-path-length | ${f} | path longer than 240 characters`);
    const same = lower.get(f.toLowerCase()) || [];
    if (same.length > 1) findings.push(`PORTABILITY | case-collision | ${f} | collides with ${same.filter((x) => x !== f).join(', ')} on case-insensitive filesystems`);
    const abs = path.join(repo, f);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    let head = ''; try { head = fs.readFileSync(abs, 'utf8').slice(0, 200); } catch { continue; }
    const isShell = SH_EXT.test(f) || /^#!.*\b(ba)?sh\b/.test(head);
    if (!isShell && !/\.bats$/.test(f)) continue;
    const lines = addedLines(repo, from, f);
    for (const { n, t } of lines) {
      if (/\r$/.test(t)) { findings.push(`PORTABILITY | crlf | ${f}:${n} | CRLF line ending in a shell script`); break; }
    }
    if (/\.bats$/.test(f)) continue;
    for (const { n, t } of lines) {
      const s = t.replace(/\r$/, '');
      if (/^\s*#/.test(s) || /allowlist:/.test(s)) continue;
      for (const [re, why] of BASH32) if (re.test(s)) findings.push(`PORTABILITY | bash-3.2 | ${f}:${n} | ${why}`);
      for (const [re, why] of GNU) if (re.test(s)) findings.push(`PORTABILITY | gnu-only | ${f}:${n} | ${why}`);
    }
  }
  return findings;
}
