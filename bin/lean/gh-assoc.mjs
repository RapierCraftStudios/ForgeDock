// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4859: `gh issue view|list --json` has no `authorAssociation` field (gh 2.97: `Unknown JSON field`); it exists on
// comments and in REST as `author_association`. Trust reads take it from REST and fail closed (undefined = untrusted).

/** The fields `gh issue view|list --json` lists in gh 2.97. `authorAssociation` is deliberately absent. */
export const ISSUE_JSON_FIELDS = Object.freeze([
  "assignees", "author", "body", "closed", "closedAt", "closedByPullRequestsReferences", "comments", "createdAt", "id",
  "isPinned", "labels", "milestone", "number", "projectCards", "projectItems", "reactionGroups", "state", "stateReason",
  "title", "updatedAt", "url",
]);

const repoPath = (repo) => repo || "{owner}/{repo}"; // gh api fills the placeholders from the cwd checkout

/** The issue author's association (OWNER, MEMBER, ...) via REST, or undefined when it cannot be read. */
export async function issueAssociation(gh, repo, n) {
  try { return String(await gh(["api", `repos/${repoPath(repo)}/issues/${n}`, "--jq", ".author_association"])).trim() || undefined; } catch { return undefined; }
}

/** Map issue number to author association for the repo's open issues (one paginated REST list); empty on failure. */
export async function listAssociations(gh, repo) {
  const out = new Map();
  try {
    const text = String(await gh(["api", `repos/${repoPath(repo)}/issues?state=open&per_page=100`, "--paginate", "--jq", '.[] | "\\(.number)\\t\\(.author_association)"']));
    for (const line of text.split("\n")) { const [n, a] = line.trim().split("\t"); if (/^\d+$/.test(n) && a) out.set(Number(n), a); }
  } catch { /* unreadable: every author is untrusted */ }
  return out;
}

/** `gh issue view --json <fields>` parsed, with `authorAssociation` merged in from REST. A failed view throws; a failed association leaves it unset. */
export async function viewIssue(gh, repo, n, fields) {
  const [raw, authorAssociation] = await Promise.all([
    gh(["issue", "view", String(n), ...(repo ? ["-R", repo] : []), "--json", fields]),
    issueAssociation(gh, repo, n),
  ]);
  return { ...JSON.parse(raw), authorAssociation };
}
