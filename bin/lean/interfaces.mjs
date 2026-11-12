// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5338: architecture and interface contracts bound into the decision register. One module for the four engine seams:
 *  - validation: a spike or feature epic with two or more slices needs an `## Interfaces` section (rationale line plus at
 *    least one boundary row with anchors); `checkInterfaces` is the pure check, `forgedock interfaces check` the gate
 *    (`/milestone` and `/issue` run it before creating an epic, `bootstrap-create` before creating a backlog);
 *  - registration: `seedDecisions` writes each Interfaces row and each anchored architecture choice into the register
 *    (FORGE:DECISION comment on the spike/epic issue + the local index), once per id; the lane contract then carries
 *    them as preserve rows (decisions.mjs withDecisionRows) and conformance fails a change under their anchors that
 *    neither reports the row intact nor supersedes it (conformance.mjs interfaceDecisionFailures);
 *  - contract tests: `writeContracts` generates one seam contract test per row with a machine form (seam.mjs);
 *  - consumers: `consumerNotices` / `notifyConsumers` reopen (or notify) the consumer issues, or file one issue per
 *    named consumer, when a lane's `supersedes` decision lands.
 * Pure except the injected gh/fs; no LLM.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { interfaceDecisions, interfaceRows, parseDecisionComment, renderDecision, readDecisionIndex, writeDecisionIndex } from "./decisions.mjs";
import { renderSeamTest } from "./seam.mjs";

export const INTERFACES_SECTION = "Interfaces";
export const INTERFACE_CHANGED_MARKER = "FORGE:INTERFACE_CHANGED";
const SEAM_CHECK = fileURLToPath(new URL("../../templates/contracts/seam-check.mjs", import.meta.url));

const h2 = (text) => {
  const secs = [];
  let fence = null;
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (f) { fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]; if (secs.length) secs.at(-1).lines.push(line); continue; }
    const h = fence ? null : /^##(?!#)[ \t]+(.+?)[ \t]*$/.exec(line);
    if (h) secs.push({ heading: h[1], lines: [] }); else if (secs.length) secs.at(-1).lines.push(line);
  }
  return secs;
};

const SLICE_HEADING = /^(slices?|children|sub-?issues|waves?|work items|issues|milestone plan|plan)\b/i;
const LIST_ITEM = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)\S/;

/** Slices of a spike (numbered items of its Milestone plan) or of an epic (list items of its Slices/Children/... section). */
export function sliceCount(text, kind = "auto") {
  const secs = h2(text), plan = secs.find((x) => /^milestone plan/i.test(x.heading));
  if (kind === "spike" || (kind === "auto" && plan)) return (plan?.lines.join("\n").match(/(?:^|\s)\d+\.\s/g) ?? []).length;
  const listed = secs.filter((x) => SLICE_HEADING.test(x.heading)).flatMap((x) => x.lines.filter((l) => LIST_ITEM.test(l)));
  if (listed.length) return listed.length;
  return String(text ?? "").split("\n").filter((l) => /^\s*[-*]\s+\[[ xX]\]\s+#\d+/.test(l)).length;
}

/**
 * Pure check of the Interfaces section. `required` once the body has two or more slices; then the section, its
 * `**Rationale**:` line are needed, and for an epic (the spike template ships a placeholder row) at least one boundary row
 * with anchors. `kind` is "spike", "epic" or "auto" (a body with a Milestone plan section is a spike).
 * Also lists rows whose signature has a machine form but whose Anchors cell declares no provider/consumer sides
 * (`unchecked`: no contract test can be generated for them).
 */
export function checkInterfaces(text, { kind = "auto" } = {}) {
  const slices = sliceCount(text, kind), required = slices >= 2;
  const spike = kind === "spike" || (kind === "auto" && h2(text).some((x) => /^milestone plan/i.test(x.heading)));
  const sec = h2(text).find((x) => x.heading.toLowerCase().startsWith(INTERFACES_SECTION.toLowerCase()));
  const rows = interfaceRows(text);
  const problems = [];
  if (required && !sec) problems.push(`no \`## ${INTERFACES_SECTION}\` section: ${slices} slices need one row per boundary (signature or schema, auth mode, owner issue, anchors)`);
  else if (required && !sec.lines.some((l) => /\*\*Rationale\*\*:/.test(l))) problems.push(`\`## ${INTERFACES_SECTION}\` has no **Rationale**: line`);
  else if (required && !spike && !rows.length) problems.push(`\`## ${INTERFACES_SECTION}\` has no boundary row with an anchor (a row of the template's {placeholders} does not count)`);
  const unchecked = rows.filter((r) => !r.seam && /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+\/|[\w.$]+\s*\(|(?:queue|topic|message|payload|event)\s|\{)/i.test(String(r.signature).replace(/`/g, "").trim())).map((r) => r.boundary);
  return { ok: problems.length === 0, required, slices, hasSection: Boolean(sec), rows: rows.length, problems, unchecked };
}

/** The records of `text` not yet posted on the issue (`comments` are its comment bodies): once per id. */
export function freshDecisions({ text, issue, comments = [] }) {
  const posted = new Set(comments.map((b) => parseDecisionComment(b, { issue })?.id).filter(Boolean));
  return interfaceDecisions(text, { issue }).filter((d) => !posted.has(d.id));
}

/** The comment body (marker line first) that registers one record. */
export const decisionComment = (rec) => { const m = renderDecision(rec); return `<!-- ${m.marker} -->\n${m.body}`; };

/** Synchronous registration (bootstrap-create): posts each fresh record via `post(body)`, then updates the index. Returns the records posted. */
export function seedDecisions({ text, issue, repo, comments = [], post, index = { read: readDecisionIndex, write: writeDecisionIndex } }) {
  const fresh = freshDecisions({ text, issue, comments });
  for (const d of fresh) post(decisionComment(d));
  if (fresh.length) index.write(repo, [...index.read(repo), ...fresh]);
  return fresh;
}

/** Writes `<outDir>/<id>.contract.test.mjs` for every row with a machine form, plus seam-check.mjs. Returns {written, skipped}. */
export function writeContracts({ text, issue, outDir, fs = { mkdirSync, writeFileSync, copyFileSync } }) {
  const recs = interfaceDecisions(text, { issue }), written = [];
  const wanted = recs.filter((r) => r.seam);
  if (wanted.length) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(SEAM_CHECK, join(outDir, "seam-check.mjs"));
    for (const r of wanted) {
      const file = join(outDir, `${r.id}.contract.test.mjs`);
      fs.writeFileSync(file, renderSeamTest({ v: 1, id: r.id, kind: r.seam.kind, boundary: r.choice.slice(0, 160), auth: r.seam.auth, [r.seam.kind]: r.seam[r.seam.kind], provider: r.seam.provider, consumer: r.seam.consumer }));
      written.push(file);
    }
  }
  return { written, skipped: recs.filter((r) => !r.seam).map((r) => r.id) };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "consumer";
const REF = /^#?(\d+)$/;

/** What a landed `supersedes` decision owes its consumers: [{consumer, issue|null, key}] (`#N` reopens/notifies, a name files an issue). */
export function consumerNotices(rec) {
  if (!rec?.supersedes || !rec.consumers?.length) return [];
  return rec.consumers.map((c) => { const m = REF.exec(String(c).trim()); return m ? { consumer: `#${m[1]}`, issue: Number(m[1]), key: `${rec.id}:${m[1]}` } : { consumer: String(c), issue: null, key: `${rec.id}:${slug(c)}` }; });
}

const noticeBody = (rec, n, { pr, tag }) => `<!-- ${INTERFACE_CHANGED_MARKER} decision=${rec.id} consumer=${tag} -->\n## Interface changed: ${rec.choice}\n\nDecision \`${rec.id}\` supersedes \`${rec.supersedes}\`${pr ? ` (PR #${pr})` : ""}${rec.issue ? `, recorded on #${rec.issue}` : ""}. ${n.consumer} builds against this interface: re-check it against the new contract${rec.why ? ` (${rec.why})` : ""}.\n\nGoverns: ${(rec.anchors ?? []).map((a) => `\`${a}\``).join(", ")}`;

/**
 * Tells the consumers of a superseded interface. `gh(args)` runs gh and resolves stdout. A `#N` consumer that is closed is
 * reopened (best-effort `workflow:merged` removal so it is picked up as work, not as a merge to verify) and every `#N`
 * consumer gets one FORGE:INTERFACE_CHANGED comment; a named consumer gets one new issue. Idempotent: an existing
 * comment/issue carrying the same decision+consumer marker is reused. Returns [{consumer, action, issue?}]; a failed
 * consumer is {action:"failed", error} and never throws.
 */
export async function notifyConsumers({ rec, pr = null, repo, gh }) {
  const out = [];
  for (const n of consumerNotices(rec)) {
    const tag = n.issue ? `#${n.issue}` : slug(n.consumer), marker = `${INTERFACE_CHANGED_MARKER} decision=${rec.id} consumer=${tag}`;
    try {
      if (n.issue) {
        const v = JSON.parse(String(await gh(["issue", "view", String(n.issue), "-R", repo, "--json", "state,comments"])) || "{}");
        if (String(v.state).toUpperCase() === "CLOSED") {
          await gh(["issue", "reopen", String(n.issue), "-R", repo]);
          try { await gh(["issue", "edit", String(n.issue), "-R", repo, "--remove-label", "workflow:merged"]); } catch { /* the label may not exist */ }
          out.push({ consumer: n.consumer, action: "reopened", issue: n.issue });
        } else out.push({ consumer: n.consumer, action: "notified", issue: n.issue });
        if (!(v.comments ?? []).some((c) => String(c?.body ?? "").includes(marker))) await gh(["issue", "comment", String(n.issue), "-R", repo, "--body", noticeBody(rec, n, { pr, tag })]);
        continue;
      }
      const found = JSON.parse(String(await gh(["issue", "list", "-R", repo, "--state", "all", "--search", `"${marker}" in:body`, "--json", "number", "--limit", "5"])) || "[]");
      if (found.length) { out.push({ consumer: n.consumer, action: "exists", issue: found[0].number }); continue; }
      const url = String(await gh(["issue", "create", "-R", repo, "--title", `Adapt ${n.consumer} to interface change ${rec.id}`.slice(0, 120), "--body", noticeBody(rec, n, { pr, tag })])).trim();
      out.push({ consumer: n.consumer, action: "filed", issue: Number(/\/issues\/(\d+)/.exec(url)?.[1]) || null });
    } catch (e) { out.push({ consumer: n.consumer, action: "failed", error: String(e?.message ?? e).slice(0, 160) }); }
  }
  return out;
}

/** `forgedock interfaces check|register|contract`. Resolves the exit code (1: invalid). */
export async function interfacesFromCli(argv, deps = {}) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const print = deps.print ?? ((t) => console.log(t));
  const usage = "usage: forgedock interfaces check --body-file F [--kind spike|epic] | register --issue N --body-file F [--repo o/r] | contract --issue N --body-file F [--out contracts]";
  const sub = argv[0], file = val("--body-file");
  if (!["check", "register", "contract"].includes(sub) || !file) throw new Error(usage);
  const text = deps.readFile ? deps.readFile(file) : readFileSync(file, "utf8");
  if (sub === "check") {
    const kind = val("--kind") ?? "auto";
    if (!["auto", "spike", "epic"].includes(kind)) throw new Error(usage);
    const r = checkInterfaces(text, { kind });
    for (const p of r.problems) print(`interfaces: ${p}`);
    for (const u of r.unchecked) print(`interfaces: note: "${u}" has a machine-form signature but no provider:/consumer: anchors, so no contract test is generated`);
    if (r.ok) print(`interfaces: ok (${r.slices} slice(s), ${r.rows} boundary row(s))`);
    return r.ok ? 0 : 1;
  }
  const issue = Number(val("--issue"));
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error(usage);
  if (sub === "contract") {
    const r = writeContracts({ text, issue, outDir: val("--out") ?? "contracts", ...(deps.fs ? { fs: deps.fs } : {}) });
    for (const f of r.written) print(`interfaces: wrote ${f}`);
    if (!r.written.length) print("interfaces: no row has a machine-form signature with provider: and consumer: anchors; nothing generated");
    return 0;
  }
  const repo = val("--repo") ?? deps.repo;
  if (!repo) throw new Error("interfaces register needs the repo: pass --repo owner/repo");
  const gh = deps.gh ?? (async (args, input) => (await import("node:child_process")).execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 }));
  const comments = JSON.parse(String(await gh(["issue", "view", String(issue), "-R", repo, "--json", "comments"])) || "{}").comments?.map((c) => c?.body) ?? [];
  const index = deps.index ?? { read: readDecisionIndex, write: writeDecisionIndex };
  const fresh = freshDecisions({ text, issue, comments });
  for (const d of fresh) await gh(["issue", "comment", String(issue), "-R", repo, "--body-file", "-"], decisionComment(d));
  if (fresh.length) index.write(repo, [...index.read(repo), ...fresh]);
  print(`interfaces: registered ${fresh.length} decision(s) on #${issue}${fresh.length ? `: ${fresh.map((d) => d.id).join(", ")}` : " (all already present)"}`);
  return 0;
}
