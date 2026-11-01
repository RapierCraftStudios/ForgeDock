// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// FORGE:SELFTEST marker (#4865): the live selftest result on the staging->main PR, and the release gate over it.
import { isTrustedComment } from "../engine/phases.mjs";

// Anchored: the marker leads the comment (postMarker writes it first), so prose that quotes a marker never counts.
const MARKER_RE = /^\s*<!--\s*FORGE:SELFTEST\s+([^>]*?)\s*-->/;

/** @param {{result:"pass"|"fail", sha:string, step?:string}} m */
export function buildMarker({ result, sha, step }) {
  return `<!-- FORGE:SELFTEST result=${result} sha=${sha} step=${step || "none"} -->`;
}

/** @returns {{result:string, sha:string, step:string}|null} null for a body without a well-formed marker. */
export function parseMarker(body) {
  const m = MARKER_RE.exec(String(body ?? ""));
  if (!m) return null;
  const kv = Object.fromEntries(m[1].split(/\s+/).map((p) => p.split("=")).filter((p) => p.length === 2));
  if (!/^(pass|fail)$/.test(kv.result ?? "") || !/^[0-9a-f]{40}$/.test(kv.sha ?? "")) return null;
  return { result: kv.result, sha: kv.sha, step: kv.step ?? "none" };
}

/** Fail closed: the newest marker must be a pass for exactly `headSha`. @param {string[]} comments comment bodies, oldest first */
export function selftestGate(comments, headSha) {
  const marks = comments.map(parseMarker).filter(Boolean);
  const last = marks[marks.length - 1];
  if (!last) return { ok: false, reason: "no FORGE:SELFTEST result on the PR; run `forgedock selftest --live --repo <sandbox> --pr <N>`" };
  if (last.result !== "pass") return { ok: false, reason: `the latest FORGE:SELFTEST failed at step ${last.step}` };
  if (last.sha !== headSha) return { ok: false, reason: `the passing FORGE:SELFTEST is for ${last.sha.slice(0, 7)}, not the PR head ${String(headSha).slice(0, 7)}` };
  return { ok: true };
}

/**
 * Bodies of the trusted comments of PR `pr` that carry a marker, oldest first (one JSON object per gh output line).
 * Only comments `isTrustedComment` accepts count (maintainer association, a Bot, FORGE_TRAIL_TRUSTED_LOGINS): anyone can
 * comment on a public PR, and a forged pass must not open the release gate. A gh failure throws (the caller fails closed).
 */
export async function readMarkerComments(gh, repo, pr) {
  const out = await gh(["api", "--paginate", `repos/${repo}/issues/${pr}/comments`, "--jq", '.[] | select(.body | test("FORGE:SELFTEST")) | {body, author_association, user: {login: .user.login, type: .user.type}} | @json']);
  return String(out).split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter(isTrustedComment).map((c) => String(c.body ?? ""));
}

export async function postMarker(gh, repo, pr, m) {
  await gh(["pr", "comment", String(pr), "-R", repo, "--body", `${buildMarker(m)}\nLive selftest: ${m.result}${m.step ? ` (step ${m.step})` : ""}`]);
}
