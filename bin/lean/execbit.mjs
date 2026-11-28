// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Executable-bit gate (#6239). A lane creates files as 100644; the repo's own exec-bit CI is the only enforcer and
 * is off for staging PRs. Pure detector over git: for files changed base...HEAD, a file at 100644 is flagged when it
 * starts with a shebang, or is a *.sh a workflow, script, package.json or Makefile invokes directly (`./x.sh`, `x.sh`;
 * never `bash x.sh`). A 100755 -> 100644 change is a regression. Deleted files, symlinks and fixtures are skipped.
 */
const out = (git) => async (args) => { try { return String(await git(args)); } catch { return ""; } };
const FIXTURE = /(^|\/)(__fixtures__|fixtures?|testdata|__snapshots__)\//;
const CALLER = /(^|\/)(\.github\/workflows\/[^/]+|scripts\/.+|package\.json|Makefile)$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const INTERP = /\b(bash|sh|zsh|dash|source|node|python3?|\.)\s+(-\w+\s+)*$/;

/** True when `text` invokes `path` directly (not through an interpreter or `source`). */
export function invokesDirectly(text, path) {
  const re = new RegExp(`(^|[^\\w./-])(\\./)?${esc(path)}(?![\\w/-]|\\.\\w)`, "g");
  for (const line of String(text).split("\n")) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index + m[1].length);
      if (!INTERP.test(before)) return true;
    }
  }
  return false;
}

export async function execBitFindings({ git, base, readFile, listFiles }) {
  const run = out(git);
  const raw = await run(["diff", "--raw", "--no-renames", `${base}...HEAD`]);
  const rows = [];
  for (const line of raw.split("\n")) {
    const m = /^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z])\d*\t(.+)$/.exec(line);
    if (!m) continue;
    const [, from, to, status, path] = m;
    if (status === "D" || to === "120000" || to === "000000" || FIXTURE.test(path)) continue;
    rows.push({ from, to, path });
  }
  const found = [], pending = [];
  for (const r of rows) {
    if (r.to !== "100644") continue;
    if (r.from === "100755") { found.push({ path: r.path, kind: "regression", why: "executable bit removed (100755 -> 100644)" }); continue; }
    const text = (await readFile(r.path).catch(() => null)) ?? "";
    if (text.startsWith("#!")) found.push({ path: r.path, kind: "missing-x", why: "has a shebang but mode is 100644" });
    else if (r.path.endsWith(".sh")) pending.push(r.path);
  }
  if (pending.length) {
    const callers = ((await listFiles().catch(() => [])) ?? []).filter((f) => CALLER.test(f));
    const texts = [];
    for (const c of callers) texts.push([c, (await readFile(c).catch(() => null)) ?? ""]);
    for (const p of pending) {
      const by = texts.find(([c, t]) => c !== p && invokesDirectly(t, p));
      if (by) found.push({ path: p, kind: "missing-x", why: `invoked directly by ${by[0]} but mode is 100644` });
    }
  }
  return found;
}

/** Mark each missing-x / regression finding executable in the index and on disk; returns the paths fixed. */
export async function applyExecBits({ git, findings, chmod = null }) {
  const fixed = [];
  for (const f of findings ?? []) {
    if (f.kind !== "missing-x" && f.kind !== "regression") continue;
    try { await git(["update-index", "--chmod=+x", "--", f.path]); fixed.push(f.path); } catch { continue; }
    try { await chmod?.(f.path); } catch { /* the index is what counts */ }
  }
  return fixed;
}
