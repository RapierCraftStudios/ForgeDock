// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readRepo = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("shared expired review-run recovery contract", () => {
  it("defines trusted, full-SHA recovery claims and deterministic election", () => {
    const review = readRepo("commands/review-pr.md");
    assert.match(review, /One active panel per PR HEAD/);
    assert.match(review, /FORGE:REVIEW_RECOVERY_CLAIM/);
    assert.match(review, /lowest durable trusted comment ID/);
    assert.match(review, /missing, malformed, or future `Expires` value remains live/);
    assert.match(review, /expired recovery claim is ignored/);
  });

  it("keeps Pi review dispatch fresh-context while recovering stale claims", () => {
    const review = readRepo("commands/review-pr.md");
    const extension = readRepo("pi/extensions/forgedock.ts");
    assert.match(review, /forge_nested_agent/);
    assert.match(extension, /electReviewRunRecovery/);
    assert.match(extension, /formatReviewRecoveryClaim/);
    assert.match(extension, /reviewAgentPrompt\(guidancePath, repo, pr, domain, runId, headSha\)/);
    assert.match(extension, /isTrustedReviewReceiptAuthor\(comment\)/);
    assert.match(extension, /scopedReviewerDomains\(comments, \{ runId, headSha \}\)/);
    assert.match(extension, /FORGE:REVIEW-SHA:/);
  });

  it("preserves live-claim refusal and the ordinary fresh claim election", () => {
    const extension = readRepo("pi/extensions/forgedock.ts");
    assert.match(extension, /admission\.reason === "stale-active-claim"/);
    assert.match(extension, /admission\.action !== "start"/);
    assert.match(extension, /electReviewRunClaim/);
    assert.match(extension, /state: "SUPERSEDED"/);
  });
});
