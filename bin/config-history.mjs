// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// bin/config-history.mjs — versioned forge.yaml history (#5315), kept under ~/.forge/config-history/<repo>/ and never in the repo.
// Layout: <n>.yaml per version plus index.json [{n, at, reason, sha, source?}]. Setup and agent edits record a version instead of
// leaving forge.yaml.bak-* files behind; rollback records the current file first, so it is itself undoable.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** FORGE_CONFIG_HISTORY_DIR overrides the store root (tests, relocated homes). */
export function historyRoot(env = process.env) {
  return env.FORGE_CONFIG_HISTORY_DIR || join(env.HOME || env.USERPROFILE || homedir(), ".forge", "config-history");
}

/** `<owner>__<repo>` from the forge.yaml project block, else the checkout directory name. */
export function repoKey(cwd, text = "") {
  const o = text.match(/^\s+owner:\s+"?([\w.-]+)"?/m)?.[1], r = text.match(/^\s+repo:\s+"?([\w.-]+)"?/m)?.[1];
  return o && r ? `${o}__${r}` : basename(cwd);
}

const sha = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const dirOf = (root, repo) => join(root, repo);
const writeAtomic = (file, data) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, data); renameSync(tmp, file); };

export function listVersions({ root = historyRoot(), repo }) {
  try { return JSON.parse(readFileSync(join(dirOf(root, repo), "index.json"), "utf8")); } catch { return []; }
}

/** Record `text` as the next version; an identical-to-latest text is not recorded again. */
export function recordVersion({ root = historyRoot(), repo, text, reason, source, now = new Date() }) {
  const dir = dirOf(root, repo);
  mkdirSync(dir, { recursive: true });
  const index = listVersions({ root, repo });
  const last = index[index.length - 1];
  if (last && last.sha === sha(text) && !source) return { n: last.n, recorded: false };
  const n = (last?.n ?? 0) + 1;
  writeAtomic(join(dir, `${n}.yaml`), text);
  index.push({ n, at: now.toISOString(), reason: reason || "edit", sha: sha(text), ...(source ? { source } : {}) });
  writeAtomic(join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return { n, recorded: true };
}

export function readVersion({ root = historyRoot(), repo, n }) {
  if (!listVersions({ root, repo }).some((v) => v.n === Number(n))) return null;
  return readFileSync(join(dirOf(root, repo), `${Number(n)}.yaml`), "utf8");
}

/** Line diff (LCS) as `-`/`+` lines; "" when equal. */
export function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const t = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push(`- ${x[i++]}`); else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out.join("\n");
}

/** Diff version n against the current file (or against `against`, another version). Null when n is unknown. */
export function diffVersion({ root = historyRoot(), repo, n, file, against }) {
  const old = readVersion({ root, repo, n });
  const cur = against !== undefined ? readVersion({ root, repo, n: against }) : existsSync(file) ? readFileSync(file, "utf8") : "";
  return old === null || cur === null ? null : lineDiff(old, cur);
}

/** Restore version n into `file`; the current content is recorded first (reason "before rollback to n"). */
export function rollback({ root = historyRoot(), repo, n, file, now }) {
  const old = readVersion({ root, repo, n });
  if (old === null) return { ok: false, error: `no version ${n}` };
  const saved = existsSync(file) ? recordVersion({ root, repo, text: readFileSync(file, "utf8"), reason: `before rollback to ${n}`, now }) : null;
  writeAtomic(file, old);
  return { ok: true, saved: saved?.recorded ? saved.n : null };
}

const BAK = /^forge\.yaml\.bak([-.].+)?$/;

/** Import forge.yaml.bak / .bak-<date>-<reason> files from `dir` (oldest first, once each by file name); deletes them with `del`. */
export function importBak({ root = historyRoot(), repo, dir, del = false, now }) {
  const names = readdirSync(dir).filter((f) => BAK.test(f)).sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs);
  const seen = new Set(listVersions({ root, repo }).map((v) => v.source).filter(Boolean));
  const imported = [], skipped = [], deleted = [];
  for (const name of names) {
    const file = join(dir, name);
    if (!seen.has(name)) {
      const reason = `imported ${name}`;
      recordVersion({ root, repo, text: readFileSync(file, "utf8"), reason, source: name, now: now ?? new Date(statSync(file).mtimeMs) });
      imported.push(name);
    } else skipped.push(name);
    if (del) { unlinkSync(file); deleted.push(name); }
  }
  return { found: names, imported, skipped, deleted };
}

/** Setup/agent edit of forge.yaml: record the current content as a version and move the file away (no .bak in the repo). */
export function backupToHistory(outputPath, reason, opts = {}) {
  if (!existsSync(outputPath)) return null;
  const text = readFileSync(outputPath, "utf8");
  const repo = repoKey(dirname(outputPath), text);
  const { n } = recordVersion({ root: opts.root, repo, text, reason, now: opts.now });
  unlinkSync(outputPath);
  return { backupName: `config-history ${repo} v${n}` };
}

/** `forgedock config history|diff <n>|rollback <n>|import-bak [--delete]`: returns the exit code. */
export function runConfigCommand(sub, rest, { cwd, out = (s) => console.log(s), env = process.env, confirm } = {}) {
  const file = join(cwd, "forge.yaml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const repo = repoKey(cwd, text), root = historyRoot(env);
  const n = rest.find((a) => /^\d+$/.test(a));
  if (sub === "history") {
    const vs = listVersions({ root, repo });
    if (!vs.length) out(`No config history for ${repo} (${join(root, repo)}).`);
    for (const v of vs) out(`  v${v.n}  ${v.at}  ${v.reason}`);
    return 0;
  }
  if (sub === "diff" || sub === "rollback") {
    if (!n) { out(`Usage: npx forgedock config ${sub} <n>   (see: npx forgedock config history)`); return 1; }
    if (sub === "diff") {
      const d = diffVersion({ root, repo, n, file });
      if (d === null) { out(`No version ${n} for ${repo}.`); return 1; }
      out(d || `v${n} is identical to the current forge.yaml.`);
      return 0;
    }
    const r = rollback({ root, repo, n, file });
    if (!r.ok) { out(`No version ${n} for ${repo}.`); return 1; }
    out(`Restored forge.yaml from v${n}.${r.saved ? ` The previous content is v${r.saved}.` : ""}`);
    return 0;
  }
  if (sub === "record") {
    if (!text) { out("No forge.yaml to record."); return 1; }
    const r = recordVersion({ root, repo, text, reason: rest.filter((a) => !a.startsWith("--")).join(" ") || "edit" });
    out(r.recorded ? `Recorded forge.yaml as v${r.n} (${join(root, repo)}).` : `forge.yaml is unchanged since v${r.n}.`);
    return 0;
  }
  if (sub === "import-bak") {
    const del = rest.includes("--delete") || (confirm ? confirm() : false);
    const r = importBak({ root, repo, dir: cwd, del });
    out(`Found ${r.found.length} forge.yaml backup file(s); imported ${r.imported.length}, already imported ${r.skipped.length}.`);
    if (r.found.length && !del) out("  Re-run with --delete to remove them from the repo (they are now in the history).");
    if (r.deleted.length) out(`  Deleted ${r.deleted.length} file(s).`);
    return 0;
  }
  out("Usage: npx forgedock config history | diff <n> | rollback <n> | record [reason] | import-bak [--delete]");
  return 1;
}
