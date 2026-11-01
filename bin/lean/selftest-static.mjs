// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Static half of `forgedock selftest` (#4865): every `gh issue|pr view|list --json a,b` field list in bin/ must be a
// subset of the fields `gh <cmd> --help` advertises on this host (#4859: `authorAssociation` is not a gh field).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Non-test .mjs files under `dir`, recursively (node_modules skipped). */
export function listSources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listSources(p));
    else if (e.name.endsWith(".mjs") && !/\.test\.mjs$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

/** @returns {{cmd:string, fields:string[], line:number}[]} the literal gh `--json` field lists of `text` (cmd e.g. "issue view"). */
export function extractJsonFields(text) {
  const out = [];
  const re = /\[([^[\]]*?)["'`]--json["'`]\s*,\s*["'`]([A-Za-z0-9_,]+)["'`]/g;
  for (let m; (m = re.exec(text));) {
    const words = [...m[1].matchAll(/["'`]([a-z-]+)["'`]/g)].map((x) => x[1]);
    const i = words.findIndex((w, k) => (w === "issue" || w === "pr") && (words[k + 1] === "view" || words[k + 1] === "list"));
    if (i < 0) continue;
    out.push({ cmd: `${words[i]} ${words[i + 1]}`, fields: m[2].split(",").filter(Boolean), line: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** The field names of the `JSON FIELDS` section of `gh <cmd> --help`. */
export function parseHelpFields(help) {
  const lines = String(help).split("\n");
  const at = lines.findIndex((l) => /^\s*JSON FIELDS\s*$/i.test(l));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) { if (out.length) break; continue; }
    if (!/^\s/.test(l)) break;
    out.push(...l.split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/**
 * @param {{root:string, io:{gh:(args:string[])=>string, read?:(p:string)=>string, list?:(d:string)=>string[]}}} a
 * @returns {{ok:boolean, checked:number, missing:{file:string,line:number,cmd:string,field:string}[], errors:string[]}}
 */
export function staticCheck({ root, io }) {
  const read = io.read ?? ((p) => readFileSync(p, "utf8")), list = io.list ?? listSources;
  const known = new Map(), errors = [], missing = [];
  let checked = 0;
  for (const file of list(root)) {
    for (const u of extractJsonFields(read(file))) {
      if (!known.has(u.cmd)) {
        let fields = [];
        try { fields = parseHelpFields(io.gh([...u.cmd.split(" "), "--help"])); } catch (e) { errors.push(`gh ${u.cmd} --help failed: ${e.message}`); }
        if (!fields.length && !errors.length) errors.push(`gh ${u.cmd} --help lists no JSON fields`);
        known.set(u.cmd, new Set(fields));
      }
      const set = known.get(u.cmd);
      if (!set.size) continue;
      checked++;
      for (const field of u.fields) if (!set.has(field)) missing.push({ file, line: u.line, cmd: u.cmd, field });
    }
  }
  return { ok: !missing.length && !errors.length, checked, missing, errors };
}

export const realGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

export function formatStatic(r) {
  return [
    ...r.missing.map((m) => `${m.file}:${m.line}: gh ${m.cmd} --json field "${m.field}" is not offered by this gh`),
    ...r.errors,
    `static check: ${r.ok ? "ok" : "FAILED"} (${r.checked} field lists checked)`,
  ].join("\n");
}
