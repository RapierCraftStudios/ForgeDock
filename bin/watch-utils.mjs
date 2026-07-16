// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure, independently-testable helpers for `forgedock watch` (bin/forgedock.mjs).
 *
 * Extracted out of watch()/render() (forge#2235) so the label-derivation,
 * findings-lane classification, priority normalization, satellite-repo
 * parsing, and heartbeat-batching logic can be unit tested without spawning
 * `gh` subprocesses. None of these functions perform I/O themselves — the
 * caller in forgedock.mjs reads files / shells out and passes the results in.
 */

import { existsSync, readFileSync } from "fs";

/**
 * Conservative built-in fallback for the watched label set, used only when
 * bin/labels.json is missing or unreadable. Historically this was the ONLY
 * label set watch() ever used (forge#2235) — kept here so a broken/missing
 * manifest degrades to the old (narrow but working) behavior instead of
 * watch() going fully blind.
 */
export const FALLBACK_WORKFLOW_LABELS = [
  "workflow:investigating",
  "workflow:ready-to-build",
  "workflow:building",
  "workflow:in-review",
  "needs-human",
];

/**
 * The label that marks a review-finding issue, watched in its own lane
 * (forge#2235) independent of workflow:* state — a finding is born without
 * any workflow:* label and may never acquire one (deferred/PERMANENT_DEFERRED
 * findings), so it must not depend on the in-flight label set to be visible.
 */
export const FINDINGS_LANE_LABEL = "review-finding";

/**
 * Derive the watched "in-flight" label set from the canonical bin/labels.json
 * manifest instead of a hardcoded literal (forge#2235). Returns every label
 * whose name starts with "workflow:", plus "needs-human" (the terminal-stall
 * pipeline label, not itself prefixed workflow: but part of the same family).
 *
 * Falls back to FALLBACK_WORKFLOW_LABELS if the manifest is absent, unreadable,
 * or malformed, so a broken manifest never makes watch() go silent.
 *
 * @param {string} labelsJsonPath - absolute path to bin/labels.json
 * @returns {string[]}
 */
export function deriveWorkflowLabels(labelsJsonPath) {
  try {
    if (!existsSync(labelsJsonPath)) return FALLBACK_WORKFLOW_LABELS;
    const raw = readFileSync(labelsJsonPath, "utf-8");
    const all = JSON.parse(raw);
    if (!Array.isArray(all)) return FALLBACK_WORKFLOW_LABELS;
    const derived = all
      .map((l) => l && l.name)
      .filter((name) => typeof name === "string" && (name.startsWith("workflow:") || name === "needs-human"));
    return derived.length > 0 ? derived : FALLBACK_WORKFLOW_LABELS;
  } catch {
    return FALLBACK_WORKFLOW_LABELS;
  }
}

/**
 * Normalize a mixed label array (strings or {name} objects, as returned by
 * `gh issue list --json labels`) into a plain array of name strings.
 * @param {Array<string|{name: string}>} labels
 * @returns {string[]}
 */
function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map((l) => (typeof l === "string" ? l : l && l.name)).filter(Boolean);
}

/**
 * Classify a review-finding issue's render status in the findings lane from
 * its full label set (forge#2235). Callers should only invoke this for
 * issues that do NOT carry a workflow:* label — those are in-flight and
 * belong in the main table, not the findings lane, to avoid double-rendering
 * the same issue in two places.
 *
 * - "validated"      — confirmed as a real issue (label: validated)
 * - "false-positive" — dismissed (label: false-positive)
 * - "queued"         — awaiting human validation (label: needs-validation)
 * - "deferred"       — bare review-finding with none of the above; this is
 *                       the previously-invisible "PERMANENT_DEFERRED" bucket
 *
 * @param {Array<string|{name: string}>} labels
 * @returns {"validated"|"false-positive"|"queued"|"deferred"}
 */
export function classifyFindingStatus(labels) {
  const names = labelNames(labels);
  if (names.includes("validated")) return "validated";
  if (names.includes("false-positive")) return "false-positive";
  if (names.includes("needs-validation")) return "queued";
  return "deferred";
}

/**
 * True if the given label set carries any workflow:*-family label (i.e. the
 * issue is "in-flight" per deriveWorkflowLabels()'s family, not just the
 * literal "workflow:" prefix check — needs-human counts too).
 *
 * @param {Array<string|{name: string}>} labels
 * @param {string[]} workflowLabels - the label set returned by deriveWorkflowLabels()
 * @returns {boolean}
 */
export function hasWorkflowLabel(labels, workflowLabels) {
  const names = new Set(labelNames(labels));
  return workflowLabels.some((wl) => names.has(wl));
}

/**
 * Normalize a priority label to a short display form ("P0".."P3"), accepting
 * both the canonical `priority:P<n>` form and the bare `P<n>` form used by
 * some consumer repos (forge#2232 established this same dual-form handling
 * for priority extraction elsewhere in the pipeline; forge#2235 applies it to
 * watch's render rows).
 *
 * Canonical `priority:P<n>` wins if both happen to be present.
 *
 * @param {Array<string|{name: string}>} labels
 * @returns {string|null} e.g. "P1", or null if no priority label found
 */
export function normalizePriority(labels) {
  const names = labelNames(labels);
  const canonical = names.find((n) => /^priority:P[0-3]$/.test(n));
  if (canonical) return canonical.replace("priority:", "");
  const bare = names.find((n) => /^P[0-3]$/.test(n));
  return bare || null;
}

/**
 * Parse `repos.satellites[].repo` entries out of a forge.yaml file's raw
 * text, without a YAML parser dependency — consistent with the rest of
 * forgedock.mjs's regex-based forge.yaml reads (resolveLabelsRepo,
 * stall_timeout_minutes, etc.). Returns [] when no `satellites:` section is
 * present, so callers degrade to exactly the previous single-repo behavior.
 *
 * @param {string} forgeYamlText
 * @returns {string[]} "owner/repo" strings
 */
export function parseSatelliteRepos(forgeYamlText) {
  if (typeof forgeYamlText !== "string") return [];
  const idx = forgeYamlText.indexOf("satellites:");
  if (idx === -1) return [];
  const tail = forgeYamlText.slice(idx + "satellites:".length);
  // Stop at the next non-indented (top-level) key so an unrelated later
  // section's `repo:` field is never picked up as a satellite.
  const stopMatch = tail.match(/\n[^\s#][^\n]*/);
  const section = stopMatch ? tail.slice(0, stopMatch.index) : tail;
  const repos = [];
  const re = /repo:\s*["']?([^\s"'#]+)["']?/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    repos.push(m[1]);
  }
  return repos;
}

/**
 * Escape a value for safe interpolation inside a double-quoted GraphQL
 * string literal (forge#2307). Backslash MUST be escaped first — escaping
 * `"` before `\` would double-escape the backslashes just introduced by the
 * quote-escaping step. A value with no special characters round-trips
 * unchanged, so this is a no-op for the overwhelming common case (plain
 * alphanumeric owner/repo names).
 *
 * @param {string} value
 * @returns {string}
 */
function escapeGraphQLString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a single GraphQL query batching FORGE:HEARTBEAT comment lookups for
 * many issues into one `gh api graphql` round-trip instead of one REST call
 * per issue (forge#2235 — de-N+1). The caller is responsible for chunking
 * issueNumbers to stay under GraphQL query complexity limits (a chunk size
 * of ~25 is safe).
 *
 * Fetches only the last 20 comments per issue (heartbeats are appended, so
 * the latest one is always near the end) rather than the full comment
 * history, to keep the response small.
 *
 * `owner`/`repo` are escaped (forge#2307) before interpolation into the
 * double-quoted GraphQL string literal so a value containing `"` or `\`
 * cannot break out of the literal and alter the query structure. In
 * practice these values come from trusted local input (forge.yaml or a
 * `--repo` CLI flag — see bin/forgedock.mjs resolveLabelsRepo/watch()), not
 * issue/PR content, but the query builder itself should not depend on that
 * being true forever.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number[]} issueNumbers
 * @returns {string} GraphQL query document
 */
export function buildHeartbeatBatchQuery(owner, repo, issueNumbers) {
  const aliases = issueNumbers
    .map(
      (n, i) =>
        `i${i}: issue(number: ${Number(n)}) { number comments(last: 20) { nodes { body } } }`,
    )
    .join("\n    ");
  return `query {
  repository(owner: "${escapeGraphQLString(owner)}", name: "${escapeGraphQLString(repo)}") {
    ${aliases}
  }
}`;
}

/**
 * Extract the latest FORGE:HEARTBEAT comment body per issue number from a
 * parsed `gh api graphql` response built against buildHeartbeatBatchQuery().
 *
 * @param {object} graphqlJson - parsed JSON response from `gh api graphql`
 * @returns {Map<number, string|null>} issue number -> latest heartbeat body, or null if none found
 */
export function parseHeartbeatBatchResponse(graphqlJson) {
  const result = new Map();
  const repoData = graphqlJson && graphqlJson.data && graphqlJson.data.repository;
  if (!repoData) return result;
  for (const key of Object.keys(repoData)) {
    const issue = repoData[key];
    if (!issue || typeof issue.number !== "number") continue;
    const nodes = (issue.comments && issue.comments.nodes) || [];
    let heartbeat = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i] && typeof nodes[i].body === "string" && nodes[i].body.includes("FORGE:HEARTBEAT")) {
        heartbeat = nodes[i].body;
        break;
      }
    }
    result.set(issue.number, heartbeat);
  }
  return result;
}

/**
 * Chunk an array into fixed-size slices (helper for GraphQL batch sizing).
 * @param {Array<*>} arr
 * @param {number} size
 * @returns {Array<Array<*>>}
 */
export function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
