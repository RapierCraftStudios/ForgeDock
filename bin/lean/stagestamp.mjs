// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stage-file provenance (#5333): the builder writes `forge-stamp: issue=N contract=HASH` as the first line of each
 * `.forge-lean/*.md` stage note. A note stamped for another issue or contract (a `git stash pop` that applied another
 * lane's files) is never posted. Pure: no I/O. A missing stamp is accepted (older notes, builders that skipped it).
 */

const STAMP_RE = /^[ \t]*forge-stamp:[ \t]*issue=(\d+)(?:[ \t]+contract=([0-9a-f]+|-))?[ \t]*$/im;

/** The stamp line for this run; `hash` is null before the contract is frozen (planning). */
export const stampText = ({ issue, hash = null }) => `forge-stamp: issue=${issue} contract=${hash ?? "-"}`;

/** Prompt text telling the builder to stamp its stage notes and not to use the shared stash. */
export const stampRule = (stamp) => (stamp ? `\n\nStage notes: make the first line of every ${"`.forge-lean/*.md`"} file you write exactly \`${stamp}\` (the engine refuses to post a note stamped for another issue or contract).` : "");

/**
 * @returns {{ok: boolean, md: string, reason?: string}} md is the note without its stamp line; ok=false on an issue/contract mismatch.
 */
export function checkStamp(md, { issue, hash = null }) {
  const text = String(md ?? "");
  const m = STAMP_RE.exec(text);
  if (!m) return { ok: true, md: text };
  const stripped = text.replace(m[0], "").replace(/^\s*\n/, "");
  if (Number(m[1]) !== Number(issue)) return { ok: false, md: stripped, reason: `stamped for issue #${m[1]}, run is #${issue}` };
  if (hash && m[2] && m[2] !== "-" && m[2] !== hash) return { ok: false, md: stripped, reason: `stamped for contract ${m[2]}, run froze ${hash}` };
  return { ok: true, md: stripped };
}
