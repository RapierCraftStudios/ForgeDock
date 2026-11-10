// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5284: production parity beyond ingress. forge.yaml `topology.prod_parity` is a block map `{path glob: command | "note: how to verify"}`
 * of production-only facts (runtime build mode, migration role vs app role, env scope, ingress). A lane that changes a file matching a
 * glob needs that surface's evidence: a command rule runs once with the matching paths as arguments (non-zero blocks); a note rule needs
 * `parity: [{surface: <glob>, justification}]` in the lane's result file. Deterministic, 0 LLM calls; core stays repo-agnostic (#1347).
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";

const NOTE = /^note:\s*/i;
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Rules `{glob, command|note}` from the config map; entries with no glob or value are dropped. */
export function parseProdParity(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const rules = [];
  for (const [key, val] of Object.entries(map)) {
    const glob = norm(key), v = String(val ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (!glob || !v) continue;
    rules.push(NOTE.test(v) ? { glob, note: v.replace(NOTE, "") } : { glob, command: v });
  }
  return rules;
}

/** Declared surfaces with the changed files they match: [{rule, files}]. */
export function touchedSurfaces(rules, changedFiles) {
  const changed = (changedFiles ?? []).map(norm);
  return (rules ?? []).map((rule) => { const re = globToRegex(rule.glob); return { rule, files: changed.filter((f) => re.test(f)) }; }).filter((s) => s.files.length);
}

/**
 * Blocking failures (conformance.unimplemented) for touched surfaces lacking evidence. `run` is ({command}) => {rc, output}
 * (a `{r: {rc, output}}` wrapper is unwrapped). A command that cannot start (rc 127) is reported: a declared check that never ran is no evidence.
 */
export async function prodParityFailures({ rules, changedFiles, result, run }) {
  const out = [], given = Array.isArray(result?.parity) ? result.parity : [];
  for (const { rule, files } of touchedSurfaces(rules, changedFiles)) {
    if (rule.command) {
      let r;
      try { r = await run({ command: `${rule.command} ${files.map(sq).join(" ")}` }); r = r?.r ?? r; } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
      if (r?.rc === 0) continue;
      const tail = String(r?.output ?? "").trim().split("\n").slice(-12).join("\n").slice(0, 1500);
      out.push({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: "prod_parity_failed", detail: `forge.yaml topology.prod_parity \`${rule.glob}\` (\`${rule.command}\`) exited ${r?.rc ?? "?"} for ${files.slice(0, 3).join(", ")}${tail ? `:\n${tail}` : ""}` });
    } else if (!given.some((p) => norm(p?.surface) === rule.glob && String(p?.justification ?? "").trim())) {
      out.push({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: "prod_parity_unjustified", detail: `${files.slice(0, 3).join(", ")} touches the production-only surface \`${rule.glob}\` (forge.yaml topology.prod_parity): verify "${rule.note}" and record parity: [{"surface":"${rule.glob}","justification":"<evidence>"}] in the result file` });
    }
  }
  return out;
}
