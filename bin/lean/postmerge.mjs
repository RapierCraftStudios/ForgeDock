// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Merge-time semantic checks (#4406). Parallel sibling lanes can each add the same name (an export, a registry key) and
 * git merges both without a conflict: duplicate object keys, or a name-keyed probe map that tests only one of two
 * same-named actions. Two deterministic pieces, codebase-agnostic (git + fs, no LLM):
 *  - postMergeCommands: what base-sync runs on the merged tree before the push (forge.yaml verify.post_merge, else the
 *    lane's scoped typecheck from checks.mjs; ci mode runs no host typecheck unless one is configured);
 *  - duplicateExports: names the lane newly exports that another module of the same app or package already declares.
 */
import fs from "node:fs";
import { dirname, join, posix } from "node:path";
import { exportNames, isTestPath } from "./enumerating.mjs";

const SOURCE_RE = /\.(?:[cm]?[jt]sx?|py)$/;
const SKIP_RE = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\//;
const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml"];
const MIN_NAME = 3, MAX_NAMES = 50, CONVENTION = 3;
const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const out = (git) => async (args) => { try { return String(await git(args)); } catch { return ""; } };
const shq = (s) => (/^[\w./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

/**
 * The commands base-sync runs on the merged tree: [configured] when verify.post_merge is set, else (local/hybrid) the
 * non-skip typecheck rows of checks.mjs scopedChecks, prefixed with their package dir; [] in ci mode.
 */
export function postMergeCommands({ configured = null, scoped = [], mode = "local" } = {}) {
  const c = String(configured ?? "").trim();
  if (c) return [c];
  if (mode === "ci") return [];
  return (Array.isArray(scoped) ? scoped : [])
    .filter((r) => r && r.kind === "typecheck" && r.mode !== "skip" && String(r.command ?? "").trim())
    .map((r) => (r.cwd && r.cwd !== "." ? `cd ${shq(r.cwd)} && ${r.command}` : String(r.command)));
}

/** Declared exports only: re-exports (`export {..} from`, `export * from`) and default exports (named or not) are not collisions. */
export function declaredExports(text, path = "") {
  const t = /\.py$/.test(path) ? String(text ?? "") : String(text ?? "")
    .replace(/^\s*export\s+(?:type\s+)?\{[^}]*\}\s*from\s*["'][^"']*["'];?/gm, "")
    .replace(/^\s*export\s+\*(?:\s+as\s+[\w$]+)?\s+from\s*["'][^"']*["'];?/gm, "")
    .replace(/^(\s*)export\s+default\s+/gm, "$1");
  return exportNames(t, path).filter((n) => n !== "default");
}

/** The nearest ancestor directory of `file` holding a package manifest, else "." (the repo root). */
function packageRoot(file, manifests) {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (manifests.has(d)) return d;
    if (d === "." || d === "/" || d === "") return ".";
  }
}

/**
 * Exported names the lane added (vs `base`) in its changed non-test source files that other non-test source files of
 * the same package root already declare at HEAD. A name 3+ other modules declare is a convention (GET, metadata), not a
 * collision. @returns {Promise<Array<{symbol, path, others:string[]}>>}; never throws ([] on any failure).
 */
export async function duplicateExports({ git, cwd, base }) {
  try {
    const g = out(git);
    const keep = (f) => SOURCE_RE.test(f) && !isTestPath(f) && !SKIP_RE.test(f);
    const changed = lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`])).filter(keep);
    if (!changed.length) return [];
    const added = new Set(lines(await g(["-c", "core.quotepath=off", "diff", "--name-only", "--diff-filter=A", `${base}...HEAD`])));
    const manifests = new Set(lines(await g(["-c", "core.quotepath=off", "ls-files"])).filter((f) => MANIFESTS.includes(posix.basename(f))).map((f) => posix.dirname(f)));
    const read = (f) => { try { return fs.readFileSync(join(cwd, f), "utf8"); } catch { return ""; } };
    const res = [];
    let names = 0;
    for (const f of changed) {
      const was = new Set(added.has(f) ? [] : declaredExports(await g(["show", `${base}:${f}`]), f));
      const fresh = declaredExports(read(f), f).filter((n) => !was.has(n) && n.length >= MIN_NAME);
      const root = packageRoot(f, manifests);
      for (const name of fresh) {
        if (++names > MAX_NAMES) return res;
        const hits = lines(await g(["-c", "core.quotepath=off", "grep", "-l", "-w", "-e", name, "HEAD", "--", ...(root === "." ? [] : [`${root}/`])]))
          .map((l) => l.replace(/^HEAD:/, ""))
          .filter((p) => p !== f && keep(p) && packageRoot(p, manifests) === root);
        const others = [];
        for (const p of hits) if (declaredExports(read(p), p).includes(name)) others.push(p);
        if (others.length && others.length < CONVENTION) res.push({ symbol: name, path: f, others: others.sort() });
      }
    }
    return res;
  } catch { return []; }
}
