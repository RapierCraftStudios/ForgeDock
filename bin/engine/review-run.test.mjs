// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideReviewRunAdmission,
  electReviewRunClaim,
  electReviewRunRecovery,
  formatReviewRecoveryClaim,
  formatReviewRunReceipt,
  parseReviewRecoveryClaims,
  parseReviewRunReceipts,
  parseScopedReviewVerdict,
  reviewPanelIntegrityError,
  scopedReviewerDomains,
} from "./review-run.mjs";

const SHA = "681031622cebda55268aa62277517fae2e91ae2e";
const receipt = (id, runId, state, extra = {}) => ({
  id,
  body: formatReviewRunReceipt({ runId, headSha: SHA, state, mode: "inline", ...extra }),
});

describe("durable review runs", () => {
  it("parses only valid full-SHA receipts from trusted authors", () => {
    const forged = receipt(9, "attacker", "STARTED");
    forged.user = { type: "User", login: "external-user" };
    forged.author_association = "NONE";
    const trustedBot = receipt(10, "run-a", "STARTED", { expiresAt: Date.now() + 60_000 });
    trustedBot.user = { type: "Bot", login: "forge[bot]" };
    trustedBot.author_association = "CONTRIBUTOR";
    const parsed = parseReviewRunReceipts([
      forged,
      trustedBot,
      { id: 11, body: "<!-- FORGE:REVIEW_RUN -->\n**Run ID**: `bad run`\n**Head SHA**: `6810316`\n**State**: STARTED" },
    ]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].runId, "run-a");
    assert.equal(parsed[0].headSha, SHA);
  });

  it("blocks both live and expired unmatched STARTED claims", () => {
    const live = decideReviewRunAdmission({ comments: [receipt(10, "run-a", "STARTED", { expiresAt: Date.now() + 60_000 })], headSha: SHA, inline: true });
    assert.equal(live.action, "blocked");
    assert.equal(live.reason, "active-claim");

    const stale = decideReviewRunAdmission({ comments: [receipt(10, "run-a", "STARTED", { expiresAt: 1 })], headSha: SHA, inline: true });
    assert.equal(stale.action, "blocked");
    assert.equal(stale.reason, "stale-active-claim");
  });

  it("elects exactly one trusted recovery claimant for an expired run", () => {
    const expiresAt = Date.now() + 60_000;
    const recovery = (id, recoveryId, extra = {}) => ({
      id,
      body: formatReviewRecoveryClaim({ recoveryId, staleRunId: "run-a", headSha: SHA, expiresAt, ...extra }),
    });
    const forged = recovery(8, "attacker");
    forged.user = { type: "User" };
    forged.author_association = "NONE";
    const comments = [forged, recovery(10, "recover-b"), recovery(9, "recover-a")];
    assert.equal(parseReviewRecoveryClaims(comments).length, 2);
    assert.equal(electReviewRunRecovery({ comments, headSha: SHA, staleRunId: "run-a", recoveryId: "recover-a" }).won, true);
    assert.equal(electReviewRunRecovery({ comments, headSha: SHA, staleRunId: "run-a", recoveryId: "recover-b" }).won, false);
  });

  it("ignores expired recovery claims so a crashed recovery owner cannot deadlock retries", () => {
    const body = [
      "<!-- FORGE:REVIEW_RECOVERY_CLAIM -->",
      "**Recovery ID**: `recover-old`",
      "**Stale Run ID**: `run-a`",
      `**Head SHA**: \`${SHA}\``,
      "**Expires**: 2000-01-01T00:00:00.000Z",
    ].join("\n");
    const election = electReviewRunRecovery({ comments: [{ id: 1, body }], headSha: SHA, staleRunId: "run-a", recoveryId: "recover-new" });
    assert.equal(election.winner, null);
  });

  it("allows retry only after a terminal BLOCKED receipt closes the claim", () => {
    const comments = [receipt(10, "run-a", "STARTED"), receipt(11, "run-a", "BLOCKED")];
    const decision = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(decision.action, "start");
    assert.equal(decision.reason, "retry-after-blocked");
  });

  it("recovers a remediation re-review from expired STARTED to fresh admissible state", () => {
    const comments = [receipt(10, "orphaned-remediation", "STARTED", { expiresAt: 1 })];
    const stale = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(stale.reason, "stale-active-claim");
    comments.push(receipt(11, "orphaned-remediation", "BLOCKED"));
    const recovered = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(recovered.action, "start");
    assert.equal(recovered.reason, "retry-after-blocked");
  });

  it("reuses an inline terminal verdict on unchanged HEAD", () => {
    const comments = [receipt(10, "run-a", "STARTED"), receipt(11, "run-a", "CHANGES_REQUESTED")];
    const decision = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(decision.action, "reuse");
    assert.equal(decision.receipt.state, "CHANGES_REQUESTED");
    assert.equal(decideReviewRunAdmission({ comments, headSha: SHA, inline: false }).action, "start");
  });

  it("blocks an inline same-HEAD COMPLETE receipt with no merge disposition", () => {
    const comments = [receipt(10, "run-a", "STARTED"), receipt(11, "run-a", "COMPLETE")];
    const decision = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(decision.action, "blocked");
    assert.equal(decision.reason, "incomplete-inline-disposition");
  });

  it("does not let an earlier standalone COMPLETE receipt block inline work-on review", () => {
    const comments = [
      receipt(10, "run-a", "STARTED", { mode: "standalone" }),
      receipt(11, "run-a", "COMPLETE", { mode: "standalone" }),
    ];
    assert.equal(decideReviewRunAdmission({ comments, headSha: SHA, inline: true }).action, "start");
  });

  it("elects one deterministic winner among concurrent claims", () => {
    const comments = [receipt(22, "run-b", "STARTED"), receipt(21, "run-a", "STARTED")];
    const election = electReviewRunClaim({ comments, headSha: SHA, runId: "run-a" });
    assert.equal(election.won, true);
    assert.equal(election.winner.runId, "run-a");
    assert.equal(electReviewRunClaim({ comments, headSha: SHA, runId: "run-b" }).won, false);
  });

  it("keeps the active winner visible after a losing claim posts SUPERSEDED", () => {
    const comments = [
      receipt(21, "run-a", "STARTED"),
      receipt(22, "run-b", "STARTED"),
      receipt(23, "run-b", "SUPERSEDED"),
    ];
    const decision = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(decision.action, "blocked");
    assert.equal(decision.receipt.runId, "run-a");
  });

  it("pairs a reused run ID independently on each full HEAD SHA", () => {
    const nextSha = "781031622cebda55268aa62277517fae2e91ae2e";
    const comments = [
      receipt(21, "same-id", "STARTED"),
      { id: 22, body: formatReviewRunReceipt({ runId: "same-id", headSha: nextSha, state: "BLOCKED", mode: "inline" }) },
    ];
    const decision = decideReviewRunAdmission({ comments, headSha: SHA, inline: true });
    assert.equal(decision.action, "blocked");
    assert.equal(decision.receipt.state, "STARTED");
  });

  it("requires verdict and reviewer receipts to match both run and full SHA", () => {
    const runId = "run-a";
    const entries = [{ id: 20, user: { type: "Bot" }, author_association: "CONTRIBUTOR", body: [
      "<!-- FORGE:REVIEW -->",
      `<!-- FORGE:REVIEW-RUN:${runId} -->`,
      `<!-- FORGE:REVIEW-SHA:${SHA} -->`,
      "**Verdict**: PASS",
      "**Selected isolated reviewers**: 2",
      "**Verified reviewer receipts**: 2",
    ].join("\n") }, { id: 21, user: { type: "User" }, author_association: "NONE", body: [
      "<!-- FORGE:REVIEW -->",
      `<!-- FORGE:REVIEW-RUN:${runId} -->`,
      `<!-- FORGE:REVIEW-SHA:${SHA} -->`,
      "**Verdict**: CHANGES REQUESTED",
      "**Selected isolated reviewers**: 99",
      "**Verified reviewer receipts**: 99",
    ].join("\n") }];
    assert.deepEqual(parseScopedReviewVerdict(entries, { runId, headSha: SHA })?.verdict, "PASS");
    assert.equal(parseScopedReviewVerdict(entries, { runId: "other", headSha: SHA }), null);

    const comments = [
      { body: `<!-- FORGE:REVIEW-AGENT:security -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${SHA} -->` },
      { body: `<!-- FORGE:REVIEW-AGENT:workflow -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${SHA} -->` },
      { body: `<!-- FORGE:REVIEW-AGENT:performance -->\n<!-- FORGE:REVIEW-AGENT:architecture -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${SHA} -->` },
      { user: { type: "User" }, author_association: "NONE", body: `<!-- FORGE:REVIEW-AGENT:forged -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${SHA} -->` },
    ];
    const domains = scopedReviewerDomains(comments, { runId, headSha: SHA });
    assert.deepEqual(domains, ["security", "workflow"]);
    assert.equal(reviewPanelIntegrityError({ selected: 2, completed: 2 }, domains), null);
    assert.match(reviewPanelIntegrityError({ selected: 0, completed: 0 }, []), /selected=0/);
    assert.match(reviewPanelIntegrityError({ selected: 1, completed: 1 }, ["workflow"]), /security/);
  });
});
