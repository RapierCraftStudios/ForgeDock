// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5572: docs/CONFIG.md `release` section stays true to release-config.mjs and release.mjs; drift fails CI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POLICY_SCHEMA, INIT_PROFILE, DEFERRED_KEYS, parsePolicy } from "./release-config.mjs";
import { RELEASE_USAGE } from "./release.mjs";

const DOC = readFileSync(new URL("../../docs/CONFIG.md", import.meta.url), "utf8");
const LEAN = readFileSync(new URL("../../devdocs/modules/lean.md", import.meta.url), "utf8");

const sectionOf = (text, re) => { const m = re.exec(text); if (!m) return ""; const rest = text.slice(m.index + m[0].length); const end = rest.search(/^## /m); return end < 0 ? rest : rest.slice(0, end); };
export const releaseSection = (doc) => sectionOf(doc, /^## `release` \(OPTIONAL\)\n/m);
const subsection = (sec, title) => { const i = sec.indexOf(title); if (i < 0) return ""; const rest = sec.slice(i + title.length); const e = rest.search(/^#{3,4} /m); return e < 0 ? rest : rest.slice(0, e); };
const policyRef = (sec) => { const i = sec.indexOf("### Policy reference"); if (i < 0) return ""; const rest = sec.slice(i + 3); const e = rest.search(/^### /m); return sec.slice(i, e < 0 ? undefined : i + 3 + e); };

/** Dotted key paths of the schema: `<name>` for map keys, `[]` for list items; every named key is a path. */
export function schemaPaths(schema) {
  const out = [];
  const walk = (n, p) => {
    if (n.t === "object") for (const [k, c] of Object.entries(n.p)) { const q = p ? `${p}.${k}` : k; out.push(q); walk(c, q); }
    else if (n.t === "map") walk(n.v, `${p}.<name>`);
    else if (n.t === "array") walk(n.i, `${p}[]`);
  };
  walk(schema, "");
  return out;
}
export const documentedPaths = (ref) => [...ref.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
export function keyDrift(schema, doc) {
  const want = schemaPaths(schema), have = documentedPaths(policyRef(releaseSection(doc)).split("\n#### ")[0]);
  return { undocumented: want.filter((p) => !have.includes(p)), unknown: have.filter((p) => !want.includes(p)) };
}
/** Verbs of RELEASE_USAGE: the word after `forgedock release` in each segment, plus the control verbs. */
export function usageVerbs(usage) {
  const verbs = new Set();
  for (const seg of usage.split(" | ")) {
    const m = /forgedock release ([a-z][a-z0-9-]*)(?: ([a-z|]+)(?: |$))?/.exec(seg);
    if (!m) continue;
    verbs.add(m[1]);
    if (m[1] === "control" && m[2]) m[2].split("|").forEach((v) => verbs.add(v));
  }
  return [...verbs];
}
export const undocumentedVerbs = (usage, doc) => { const cli = subsection(policyRef(releaseSection(doc)), "#### CLI reference"); return usageVerbs(usage).filter((v) => !cli.includes(`\`forgedock release ${v}\``) && !new RegExp(`\`${v}\``).test(cli)); };
const STALE = [/not automated yet/, /`--watch`[^.\n]*has no effect/, /no `rollback` verb yet/];
export const stalePhrases = (text) => STALE.filter((re) => re.test(text)).map(String);
const fenced = (sub) => /```yaml\n([\s\S]*?)```/.exec(sub)?.[1] ?? "";
const deferredList = (sub) => [...sub.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
const norm = (k) => k.replace(/: /, "=");

describe("release docs (#5572)", () => {
  it("every POLICY_SCHEMA key path is documented and every documented key exists", () => {
    const d = keyDrift(POLICY_SCHEMA, DOC);
    assert.deepEqual(d, { undocumented: [], unknown: [] });
    assert.ok(schemaPaths(POLICY_SCHEMA).length > 100);
  });
  it("seeded: a schema key missing from the doc and a documented key missing from the schema both fail", () => {
    const withNew = { ...POLICY_SCHEMA, p: { ...POLICY_SCHEMA.p, zzz_new_key: { t: "string" } } };
    assert.deepEqual(keyDrift(withNew, DOC).undocumented, ["zzz_new_key"]);
    const doc2 = DOC.replace("| `quarantine.max` |", "| `quarantine.bogus` |");
    assert.deepEqual(keyDrift(POLICY_SCHEMA, doc2), { undocumented: ["quarantine.max"], unknown: ["quarantine.bogus"] });
  });
  it("the documented zero-config YAML equals INIT_PROFILE", () => {
    const sub = subsection(policyRef(releaseSection(DOC)), "#### Zero-config profile");
    assert.equal(fenced(sub), INIT_PROFILE);
    assert.deepEqual(parsePolicy(fenced(sub)).policy, parsePolicy(INIT_PROFILE).policy);
  });
  it("the documented deferred keys equal DEFERRED_KEYS and are described as rejected", () => {
    const sub = subsection(policyRef(releaseSection(DOC)), "#### Deferred keys");
    assert.deepEqual(deferredList(sub).map(norm).sort(), DEFERRED_KEYS.map(norm).sort());
    assert.match(sub, /rejected/);
  });
  it("every verb in RELEASE_USAGE is in the CLI reference, with intake and ci budget", () => {
    assert.deepEqual(undocumentedVerbs(RELEASE_USAGE, DOC), []);
    assert.ok(usageVerbs(RELEASE_USAGE).length >= 14);
    const cli = subsection(policyRef(releaseSection(DOC)), "#### CLI reference");
    for (const s of ["forgedock intake", "forgedock ci budget", "controls log", "ci flakes", "ci nightly"]) assert.ok(cli.includes(s), s);
  });
  it("seeded: an undocumented verb fails", () => {
    assert.deepEqual(undocumentedVerbs(`${RELEASE_USAGE} | forgedock release zzzverb [--x]`, DOC), ["zzzverb"]);
  });
  it("stale phrases stay out of the release section and lean.md", () => {
    assert.deepEqual(stalePhrases(releaseSection(DOC)), []);
    assert.deepEqual(stalePhrases(LEAN), []);
    assert.ok(releaseSection(DOC).length > 1000);
  });
  it("seeded: stale phrases are detected", () => {
    assert.equal(stalePhrases("Review and fixes are not automated yet.").length, 1);
    assert.equal(stalePhrases("`--watch` has no effect").length, 1);
    assert.equal(stalePhrases("there is no `rollback` verb yet").length, 1);
  });
});
