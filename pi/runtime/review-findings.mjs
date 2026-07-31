// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure policy helpers for the native Pi review gate.
 *
 * Reviewer receipts are immutable PR comments, while the lifecycle of a
 * review-finding is stored on its GitHub issue. Keeping those inputs separate
 * prevents a finding from an earlier review run from re-entering a later clean
 * review merely because its original comment remains on the PR.
 */

const FINDING_MARKER = /<!-- FINDING:[^>]+ -->/;

function labelNames(labels) {
  if (!Array.isArray(labels)) throw new TypeError("review-finding labels must be an array");
  return labels.map((label) => {
    if (typeof label === "string") return label.toLowerCase();
    if (label && typeof label === "object" && typeof label.name === "string") return label.name.toLowerCase();
    throw new TypeError("review-finding labels must contain strings or named objects");
  });
}

function validateOptions({ comments, runId, domains, findingIssues }) {
  if (!Array.isArray(comments)) throw new TypeError("review comments must be an array");
  if (typeof runId !== "string" || runId.length === 0) throw new TypeError("review run id is required");
  if (!Array.isArray(domains) || domains.length === 0 || domains.some((domain) => typeof domain !== "string" || domain.length === 0)) {
    throw new TypeError("review domains must be a non-empty string array");
  }
  if (!Array.isArray(findingIssues)) throw new TypeError("review findings must be an array");
}

/**
 * Reconcile current-run reviewer receipts with the lifecycle of prior finding
 * issues. The caller must supply complete GitHub responses; malformed shapes
 * throw so a review cannot fail open.
 *
 * @param {{comments: Array<{body: string}>, runId: string, domains: string[], findingIssues: Array<{state: string, labels: Array<string|{name: string}>}>}} options
 * @returns {{currentRunFindings: Array<{domain: string, body: string}>, openPriorFindings: Array<object>, hasBlockingFindings: boolean}}
 */
export function reconcileReviewFindings({ comments, runId, domains, findingIssues } = {}) {
  validateOptions({ comments, runId, domains, findingIssues });

  const currentRunFindings = [];
  for (const comment of comments) {
    if (!comment || typeof comment !== "object" || typeof comment.body !== "string") {
      throw new TypeError("review comments must contain string bodies");
    }
    const body = comment.body;
    const domain = domains.find((candidate) => body.includes(`<!-- FORGE:REVIEW-AGENT:${candidate} -->`));
    if (domain && body.includes(`<!-- FORGE:REVIEW-RUN:${runId} -->`) && FINDING_MARKER.test(body)) {
      currentRunFindings.push({ domain, body });
    }
  }

  const openPriorFindings = [];
  for (const issue of findingIssues) {
    if (!issue || typeof issue !== "object" || typeof issue.state !== "string") {
      throw new TypeError("review-finding issues must contain a state");
    }
    const state = issue.state.toUpperCase();
    if (state !== "OPEN" && state !== "CLOSED") throw new TypeError(`unsupported review-finding state: ${issue.state}`);
    const labels = labelNames(issue.labels);
    if (state === "OPEN" && !labels.includes("false-positive")) openPriorFindings.push(issue);
  }

  return {
    currentRunFindings,
    openPriorFindings,
    hasBlockingFindings: currentRunFindings.length > 0 || openPriorFindings.length > 0,
  };
}
