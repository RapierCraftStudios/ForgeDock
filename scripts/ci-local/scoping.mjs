// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// scoping.mjs - exact scoping: narrow each check to what this change can affect, widening whenever impact is unknown.
//   1. per-file checks (linters, formatters) run on the changed files only;
//   2. tests are selected by the ecosystem's own selector, else by a git-grep reference graph;
//   3. unknown impact (lockfile, build/CI config, unreferenced fixture, unknown language) widens to the full command;
//   every decision carries a reason so the telemetry can say what was narrowed and why.

import fs from 'node:fs';
import path from 'node:path';
import { git, run, shellSplit, shellQuote, globToRegex, dedupe, commandExists } from './lib.mjs';

const px = path.posix;

// ---- widening triggers: a change here has unknown reach, so nothing is narrowed ----
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|go\.work\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|gradle\.lockfile|packages\.lock\.json)$/;
const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|(jest|vitest|vite|webpack|rollup|babel|eslint|prettier|playwright|cypress|karma)\.(config|setup)[^/]*|\.babelrc[^/]*|\.eslintrc[^/]*|\.eslintignore|\.prettierrc[^/]*|\.prettierignore|\.shellcheckrc|\.editorconfig|\.flake8|\.pylintrc|\.ruff\.toml|ruff\.toml|\.markdownlint[^/]*|\.yamllint[^/]*|\.hadolint\.ya?ml|\.rubocop\.yml|pyproject\.toml|setup\.(cfg|py)|pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|requirements[^/]*\.txt|go\.mod|go\.work|Cargo\.toml|rust-toolchain[^/]*|\.cargo\/config[^/]*|pom\.xml|build\.gradle[^/]*|settings\.gradle[^/]*|gradle\.properties|Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.nvmrc|\.node-version|\.python-version|\.tool-versions|nx\.json|turbo\.json|lerna\.json|\.pre-commit-config\.yaml|\.gitlab-ci\.yml|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|forge\.yaml)$/;
const CI_DIR = /^(\.github\/(workflows|actions)\/|\.circleci\/|\.buildkite\/|\.gitlab\/)/;
const DOC_EXT = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'pdf', 'license']);
const SRC_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'cs', 'fs', 'sh', 'bash', 'zsh', 'c', 'h', 'cc', 'cpp', 'hpp', 'swift', 'm', 'ex', 'exs', 'clj', 'dart', 'lua', 'pl', 'r', 'sql', 'css', 'scss', 'less', 'html', 'json', 'yaml', 'yml', 'toml', 'bats']);
const FIXTURE_DIR = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__snapshots__|snapshots|__mocks__)\//;
const TEST_NAME = /(\.test\.|\.spec\.|_test\.|(^|\/)test_[^/]*$|\.bats$|_spec\.rb$|Test\.java$|Tests?\.cs$)/;

export const extOf = (f) => { const b = px.basename(f); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };

// A reason to run everything for the files in this change, or ''.
export function globalWiden(changed) {
  for (const f of changed) {
    if (LOCKFILE.test(f)) return `lockfile: ${f}`;
    if (CI_DIR.test(f)) return `ci-config: ${f}`;
    if (CONFIG.test(f)) return `build-config: ${f}`;
  }
  return '';
}

export function makeScopeCtx({ repo, baseRef, from, changed }) {
  const tracked = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).out.split('\0').filter(Boolean);
  const present = new Set(tracked.filter((f) => fs.existsSync(path.join(repo, f))));
  return { repo, baseRef, from, changed, tracked, present, widen: globalWiden(changed), cache: { grep: new Map(), pkg: new Map(), lists: new Map() } };
}

// ---- argument parsing for per-file tools ----
const looksPath = (t) => /[/.*]/.test(t) || !t.startsWith('-');

function parseArgs(args, spec) {
  const flags = []; const targets = []; let ambiguous = '';
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { targets.push(...args.slice(i + 1)); break; }
    if (t.startsWith('-') && t !== '-') {
      if (t.includes('=') || spec.bool.has(t)) { flags.push(t); continue; }
      if (spec.value.has(t)) { flags.push(t); if (i + 1 < args.length) flags.push(args[++i]); continue; }
      flags.push(t);
      if (i + 1 < args.length && !args[i + 1].startsWith('-') && looksPath(args[i + 1])) ambiguous = `unknown-flag-arity: ${t}`;
      continue;
    }
    targets.push(t);
  }
  return { flags, targets, ambiguous };
}

const set = (s) => new Set(s.split(' ').filter(Boolean));
// ext: file extensions the tool checks; name: extra basename regex; sub: required subcommand(s) for multi-command tools.
const LINTERS = {
  shellcheck: { ext: set('sh bash ksh'), value: set('-e -i -s -S -C -f -P -o -W --exclude --include --shell --severity --format --source-path --enable --color --wiki-link-count --norc'), bool: set('-x -a --external-sources --check-sourced --norc --list-optional'), dot: false },
  eslint: { ext: set('js jsx ts tsx mjs cjs mts cts vue'), value: set('-c --config --ext --format -f --max-warnings --parser --parser-options --plugin --rulesdir --ignore-path --ignore-pattern --resolve-plugins-relative-to --rule --global --env -o --output-file --cache-location'), bool: set('--fix --quiet --cache --no-eslintrc --no-error-on-unmatched-pattern --report-unused-disable-directives --debug'), dot: true },
  prettier: { ext: set('js jsx ts tsx mjs cjs json md mdx css scss less html yaml yml vue'), value: set('--config --ignore-path --parser --plugin --print-width --tab-width --end-of-line --log-level --cache-location'), bool: set('--check -c --write -w --list-different -l --cache --no-config --ignore-unknown -u'), dot: false },
  ruff: { ext: set('py pyi'), value: set('--config --select --ignore --extend-select --target-version --line-length --output-format --exclude --per-file-ignores --preview'), bool: set('--fix --check --diff --no-cache --quiet -q --exit-non-zero-on-fix'), dot: true, sub: set('check format') },
  black: { ext: set('py pyi'), value: set('--config -l --line-length -t --target-version --exclude --include --extend-exclude --force-exclude --workers -W'), bool: set('--check --diff --quiet -q --verbose -v'), dot: false },
  flake8: { ext: set('py'), value: set('--config --max-line-length --select --ignore --extend-ignore --exclude --per-file-ignores --format --max-complexity'), bool: set('--count --statistics -q'), dot: true },
  isort: { ext: set('py pyi'), value: set('--settings-path --profile --line-length -l --skip --sp'), bool: set('--check-only --check --diff -c'), dot: false },
  rubocop: { ext: set('rb rake'), value: set('-c --config --only --except -f --format -o --out'), bool: set('-a -A --auto-correct --parallel -P'), dot: true },
  markdownlint: { ext: set('md'), value: set('-c --config -i --ignore -r --rules -o --output'), bool: set('--fix -f'), dot: false },
  'markdownlint-cli2': { ext: set('md'), value: set(''), bool: set('--fix'), dot: false },
  yamllint: { ext: set('yaml yml'), value: set('-c -d --config-file --config-data -f --format'), bool: set('-s --strict'), dot: false },
  stylelint: { ext: set('css scss less'), value: set('--config --formatter -f --ignore-path --max-warnings'), bool: set('--fix --quiet'), dot: false },
  gofmt: { ext: set('go'), value: set('-r'), bool: set('-l -d -s -w -e'), dot: false },
  actionlint: { ext: set('yml yaml'), value: set('-config-file -format -ignore -shellcheck -pyflakes'), bool: set('-no-color -verbose'), dot: true, only: /^\.github\/workflows\// },
  hadolint: { ext: set(''), value: set('-c --config --ignore --format -f --failure-threshold -t'), bool: set('--no-color'), dot: false, name: /(^|\/)(Dockerfile[^/]*|[^/]*\.dockerfile)$/ },
};

// ---- test runners ----
// pattern: test-file predicate; ext: source extensions this runner's tests cover; value flags to skip when finding targets.
const RUNNERS = {
  pytest: { test: (f) => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py)$/.test(f), ext: set('py pyi'), value: set('-k -m -c -p -o --rootdir --maxfail --tb -n --junitxml --junit-xml --cov --cov-report --ignore --deselect -W --durations --timeout'), bool: set('-q -v -x -s -vv -qq --quiet --verbose -rA -ra --lf --ff'), sel: 'refgraph-pytest' },
  mocha: { test: (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test\/[^/]*\.[cm]?js$/.test(f), ext: set('js jsx ts tsx mjs cjs'), value: set('--require -r --reporter -R --timeout -t --config --spec --grep -g'), bool: set('--exit --recursive'), sel: 'refgraph-mocha' },
  nodetest: { test: (f) => /\.(test|spec)\.[cm]?[jt]s$/.test(f) || /(^|\/)test\/[^/]*\.[cm]?js$/.test(f), ext: set('js mjs cjs ts mts cts'), value: set('--test-name-pattern --test-concurrency --test-reporter --test-reporter-destination --import --require -r --experimental-test-coverage'), bool: set('--test --experimental-strip-types'), sel: 'refgraph-nodetest' },
  bats: { test: (f) => /\.bats$/.test(f), ext: set('sh bash bats'), value: set('-j --jobs -f --filter -T --tap'), bool: set('-r --recursive -t --tap'), sel: 'refgraph-bats' },
  rspec: { test: (f) => /_spec\.rb$/.test(f), ext: set('rb'), value: set('-e --example -t --tag --format -f -o --out -r --require'), bool: set(''), sel: 'refgraph-rspec' },
  phpunit: { test: (f) => /Test\.php$/.test(f), ext: set('php'), value: set('--filter -c --configuration --testsuite --group --exclude-group --bootstrap'), bool: set(''), sel: 'refgraph-phpunit' },
  'run-shell-tests': { test: (f) => /(^|\/)[^/]*\.test\.sh$/.test(f), ext: set('sh bash md json mjs yml yaml txt'), value: set(''), bool: set(''), sel: 'refgraph-shelltests' },
};

const isTestFile = (f) => TEST_NAME.test(f);

function resolveNpmScript(sctx, cwdRel, script) {
  const key = cwdRel + '|pkg';
  if (!sctx.cache.pkg.has(key)) {
    let pj = null; try { pj = JSON.parse(fs.readFileSync(path.join(sctx.repo, cwdRel, 'package.json'), 'utf8')); } catch { /* none */ }
    sctx.cache.pkg.set(key, pj);
  }
  const pj = sctx.cache.pkg.get(key);
  return pj && pj.scripts && typeof pj.scripts[script] === 'string' ? pj.scripts[script] : null;
}

function strip(toks) {
  // Drop leading VAR=value assignments and transparent wrappers; return {prefix, rest}.
  const prefix = []; let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) prefix.push(toks[i++]);
  let rest = toks.slice(i);
  for (;;) {
    const a = px.basename(rest[0] || '');
    if (['npx', 'bunx'].includes(a) || (['pnpm', 'yarn', 'bun'].includes(a) && ['exec', 'dlx'].includes(rest[1]))) { prefix.push(...rest.slice(0, a === 'npx' || a === 'bunx' ? 1 : 2)); rest = rest.slice(a === 'npx' || a === 'bunx' ? 1 : 2); while (rest[0] && /^--?(yes|y|no-install|quiet|q)$/.test(rest[0])) { prefix.push(rest[0]); rest = rest.slice(1); } continue; }
    if (['bash', 'sh'].includes(a) && /(^|\/)with-run-tmpdir\.sh$/.test(rest[1] || '') && rest[2]) { prefix.push(rest[0], rest[1]); rest = rest.slice(2); continue; }
    if (['uv', 'poetry', 'pipenv', 'pdm', 'hatch'].includes(a) && rest[1] === 'run') { prefix.push(rest[0], rest[1]); rest = rest.slice(2); continue; }
    if (a === 'bundle' && rest[1] === 'exec') { prefix.push(rest[0], rest[1]); rest = rest.slice(2); continue; }
    if (/^python[0-9.]*$/.test(a) && rest[1] === '-m' && rest[2]) { prefix.push(rest[0], rest[1]); rest = rest.slice(2); continue; }
    break;
  }
  return { prefix, rest };
}

const rel = (cwdRel, t) => px.normalize(px.join(cwdRel || '.', t));
const fromCwd = (cwdRel, f) => px.relative(cwdRel || '.', f) || '.';

function targetMatcher(sctx, cwdRel, targets) {
  const tests = targets.map((t) => {
    if (t === '.' || t === './') { const base = rel(cwdRel, '.'); return (f) => base === '.' || f === base || f.startsWith(base + '/'); }
    const r = rel(cwdRel, t);
    if (/[*?[]/.test(t)) { const re = globToRegex(r); return (f) => re.test(f); }
    if (fs.existsSync(path.join(sctx.repo, r)) && fs.statSync(path.join(sctx.repo, r)).isDirectory()) return (f) => f.startsWith(r.replace(/\/$/, '') + '/');
    return (f) => f === r;
  });
  return (f) => tests.some((m) => m(f));
}

// ---- reference graph (git grep) ----
function grepFiles(sctx, stems) {
  const out = new Set();
  const todo = stems.filter((s) => { if (sctx.cache.grep.has(s)) { for (const f of sctx.cache.grep.get(s)) out.add(f); return false; } return true; });
  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    const args = ['grep', '-I', '-l', '-F', '-w', '--untracked', '--exclude-standard'];
    for (const s of batch) args.push('-e', s);
    const r = git(sctx.repo, args, { timeout: 60000 });
    if (r.code > 1) return null;
    const hits = r.out.split('\n').filter(Boolean);
    // Attribute each hit to the batch (cache by batch granularity is unsafe for single stems, so re-grep singles lazily).
    if (batch.length === 1) sctx.cache.grep.set(batch[0], new Set(hits));
    for (const f of hits) out.add(f);
  }
  return out;
}

const CODE_EXT = set('js jsx ts tsx mjs cjs mts cts vue svelte py pyi go rs java kt kts scala rb php cs fs c h cc cpp hpp swift ex exs');

// Strings a referrer would contain: the full path, the basename with its extension and, for languages whose imports
// omit the extension, the bare module name. Precision matters: a generic stem would drag in the whole repo.
function stemsOf(f) {
  const e = extOf(f); const base = px.basename(f);
  const s = [f];
  if (base.length >= 5) s.push(base);
  if (CODE_EXT.has(e)) {
    const noExt = f.slice(0, f.length - e.length - 1);
    s.push(noExt);
    const bare = px.basename(noExt);
    if (bare.length >= 4) s.push(bare);
    // forge#4040: short module names (db, io, __init__) cannot be grepped bare without drowning the repo, so reference them
    // by their qualified forms: dotted python module paths and `from pkg import mod` / relative-import spellings.
    if (e === 'py' || e === 'pyi') {
      const isInit = bare === '__init__';
      const modPath = isInit ? px.dirname(noExt) : noExt;
      if (modPath && modPath !== '.') {
        const dotted = modPath.split('/').join('.');
        s.push(dotted);
        const parts = dotted.split('.'); const leaf = parts.pop();
        if (parts.length) s.push(`from ${parts.join('.')} import ${leaf}`);
        s.push(`from . import ${leaf}`, `from .${leaf} import`);
        if (isInit || bare.length < 4) s.push(modPath);
      }
    }
  }
  const m = FIXTURE_DIR.exec(f);
  if (m) { const idx = m.index + (m[1] ? m[1].length : 0); const after = f.slice(idx).split('/'); s.push(after.slice(0, 2).join('/')); if (m.index > 0) s.push(f.slice(0, idx) + after.slice(0, 2).join('/')); }
  return dedupe(s);
}

// Conventional sibling tests: foo.sh -> foo.test.sh, foo.py -> test_foo.py / foo_test.py, foo.ts -> foo.spec.ts.
function siblingTests(f, testFiles) {
  const e = extOf(f); const bare = px.basename(f, e ? '.' + e : '');
  const dir = px.dirname(f);
  return testFiles.filter((t) => {
    const tb = px.basename(t); const td = px.dirname(t);
    if (!(tb.startsWith(bare + '.test.') || tb.startsWith(bare + '.spec.') || tb.startsWith('test_' + bare + '.') || tb.startsWith(bare + '_test.') || tb === bare + '_spec.rb' || tb === bare + 'Test.java' || tb === bare + 'Test.php')) return false;
    return td === dir || td.startsWith(dir + '/') || dir.startsWith(td + '/') || td === 'tests' || td === 'test' || td.endsWith('/tests') || td.endsWith('/test') || td.endsWith('/__tests__');
  });
}

// Everything the change can reach through references (computed once per run): { files: Set, widen: reason|'' }.
function reach(sctx) {
  if (sctx.cache.reach) return sctx.cache.reach;
  const out = { files: new Set(), widen: '' };
  sctx.cache.reach = out;
  let frontier = sctx.changed.filter((f) => !isTestFile(f));
  for (const f of sctx.changed) out.files.add(f);
  const seen = new Set(frontier);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const hits = grepFiles(sctx, dedupe(frontier.flatMap(stemsOf)));
    if (hits === null) { out.widen = 'git-grep-failed'; return out; }
    if (hits.size > 600) { out.widen = `fan-out-cap: ${hits.size} files reference the change`; return out; }
    const next = [];
    // Documents that merely mention a file are leaves: a link is not a dependency, so they are not expanded further.
    for (const f of hits) { out.files.add(f); if (!isTestFile(f) && !DOC_EXT.has(extOf(f)) && !seen.has(f)) { seen.add(f); next.push(f); } }
    frontier = next;
  }
  // An unreferenced shared fixture has unknown reach: widen instead of silently selecting nothing.
  for (const f of sctx.changed) {
    if (FIXTURE_DIR.test(f) && !isTestFile(f)) {
      const hits = grepFiles(sctx, stemsOf(f).filter((x) => x.includes('/')));
      if (!hits || ![...hits].some((h) => isTestFile(h) || out.files.has(h))) { out.widen = `unreferenced-fixture: ${f}`; return out; }
    }
  }
  return out;
}

// Files reachable from ONE changed file through the reference graph (same walk as reach(), cached per file).
function reachFile(sctx, f) {
  sctx.cache.reachFile = sctx.cache.reachFile || new Map();
  if (sctx.cache.reachFile.has(f)) return sctx.cache.reachFile.get(f);
  const out = { files: new Set([f]), widen: '' };
  sctx.cache.reachFile.set(f, out);
  let frontier = [f]; const seen = new Set(frontier);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const hits = grepFiles(sctx, dedupe(frontier.flatMap(stemsOf)));
    if (hits === null) { out.widen = 'git-grep-failed'; return out; }
    if (hits.size > 600) { out.widen = `fan-out-cap: ${hits.size} files reference ${f}`; return out; }
    const next = [];
    for (const h of hits) { out.files.add(h); if (!isTestFile(h) && !DOC_EXT.has(extOf(h)) && !seen.has(h)) { seen.add(h); next.push(h); } }
    frontier = next;
  }
  return out;
}

// Every tracked, present test file in the repo: the universe the SEC-3 "reaches at least one test" check runs against.
function allTests(sctx) {
  if (!sctx.cache.allTests) sctx.cache.allTests = sctx.tracked.filter((f) => isTestFile(f) && sctx.present.has(f));
  return sctx.cache.allTests;
}

// The SEC-3 universe is limited to the step's own ecosystem: a test in another language (tests/utils.test.ts) never
// counts as covering a changed source of this one (pkg/utils.py), or a pytest step would skip instead of widen.
const ECO = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', py: 'py', pyi: 'py', sh: 'sh', bash: 'sh', bats: 'sh', rb: 'rb', php: 'php', go: 'go', java: 'jvm', kt: 'jvm', scala: 'jvm', rs: 'rs', cs: 'cs' };
const ecoOf = (f) => { const e = extOf(f); return ECO[e] || e; };
// #4068 review DRR-1: the per-ecosystem universe applies only to a step whose ecosystem has a changed source file. A step
// in another ecosystem (a node step on a Python-only change) keeps the repo-wide universe it had at a0d45ae, so it skips or
// narrows instead of widening to a full run on every single-language change.
function ecosystemTests(sctx, tests) {
  const ecos = new Set(tests.map(ecoOf));
  const touched = sctx.changed.some((f) => !isTestFile(f) && ecos.has(ecoOf(f)) && (CODE_EXT.has(extOf(f)) || /^(sh|bash)$/.test(extOf(f))));
  if (!touched) return allTests(sctx);
  return allTests(sctx).filter((t) => ecos.has(ecoOf(t)));
}

// Which of testFiles can this change reach? { selected, total, widen } ; widen is a reason string or ''.
// `universe` is the repo-wide test set used only for the SEC-3 reach check: a step that runs ONE test must not widen just
// because the change does not reach that test, only because it reaches no test anywhere. Selection stays within testFiles.
export function impactedTests(sctx, testFiles, universe = testFiles) {
  const r = reach(sctx);
  if (r.widen) return { selected: [...testFiles], total: testFiles.length, widen: r.widen };
  const selected = new Set();
  for (const t of testFiles) if (r.files.has(t) && sctx.present.has(t)) selected.add(t);
  for (const f of sctx.changed) if (!isTestFile(f)) for (const t of siblingTests(f, testFiles)) selected.add(t);
  // forge#4040 (SEC-3, per file): every changed non-test source file must itself reach at least one test (reverse-reference
  // graph or conventional sibling). One that reaches none widens the whole job: another changed file selecting tests must
  // never hide it. The reason names the file.
  const srcFiles = sctx.changed.filter((f) => !isTestFile(f) && (CODE_EXT.has(extOf(f)) || /^(sh|bash)$/.test(extOf(f))));
  const unreached = [];
  if (universe !== testFiles) universe = [...new Set([...universe, ...testFiles])];
  for (const f of srcFiles) {
    const rf = reachFile(sctx, f);
    if (rf.widen) return { selected: [...testFiles], total: testFiles.length, widen: rf.widen };
    const hit = universe.some((t) => rf.files.has(t) && sctx.present.has(t)) || siblingTests(f, universe).length > 0;
    if (!hit) unreached.push(f);
  }
  if (unreached.length) return { selected: [...testFiles], total: testFiles.length, widen: `empty-selection: no test reaches ${unreached.slice(0, 5).join(', ')}${unreached.length > 5 ? ` (+${unreached.length - 5} more)` : ''}` };
  return { selected: [...selected].sort(), total: testFiles.length, widen: '' };
}

// ---- result helpers ----
const full = (command, why, extra = {}) => ({ action: 'run', command, mode: 'full', selected: null, total: null, widen_reason: why || '', ...extra });
const scoped = (command, selected, total, selector, extra = {}) => ({ action: 'run', command, mode: 'scoped', selected, total, selector, widen_reason: '', ...extra });
const withFiles = (r, files) => ({ ...r, files: files.slice(0, 500) });
const skipNo = (selected, total, selector, why) => ({ action: 'skip', command: '', mode: 'skip', selected, total, selector, widen_reason: '', reason: why });

// Data files (config, fixtures, queries, assets read at run time) are not reachable through an import graph.
const DATA_EXT = set('json yaml yml toml sql html css scss less');

// A changed file whose reach this runner cannot know. With `native` (an import-graph selector such as jest related or
// go list) another language's source and documents are irrelevant, but data files and unknown types widen. Without it
// (the git-grep reference graph finds path/name reads too) only unknown types widen.
function unmappedFile(changed, extSet, native = false) {
  for (const f of changed) {
    const e = extOf(f);
    if (native) {
      if (extSet.has(e) && !DATA_EXT.has(e)) continue;
      if (DOC_EXT.has(e) || (SRC_EXT.has(e) && !DATA_EXT.has(e))) continue;
    } else if (extSet.has(e) || DOC_EXT.has(e) || SRC_EXT.has(e)) continue;
    if (e === '' && /(^|\/)(LICENSE|COPYING|NOTICE|CODEOWNERS|\.gitignore|\.gitattributes)$/.test(f)) continue;
    return f;
  }
  return '';
}

// ---- the entry point ----
// Returns the scoping decision for one simple command line run in cwdRel.
export function scopeCommand(cmd, cwdRel, sctx, depth = 0) {
  const toks = shellSplit(cmd);
  if (!toks || toks.length === 0) return full(cmd, '', { selector: 'unscoped:complex-shell' });
  const { prefix, rest } = strip(toks);
  if (!rest.length) return full(cmd, '', { selector: 'unscoped' });
  const tool = px.basename(rest[0]);
  const prefixStr = prefix.length ? prefix.map(shellQuote).join(' ') + ' ' : '';
  const join = (arr) => prefixStr + arr.map(shellQuote).join(' ');

  // npm/pnpm/yarn script indirection: resolve one level, scope the resolved command, run it directly.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool) && depth < 2) {
    let script = null; let extra = [];
    if (['test', 't', 'tst'].includes(rest[1]) && tool !== 'yarn') { script = 'test'; extra = rest.slice(2); }
    else if (['run', 'run-script'].includes(rest[1]) && rest[2]) { script = rest[2]; extra = rest.slice(3); }
    else if (tool === 'yarn' && rest[1] && !rest[1].startsWith('-') && !['install', 'add', 'remove', 'exec', 'dlx', 'workspace', 'workspaces'].includes(rest[1])) { script = rest[1]; extra = rest.slice(2); }
    if (script) {
      const body = resolveNpmScript(sctx, cwdRel || '.', script);
      if (body === null) return full(cmd, '', { selector: 'unscoped:script-not-found' });
      if (extra[0] === '--') extra = extra.slice(1);
      if (extra.length) return full(cmd, '', { selector: 'unscoped:script-args' });
      const inner = scopeCommand(body, cwdRel, sctx, depth + 1);
      if (inner.selector && inner.selector.startsWith('unscoped')) return full(cmd, '', { selector: inner.selector });
      return inner.action === 'skip' ? inner : { ...inner, command: prefixStr + inner.command };
    }
  }

  let r = null;
  if (LINTERS[tool] && !(LINTERS[tool].sub && !LINTERS[tool].sub.has(rest[1]))) r = scopeLint(tool, rest, cmd, cwdRel, sctx, join);
  else if (tool === 'tsc') r = scopeTsc(rest, cmd, cwdRel, sctx, join);
  else if (tool === 'jest') r = scopeJest(rest, cmd, cwdRel, sctx, join);
  else if (tool === 'vitest') r = scopeVitest(rest, cmd, cwdRel, sctx, join);
  else if (tool === 'pytest' || tool === 'py.test' || (/^python[0-9.]*$/.test(tool) && rest[1] === '-m' && rest[2] === 'pytest')) r = scopeRunner('pytest', tool === 'pytest' || tool === 'py.test' ? rest.slice(1) : rest.slice(3), tool === 'pytest' || tool === 'py.test' ? [rest[0]] : rest.slice(0, 3), cmd, cwdRel, sctx, join);
  else if (tool === 'mocha') r = scopeRunner('mocha', rest.slice(1), [rest[0]], cmd, cwdRel, sctx, join);
  else if (tool === 'bats') r = scopeRunner('bats', rest.slice(1), [rest[0]], cmd, cwdRel, sctx, join);
  else if (tool === 'rspec') r = scopeRunner('rspec', rest.slice(1), [rest[0]], cmd, cwdRel, sctx, join);
  else if (tool === 'phpunit') r = scopeRunner('phpunit', rest.slice(1), [rest[0]], cmd, cwdRel, sctx, join);
  else if (tool === 'node' && rest.includes('--test')) r = scopeRunner('nodetest', rest.slice(1), [rest[0]], cmd, cwdRel, sctx, join);
  else if (['bash', 'sh', 'node', 'python', 'python3', 'ruby', 'perl'].includes(tool) || /\.test\.sh$/.test(tool) || tool.startsWith('./')) r = scopeSingleTest(rest, cmd, cwdRel, sctx);
  if (r === null && ['bash', 'sh'].includes(tool) && rest[1] && /(^|\/)run-shell-tests\.sh$/.test(rest[1])) r = scopeRunner('run-shell-tests', rest.slice(2), rest.slice(0, 2), cmd, cwdRel, sctx, join);
  else if (r === null && tool === 'go' && rest[1] === 'test') r = scopeGo(rest, cmd, cwdRel, sctx, join);
  else if (r === null && tool === 'cargo' && rest[1] === 'test') r = scopeCargo(rest, cmd, cwdRel, sctx, join);
  else if (r === null && tool === 'mvn') r = scopeMaven(rest, cmd, cwdRel, sctx, join);
  else if (r === null && ['nx', 'turbo'].includes(tool)) r = scopeMono(tool, rest, cmd, sctx, join);
  else if (r === null && ['gradle', 'gradlew', 'dotnet', 'tox', 'nox', 'make', 'just', 'task'].includes(tool) && /\b(test|check|verify)\b/.test(cmd)) return full(cmd, '', { selector: `unscoped:no-selector:${tool}` });
  return r || full(cmd, '', { selector: 'unscoped' });
}

function scopeLint(tool, rest, cmd, cwdRel, sctx, join) {
  const spec = LINTERS[tool];
  const head = spec.sub ? rest.slice(0, 2) : rest.slice(0, 1);
  const args = rest.slice(head.length);
  const { flags, targets, ambiguous } = parseArgs(args, spec);
  if (ambiguous) return full(cmd, '', { selector: `unscoped:${ambiguous}` });
  if (targets.some((t) => t.startsWith('-') || /[$`]/.test(t))) return full(cmd, '', { selector: 'unscoped:complex-target' });
  const tgts = targets.length ? targets : (spec.dot ? ['.'] : []);
  if (!tgts.length) return full(cmd, '', { selector: 'unscoped:no-targets' });
  const inT = targetMatcher(sctx, cwdRel, tgts);
  const isFile = (f) => (spec.name ? spec.name.test(f) : spec.ext.has(extOf(f))) && (!spec.only || spec.only.test(f));
  const universe = sctx.tracked.filter((f) => inT(f) && isFile(f) && sctx.present.has(f));
  if (sctx.widen) return full(cmd, sctx.widen, { selector: `${tool}:full`, selected: universe.length, total: universe.length });
  const sel = sctx.changed.filter((f) => sctx.present.has(f) && inT(f) && isFile(f)).sort();
  if (!sel.length) return skipNo(0, universe.length, `${tool}:per-file`, 'no changed file of this tool in its targets');
  return withFiles(scoped(join([...head, ...flags, ...sel.map((f) => fromCwd(cwdRel, f))]), sel.length, universe.length, `${tool}:per-file`), sel);
}

function scopeJest(rest, cmd, cwdRel, sctx, join) {
  const { flags, targets, ambiguous } = parseArgs(rest.slice(1), { value: set('-c --config --testPathPattern -t --testNamePattern --maxWorkers -w --reporters --coverageDirectory --shard --testTimeout --roots'), bool: set('--ci --coverage -i --runInBand --silent --watchAll=false --forceExit --detectOpenHandles'), });
  if (ambiguous || targets.length) return full(cmd, '', { selector: 'unscoped:explicit-targets' });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'jest:full' });
  const files = sctx.changed.filter((f) => sctx.present.has(f) && SRC_JS.has(extOf(f)));
  const un = unmappedFile(sctx.changed, SRC_JS, true);
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: 'jest:full' });
  if (!files.length) return skipNo(0, null, 'jest-related', 'no changed JS/TS file');
  return scoped(join([rest[0], ...flags.filter((x) => x !== '--watch'), '--passWithNoTests', '--findRelatedTests', ...files.map((f) => fromCwd(cwdRel, f))]), files.length, null, 'jest-related');
}
const SRC_JS = set('js jsx ts tsx mjs cjs mts cts vue svelte');

function scopeVitest(rest, cmd, cwdRel, sctx, join) {
  const sub = rest[1] && !rest[1].startsWith('-') ? rest[1] : '';
  if (sub && sub !== 'run') return full(cmd, '', { selector: 'unscoped:vitest-subcommand' });
  const { flags, targets, ambiguous } = parseArgs(rest.slice(sub ? 2 : 1), { value: set('-c --config --reporter --root -r --coverage.reporter --shard --testTimeout'), bool: set('--coverage --silent --ui') });
  if (ambiguous || targets.length) return full(cmd, '', { selector: 'unscoped:explicit-targets' });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'vitest:full' });
  const files = sctx.changed.filter((f) => sctx.present.has(f) && SRC_JS.has(extOf(f)));
  const un = unmappedFile(sctx.changed, SRC_JS, true);
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: 'vitest:full' });
  if (!files.length) return skipNo(0, null, 'vitest-related', 'no changed JS/TS file');
  return scoped(join([rest[0], 'related', '--run', '--passWithNoTests', ...flags, ...files.map((f) => fromCwd(cwdRel, f))]), files.length, null, 'vitest-related');
}

function listTests(sctx, name) {
  const key = 'tests:' + name;
  if (!sctx.cache.lists.has(key)) sctx.cache.lists.set(key, sctx.tracked.filter((f) => sctx.present.has(f) && RUNNERS[name].test(f)));
  return sctx.cache.lists.get(key);
}

function scopeRunner(name, args, head, cmd, cwdRel, sctx, join) {
  const spec = RUNNERS[name];
  const { flags, targets, ambiguous } = parseArgs(args, spec);
  if (ambiguous) return full(cmd, '', { selector: `unscoped:${ambiguous}` });
  if (targets.some((t) => /[$`]/.test(t) || (/^[^/]+::/.test(t)))) return full(cmd, '', { selector: 'unscoped:complex-target' });
  const universe = listTests(sctx, name);
  const inT = targets.length ? targetMatcher(sctx, cwdRel, targets) : () => true;
  const candidates = universe.filter(inT);
  if (!candidates.length) return full(cmd, '', { selector: `${spec.sel}:no-candidates` });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: spec.sel, selected: candidates.length, total: candidates.length });
  const un = unmappedFile(sctx.changed.filter((f) => !isTestFile(f)), new Set([...spec.ext, ...SRC_EXT]));
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: spec.sel, selected: candidates.length, total: candidates.length });
  const imp = impactedTests(sctx, candidates, ecosystemTests(sctx, universe));
  if (imp.widen) return full(cmd, imp.widen, { selector: spec.sel, selected: candidates.length, total: candidates.length });
  if (!imp.selected.length) return skipNo(0, candidates.length, spec.sel, 'no test reaches the changed files');
  const sel = imp.selected.map((f) => fromCwd(cwdRel, f));
  return scoped(join([...head, ...flags, ...sel]), imp.selected.length, candidates.length, spec.sel);
}

// `bash scripts/x.test.sh`, `node test/x.test.mjs`, `python3 tests/test_x.py`: run only when the file is reached.
function scopeSingleTest(rest, cmd, cwdRel, sctx) {
  const tool = px.basename(rest[0]);
  const fileTok = tool.startsWith('.') || /\.test\.sh$/.test(rest[0]) ? rest[0] : rest.slice(1).find((t) => !t.startsWith('-'));
  if (!fileTok || /[$`*?]/.test(fileTok)) return null;
  const r = rel(cwdRel, fileTok);
  if (!isTestFile(r) || !sctx.present.has(r)) return null;
  if (rest.slice(rest.indexOf(fileTok) + 1).length) return full(cmd, '', { selector: 'unscoped:test-args' });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'single-test', selected: 1, total: 1 });
  const imp = impactedTests(sctx, [r], ecosystemTests(sctx, [r]));
  if (imp.widen) return full(cmd, imp.widen, { selector: 'single-test', selected: 1, total: 1 });
  if (!imp.selected.length) return skipNo(0, 1, 'single-test', `${r} not reached by the change`);
  return scoped(cmd, 1, 1, 'single-test');
}

function scopeGo(rest, cmd, cwdRel, sctx, join) {
  const { flags, targets, ambiguous } = parseArgs(rest.slice(2), { value: set('-run -skip -count -timeout -tags -p -parallel -bench -cpu -coverprofile -covermode -ldflags -vet -json'), bool: set('-v -race -short -cover -failfast -shuffle') });
  if (ambiguous) return full(cmd, '', { selector: 'unscoped:ambiguous-args' });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'go-affected' });
  if (!commandExists('go')) return null;
  const goChanged = sctx.changed.filter((f) => extOf(f) === 'go' || /(^|\/)testdata\//.test(f));
  const un = unmappedFile(sctx.changed.filter((f) => !goChanged.includes(f)), set('go'), true);
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: 'go-affected' });
  if (!goChanged.length) return skipNo(0, null, 'go-affected', 'no changed Go file');
  const ls = run('go', ['list', '-e', '-f', '{{.ImportPath}}|{{.Dir}}|{{join .Imports ","}}|{{join .TestImports ","}}|{{join .XTestImports ","}}', './...'], { cwd: path.join(sctx.repo, cwdRel || '.'), timeout: 120000 });
  if (ls.code !== 0) return full(cmd, 'go-list-failed', { selector: 'go-affected' });
  const root = path.resolve(sctx.repo);
  const pk = ls.out.split('\n').filter(Boolean).map((l) => { const [ip, dir, a, b, c] = l.split('|'); return { ip, dir: px.relative(root.split(path.sep).join('/'), dir.split(path.sep).join('/')) || '.', deps: [a, b, c].join(',').split(',').filter(Boolean) }; });
  const direct = new Set(pk.filter((p) => goChanged.some((f) => px.dirname(f) === p.dir || (/testdata\//.test(f) && f.startsWith(p.dir + '/')))).map((p) => p.ip));
  if (!direct.size) return full(cmd, 'go-package-unmapped', { selector: 'go-affected' });
  const affected = new Set(direct);
  for (let grew = true; grew;) { grew = false; for (const p of pk) if (!affected.has(p.ip) && p.deps.some((d) => affected.has(d))) { affected.add(p.ip); grew = true; } }
  const inT = targets.length ? targets.map((t) => (t.endsWith('/...') ? (ip, dir) => dir === rel(cwdRel, t.slice(0, -4)) || dir.startsWith(rel(cwdRel, t.slice(0, -4)) + '/') : (ip, dir) => dir === rel(cwdRel, t))) : [() => true];
  const pick = pk.filter((p) => affected.has(p.ip) && inT.some((m) => m(p.ip, p.dir)));
  if (!pick.length) return skipNo(0, pk.length, 'go-affected', 'no affected package in the command targets');
  return scoped(join([...rest.slice(0, 2), ...flags, ...pick.map((p) => p.ip)]), pick.length, pk.length, 'go-affected');
}

function scopeCargo(rest, cmd, cwdRel, sctx, join) {
  if (rest.some((t) => t === '-p' || t === '--package' || t.startsWith('--package='))) return full(cmd, '', { selector: 'unscoped:explicit-package' });
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'cargo-affected' });
  if (!commandExists('cargo')) return null;
  const rsChanged = sctx.changed.filter((f) => extOf(f) === 'rs');
  const un = unmappedFile(sctx.changed.filter((f) => extOf(f) !== 'rs'), set('rs'), true);
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: 'cargo-affected' });
  if (!rsChanged.length) return skipNo(0, null, 'cargo-affected', 'no changed Rust file');
  const m = run('cargo', ['metadata', '--format-version', '1', '--offline'], { cwd: path.join(sctx.repo, cwdRel || '.'), timeout: 120000 });
  if (m.code !== 0) return full(cmd, 'cargo-metadata-failed', { selector: 'cargo-affected' });
  let meta; try { meta = JSON.parse(m.out); } catch { return full(cmd, 'cargo-metadata-unreadable', { selector: 'cargo-affected' }); }
  const root = path.resolve(sctx.repo).split(path.sep).join('/');
  const members = new Set(meta.workspace_members);
  const pk = meta.packages.filter((p) => members.has(p.id)).map((p) => ({ id: p.id, name: p.name, dir: px.relative(root, px.dirname(p.manifest_path.split(path.sep).join('/'))) || '.' }));
  const direct = new Set();
  for (const f of rsChanged) { const owner = pk.filter((p) => p.dir === '.' || f === p.dir || f.startsWith(p.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0]; if (!owner) return full(cmd, `rust-file-without-crate: ${f}`, { selector: 'cargo-affected' }); direct.add(owner.id); }
  const deps = new Map((meta.resolve ? meta.resolve.nodes : []).map((n) => [n.id, n.dependencies || []]));
  const affected = new Set(direct);
  for (let grew = true; grew;) { grew = false; for (const p of pk) if (!affected.has(p.id) && (deps.get(p.id) || []).some((d) => affected.has(d))) { affected.add(p.id); grew = true; } }
  const names = pk.filter((p) => affected.has(p.id)).map((p) => p.name);
  const out = rest.filter((t) => t !== '--workspace' && t !== '--all');
  const at = out.indexOf('test') + 1;
  const pargs = names.flatMap((n) => ['-p', n]);
  return scoped(join([...out.slice(0, at), ...pargs, ...out.slice(at)]), names.length, pk.length, 'cargo-affected');
}

function scopeMaven(rest, cmd, cwdRel, sctx, join) {
  if (rest.some((t) => t === '-pl' || t === '--projects')) return full(cmd, '', { selector: 'unscoped:explicit-projects' });
  if (!rest.some((t) => ['test', 'verify', 'package', 'install'].includes(t))) return null;
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'maven-affected' });
  const mods = new Set();
  for (const f of sctx.changed) {
    let d = px.dirname(f); let found = '';
    for (;;) { if (sctx.present.has(px.join(d, 'pom.xml').replace(/^\.\//, ''))) { found = d; break; } if (d === '.' || d === '/') break; d = px.dirname(d); }
    if (!found || found === '.') { if (!DOC_EXT.has(extOf(f))) return full(cmd, `maven-root-or-unmapped: ${f}`, { selector: 'maven-affected' }); continue; }
    mods.add(found);
  }
  if (!mods.size) return skipNo(0, null, 'maven-affected', 'no changed file in a Maven module');
  return scoped(join([...rest, '-pl', [...mods].sort().join(','), '-amd']), mods.size, null, 'maven-affected');
}

// ---- TypeScript compiler: the owning tsconfig project(s) of the changed files and of the files that reference them ----
const TS_EXT = set('ts tsx mts cts js jsx mjs cjs');
const TSC_VALUE = set('-p --project -t --target -m --module --outDir --outFile --rootDir --lib --jsx --tsBuildInfoFile --declarationDir --moduleResolution --baseUrl --types --typeRoots --locale --generateTrace --maxNodeModuleJsDepth --moduleDetection --verbatimModuleSyntax');

// tsconfig.json is JSON with comments and trailing commas; null when unreadable.
function readTsconfig(sctx, dir) {
  sctx.cache.tsconfig = sctx.cache.tsconfig || new Map();
  if (sctx.cache.tsconfig.has(dir)) return sctx.cache.tsconfig.get(dir);
  let cfg = null;
  try {
    const raw = fs.readFileSync(path.join(sctx.repo, dir, 'tsconfig.json'), 'utf8');
    const noComments = raw.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, q) => q || '');
    cfg = JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
  } catch { cfg = null; }
  sctx.cache.tsconfig.set(dir, cfg);
  return cfg;
}

// The directory of the nearest tsconfig.json above `file` ('.' for the repo root), or '' when none owns it.
export function tsProjectOf(sctx, file) {
  for (let d = px.dirname(file); ; d = px.dirname(d)) {
    if (sctx.present.has(d === '.' ? 'tsconfig.json' : `${d}/tsconfig.json`)) return d;
    if (d === '.' || d === '/') return '';
  }
}

// A project `tsc -b` can build: composite itself, or listed in another tsconfig's `references`.
function tsBuildable(sctx, dir) {
  const cfg = readTsconfig(sctx, dir);
  if (cfg && cfg.compilerOptions && cfg.compilerOptions.composite === true) return true;
  if (!sctx.cache.tsRefs) {
    sctx.cache.tsRefs = new Set();
    for (const f of sctx.tracked) {
      if (px.basename(f) !== 'tsconfig.json' || !sctx.present.has(f)) continue;
      const from = px.dirname(f); const c = readTsconfig(sctx, from);
      for (const r of (c && Array.isArray(c.references) ? c.references : [])) {
        if (!r || typeof r.path !== 'string') continue;
        const to = px.normalize(px.join(from, r.path));
        sctx.cache.tsRefs.add(to.endsWith('.json') ? px.dirname(to) : to);
      }
    }
  }
  return sctx.cache.tsRefs.has(dir);
}

function scopeTsc(rest, cmd, cwdRel, sctx, join) {
  const flags = []; let project = ''; let build = false; const buildTargets = [];
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (t === '-p' || t === '--project') { if (i + 1 >= rest.length) return full(cmd, '', { selector: 'unscoped:tsc-args' }); project = rest[++i]; continue; }
    if (t.startsWith('--project=')) { project = t.slice(10); continue; }
    if (t === '-b' || t === '--build') { build = true; continue; }
    if (t === '-w' || t === '--watch') return full(cmd, '', { selector: 'unscoped:tsc-watch' });
    if (t.startsWith('-')) { flags.push(t); if (TSC_VALUE.has(t) && i + 1 < rest.length) flags.push(rest[++i]); continue; }
    if (!build) return full(cmd, '', { selector: 'unscoped:tsc-explicit-files' });
    buildTargets.push(t);
  }
  if (/[$`*?]/.test(project) || buildTargets.some((t) => /[$`*?]/.test(t))) return full(cmd, '', { selector: 'unscoped:complex-target' });
  // The project this command checks: -p X, the single -b target, else the tsconfig in its cwd.
  const targetOf = (t) => { const r = rel(cwdRel, t); return r.endsWith('.json') ? px.dirname(r) : r; };
  if (buildTargets.length > 1) return full(cmd, '', { selector: 'unscoped:explicit-targets' });
  const target = project ? targetOf(project) : buildTargets.length ? targetOf(buildTargets[0]) : rel(cwdRel, '.');
  if (sctx.widen) return full(cmd, sctx.widen, { selector: 'tsc-project' });
  const un = unmappedFile(sctx.changed, TS_EXT);
  if (un) return full(cmd, `unknown-language: ${un}`, { selector: 'tsc-project' });
  const r = reach(sctx);
  if (r.widen) return full(cmd, r.widen, { selector: 'tsc-project' });
  const tsFiles = [...r.files].filter((f) => TS_EXT.has(extOf(f)));
  if (!tsFiles.length) return skipNo(0, null, 'tsc-project', 'no changed TS/JS file');
  const owners = dedupe(tsFiles.map((f) => tsProjectOf(sctx, f)).filter(Boolean))
    .filter((d) => target === '.' || d === target || d.startsWith(target + '/')).sort();
  if (!owners.length) return skipNo(0, null, 'tsc-project', `no changed TS/JS file in ${target}`);
  // A command already aimed at one non-root project is that project's check: keep it as is.
  if (target !== '.') return scoped(cmd, owners.length, null, 'tsc-project', { projects: owners });
  if (owners.includes('.')) return full(cmd, 'root-project', { selector: 'tsc-project', projects: owners });
  if (owners.length === 1) return scoped(join([rest[0], build ? '-b' : '-p', fromCwd(cwdRel, owners[0]), ...flags]), 1, null, 'tsc-project', { projects: owners });
  if (!owners.every((d) => tsBuildable(sctx, d))) return full(cmd, 'multi-project', { selector: 'tsc-project', projects: owners });
  // Build mode rejects --noEmit; composite projects emit their declarations as the repo's own build does.
  return scoped(join([rest[0], '-b', ...owners.map((d) => fromCwd(cwdRel, d)), ...flags.filter((f) => f !== '--noEmit')]), owners.length, null, 'tsc-project', { projects: owners });
}

function scopeMono(tool, rest, cmd, sctx, join) {
  if (sctx.widen) return full(cmd, sctx.widen, { selector: `${tool}-affected` });
  const base = sctx.from || sctx.baseRef;
  if (tool === 'nx' && (rest[1] === 'run-many' || rest[1] === 'affected')) {
    const out = rest[1] === 'affected' ? rest : ['nx', 'affected', ...rest.slice(2).filter((t) => t !== '--all')];
    if (rest[1] === 'run-many' && !out.some((t) => t === '-t' || t.startsWith('--target'))) return full(cmd, '', { selector: 'unscoped:nx-no-target' });
    return scoped(join([...out, `--base=${base}`]), null, null, 'nx-affected');
  }
  if (tool === 'turbo' && rest[1] === 'run') { if (rest.some((t) => t.startsWith('--filter'))) return full(cmd, '', { selector: 'unscoped:explicit-filter' }); return scoped(join([...rest, `--filter=...[${base}]`]), null, null, 'turbo-affected'); }
  return null;
}

// Split a multi-line run block into independent simple commands when that is provably equivalent.
export function splitBlock(script) {
  const lines = script.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/^\s+|\s+$/g, '')).filter((l) => l && !l.startsWith('#'));
  if (lines.length <= 1) return lines.length ? [lines[0]] : [];
  const CONTROL = /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|\{|\}|\(|\)|;;|cd|pushd|popd|export|source|\.|set|unset|trap|alias|read|shopt|ulimit|umask|eval|exec|local|declare|readonly|shift|wait|return|exit|[A-Za-z_][A-Za-z0-9_]*=)(\s|$|=)/;
  for (const l of lines) {
    if (CONTROL.test(l) || /(\\|&&|\|\||\||&|;)$/.test(l) || l.includes('<<') || ((l.match(/'/g) || []).length % 2) || ((l.match(/"/g) || []).length % 2) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)) return [lines.join('\n')];
  }
  return lines;
}
