// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #4400: the resume digest. A resumed or recovery lane reuses the branch, but the engine-posted records of the last run
 * never reach the builder (they are excluded from the quotable issue text, #4297), so it re-derived state it had already
 * posted. This compiles a bounded digest from structured records only: the branch's changed files, the newest trusted
 * FORGE:FACTS baselines (validate command + exit), the RUN_START FORGE:STATE end reason/code/failure classes, the first
 * line of the newest trusted FORGE:NEEDS_HUMAN or FORGE:FIX_CI, and the frozen contract's deliver requirements.
 * Pure: no I/O, never throws. It goes into builder prompts only, never into the text contract quotes are checked against.
 */
import { isTrustedComment } from "../engine/phases.mjs";
import { noComments } from "./render.mjs";
import { parseFactsComment } from "./facts.mjs";

export const RESUME_DIGEST_BYTES = 2048;
const LINE_MAX = 200;
const LIST_MAX = 12;
const CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

/** One line, comments stripped and `<` escaped, so builder text can never open a comment or a FORGE marker. */
const one = (s, max = LINE_MAX) => {
  const t = noComments(String(s ?? ""), " ").replace(/\s+/g, " ").trim().replace(/</g, "&lt;");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const code = (v) => (typeof v === "string" && CODE_RE.test(v) ? v : null);
const markerOf = (body) => /^\s*<!--\s*FORGE:([A-Z_]+)\s*-->/.exec(String(body ?? ""))?.[1] ?? null;
const trusted = (c) => {
  const login = String(c?.author?.login ?? c?.user?.login ?? "");
  return isTrustedComment({ author_association: c?.authorAssociation ?? c?.author_association, user: { login, type: c?.user?.type ?? (/\[bot\]$|^app\//.test(login) ? "Bot" : "User") } });
};
/** First line of a record that is not the marker or a heading. */
const recordLine = (body) => one(noComments(String(body ?? "")).split("\n").map((l) => l.trim()).find((l) => l && !/^#+\s/.test(l)) ?? "");

/**
 * {text, files, validates, reason}: the digest text ("" when nothing is known) and its counts for the RESUME_DIGEST event. `state` is the FORGE:STATE read at RUN_START (before this run overwrites
 * it), `comments` the issue comments (only trusted ones are read), `contract` the frozen contract or null, `files` the
 * branch's changed files, `lane` the base branch. The text never exceeds `maxBytes` (UTF-8): whole lines are dropped from
 * the end, so the end reason and validate results (first) survive longest.
 */
export function buildResumeDigest({ state = null, comments = [], contract = null, files = [], lane = "", maxBytes = RESUME_DIGEST_BYTES } = {}) {
  try {
    const tc = (Array.isArray(comments) ? comments : []).filter(trusted);
    const facts = [...tc].reverse().map((c) => parseFactsComment(c?.body)).find(Boolean) ?? null;
    const last = [...tc].reverse().find((c) => ["NEEDS_HUMAN", "FIX_CI"].includes(markerOf(c?.body)));
    const validate = Array.isArray(contract?.validate) ? contract.validate : [];
    const idOf = (cmd) => validate.find((v) => one(v?.command) === cmd)?.id ?? null;

    const sections = [];
    const reason = code(state?.terminalReason), tcode = code(state?.terminalCode);
    const fails = Array.isArray(state?.failureClasses) ? [...new Set(state.failureClasses.map(code).filter(Boolean))].sort().slice(0, 5) : [];
    const why = last ? `FORGE:${markerOf(last.body)}: ${recordLine(last.body)}` : "";
    if (reason || why) sections.push(["How the last run ended:", ...(reason ? [`- ${reason}${tcode && tcode !== "unclassified" ? ` (${tcode})` : ""}${fails.length ? `; failures ${fails.join(", ")}` : ""}`] : []), ...(why ? [`- ${why}`] : [])]);
    const base = facts?.baselines ?? [];
    if (base.length) sections.push(["Validate results of the last run (command: exit):", ...base.map((b) => { const id = idOf(b.command); return `- ${id ? `${one(id, 20)} ` : ""}\`${b.command.replace(/`/g, "'")}\`: exit ${b.exit}${b.exit === 0 ? "" : " (failing)"}`; })]);
    const reqs = (Array.isArray(contract?.requirements) ? contract.requirements : []).filter((r) => r?.disposition === "deliver");
    if (reqs.length) sections.push(["Requirements to deliver (frozen contract); verify each against the branch and finish what is missing:", ...reqs.map((r) => `- ${one(r.id, 20)}: ${one(r.quote, 160)}`)]);
    const changed = (Array.isArray(files) ? files : []).map((f) => one(f)).filter(Boolean);
    if (changed.length) sections.push([`Files changed on the branch (vs ${one(lane) || "base"}):`, ...changed.slice(0, LIST_MAX).map((f) => `- ${f}`), ...(changed.length > LIST_MAX ? [`- … ${changed.length - LIST_MAX} more`] : [])]);
    const none = { text: "", files: 0, validates: 0, reason: null };
    if (!sections.length) return none;

    const head = "\n\nResume digest of the last run on this branch (engine facts, not issue text):";
    const tail = "Start from this state: do not re-derive it. Fix what failed, finish what is missing, then re-run the validate commands.";
    const size = (lines) => Buffer.byteLength([head, ...lines, tail].join("\n"), "utf8");
    const lines = sections.flatMap((s, i) => (i ? ["", ...s] : s));
    while (lines.length && size(lines) > maxBytes) lines.pop();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (!lines.length || size(lines) > maxBytes) return none;
    return { text: [head, ...lines, tail].join("\n"), files: changed.length, validates: base.length, reason };
  } catch { return { text: "", files: 0, validates: 0, reason: null }; }
}
