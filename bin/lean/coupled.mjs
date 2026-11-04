// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Coupled files (#5079): forge.yaml `verification.coupled_files` is a block map `{when glob: required glob[, glob]}`,
 * "if A changes, B must change" (a digest pin, a manifest, a runtime closure, CI wiring of a new test). A key prefixed
 * `added:` fires only for files the lane adds. Deterministic, 0 LLM calls; a failure is `conformance.unimplemented`.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";
import { globToRegex } from "../../scripts/ci-local/lib.mjs";

const ADDED = "added:";
const norm = (p) => String(p ?? "").trim().replace(/^\.\//, "");

/** Rules `{when, requires[], addedOnly}` from the config map; entries with no usable glob are dropped, never thrown on. */
export function parseCoupled(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const rules = [];
  for (const [key, val] of Object.entries(map)) {
    const k = String(key).trim(), addedOnly = k.startsWith(ADDED);
    const when = norm(addedOnly ? k.slice(ADDED.length) : k);
    const requires = String(val ?? "").split(",").map((g) => norm(g.replace(/^(["'])(.*)\1$/, "$2"))).filter(Boolean);
    if (when && requires.length) rules.push({ when, requires, addedOnly });
  }
  return rules;
}

/** Failures for each rule whose trigger files changed while none of a required glob's files did. */
export function coupledFailures({ rules = [], changedFiles = [], addedFiles = [] } = {}) {
  const changed = changedFiles.map(norm), added = addedFiles.map(norm), out = [];
  for (const r of rules) {
    const re = globToRegex(r.when);
    const hits = (r.addedOnly ? added : changed).filter((f) => re.test(f));
    if (!hits.length) continue;
    const missing = r.requires.filter((g) => { const gre = globToRegex(g); return !changed.some((f) => gre.test(f)); });
    if (missing.length) out.push({ code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: "coupled_file_missing", detail: `${r.addedOnly ? "added" : "changed"} ${hits.slice(0, 3).join(", ")} (forge.yaml verification.coupled_files) but no change to ${missing.join(", ")}` });
  }
  return out;
}
