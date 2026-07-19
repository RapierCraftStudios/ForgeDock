// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  deriveWorkflowLabels,
  FALLBACK_WORKFLOW_LABELS,
  classifyFindingStatus,
  hasWorkflowLabel,
  normalizePriority,
  parseSatelliteRepos,
  buildHeartbeatBatchQuery,
  parseHeartbeatBatchResponse,
  chunkArray,
} from "../watch-utils.mjs";

// ---------------------------------------------------------------------------
// Regression test (forge#2235): a review-finding issue that carries
// needs-validation and a bare P3 priority label, with NO workflow:* label,
// must be classified into the findings lane (not silently dropped) and must
// render with a distinct non-running status.
// ---------------------------------------------------------------------------
test("review-finding,needs-validation,P3 with no workflow:* label appears in the findings lane as queued", () => {
  const labels = ["review-finding", "needs-validation", "P3"];
  const workflowLabels = deriveWorkflowLabels(join(tmpdir(), "does-not-exist-labels.json"));

  assert.equal(hasWorkflowLabel(labels, workflowLabels), false, "must NOT be classified as in-flight");
  assert.equal(classifyFindingStatus(labels), "queued", "needs-validation must render as queued, not dropped");
  assert.equal(normalizePriority(labels), "P3", "bare P3 must normalize the same as priority:P3");
});

test("deferred finding (bare review-finding, no other lifecycle label) classifies as deferred", () => {
  const labels = ["review-finding", "staging-review"];
  assert.equal(classifyFindingStatus(labels), "deferred");
});

test("validated and false-positive findings classify distinctly", () => {
  assert.equal(classifyFindingStatus(["review-finding", "validated"]), "validated");
  assert.equal(classifyFindingStatus(["review-finding", "false-positive"]), "false-positive");
});

test("an issue carrying a workflow:* label is excluded from the findings lane even with review-finding present", () => {
  const labels = ["review-finding", "workflow:investigating"];
  const workflowLabels = ["workflow:investigating", "workflow:ready-to-build", "workflow:building", "workflow:in-review", "needs-human"];
  assert.equal(hasWorkflowLabel(labels, workflowLabels), true);
});

// ---------------------------------------------------------------------------
// deriveWorkflowLabels: canonical manifest vs fallback
// ---------------------------------------------------------------------------
test("deriveWorkflowLabels reads workflow:* + needs-human from a real labels.json manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-utils-"));
  const manifestPath = join(dir, "labels.json");
  try {
    writeFileSync(
      manifestPath,
      JSON.stringify([
        { name: "workflow:investigating", color: "1D76DB", description: "x" },
        { name: "workflow:ready-to-build", color: "0075CA", description: "x" },
        { name: "workflow:engine-error", color: "B60205", description: "x" },
        { name: "needs-human", color: "E4E669", description: "x" },
        { name: "review-finding", color: "D93F0B", description: "x" },
        { name: "priority:P0", color: "B60205", description: "x" },
      ]),
    );
    const derived = deriveWorkflowLabels(manifestPath);
    assert.ok(derived.includes("workflow:investigating"));
    assert.ok(derived.includes("workflow:engine-error"), "a newly-added workflow:* label must not require a code change to be watched");
    assert.ok(derived.includes("needs-human"));
    assert.ok(!derived.includes("review-finding"), "review-finding is its own lane, not part of the in-flight label set");
    assert.ok(!derived.includes("priority:P0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveWorkflowLabels falls back to the built-in list when the manifest is missing", () => {
  const derived = deriveWorkflowLabels(join(tmpdir(), "definitely-does-not-exist-" + Date.now() + ".json"));
  assert.deepEqual(derived, FALLBACK_WORKFLOW_LABELS);
});

test("deriveWorkflowLabels falls back to the built-in list when the manifest is malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-utils-bad-"));
  const manifestPath = join(dir, "labels.json");
  try {
    writeFileSync(manifestPath, "{ not valid json");
    const derived = deriveWorkflowLabels(manifestPath);
    assert.deepEqual(derived, FALLBACK_WORKFLOW_LABELS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// normalizePriority
// ---------------------------------------------------------------------------
test("normalizePriority prefers canonical priority:P* over a bare P* if both present", () => {
  assert.equal(normalizePriority(["priority:P1", "P2"]), "P1");
});

test("normalizePriority returns null when no priority label present", () => {
  assert.equal(normalizePriority(["bug", "review-finding"]), null);
});

test("normalizePriority accepts {name} object-form labels (gh --json labels shape)", () => {
  assert.equal(normalizePriority([{ name: "priority:P2" }, { name: "bug" }]), "P2");
});

// ---------------------------------------------------------------------------
// parseSatelliteRepos
// ---------------------------------------------------------------------------
test("parseSatelliteRepos extracts repo values from a repos.satellites section", () => {
  const yaml = `
repos:
  default:
    repo: "RapierCraftStudios/ForgeDock"
    staging_branch: "staging"
  satellites:
    - prefix: "platform"
      repo: "RapierCraftStudios/forgedock-platform"
      staging_branch: "staging"
    - prefix: "docs"
      repo: "RapierCraftStudios/forgedock-docs"

project_board:
  owner: "RapierCraftStudios"
`;
  const repos = parseSatelliteRepos(yaml);
  assert.deepEqual(repos, ["RapierCraftStudios/forgedock-platform", "RapierCraftStudios/forgedock-docs"]);
});

test("parseSatelliteRepos returns [] when no satellites section exists", () => {
  const yaml = `
repos:
  default:
    repo: "RapierCraftStudios/ForgeDock"
`;
  assert.deepEqual(parseSatelliteRepos(yaml), []);
});

test("parseSatelliteRepos does not leak a repo: field from a later unrelated section", () => {
  const yaml = `
repos:
  satellites:
    - prefix: "platform"
      repo: "RapierCraftStudios/forgedock-platform"

review:
  repo: "should-not-be-picked-up"
`;
  assert.deepEqual(parseSatelliteRepos(yaml), ["RapierCraftStudios/forgedock-platform"]);
});

// ---------------------------------------------------------------------------
// forge#2457: a suffixed key like `staging_repo:` must NOT be matched as a
// trailing substring of the unanchored `repo:` pattern. The satellites
// schema does not define such a key today, but the regex must not rely on
// that — it must be anchored to a real YAML key boundary regardless of what
// keys the schema happens to define.
// ---------------------------------------------------------------------------
test("parseSatelliteRepos does not match repo: as a substring of a suffixed key (e.g. staging_repo:)", () => {
  const yaml = `
repos:
  satellites:
    - prefix: "platform"
      staging_repo: "should-not-be-picked-up"
      repo: "RapierCraftStudios/forgedock-platform"
`;
  assert.deepEqual(parseSatelliteRepos(yaml), ["RapierCraftStudios/forgedock-platform"]);
});

// ---------------------------------------------------------------------------
// Heartbeat batching (GraphQL query build + response parse)
// ---------------------------------------------------------------------------
test("buildHeartbeatBatchQuery produces one aliased issue lookup per issue number", () => {
  const q = buildHeartbeatBatchQuery("RapierCraftStudios", "ForgeDock", [101, 102]);
  assert.match(q, /repository\(owner: "RapierCraftStudios", name: "ForgeDock"\)/);
  assert.match(q, /i0: issue\(number: 101\)/);
  assert.match(q, /i1: issue\(number: 102\)/);
});

// ---------------------------------------------------------------------------
// forge#2307: buildHeartbeatBatchQuery must escape owner/repo before
// interpolating them into the double-quoted GraphQL string literal, so a
// value containing `"` cannot break out of the literal and alter the query
// structure. This test fails against the pre-fix implementation (which
// interpolates owner/repo raw) and passes once escapeGraphQLString() is
// applied.
// ---------------------------------------------------------------------------
test("buildHeartbeatBatchQuery escapes a double-quote in owner/repo instead of breaking out of the string literal", () => {
  const q = buildHeartbeatBatchQuery('Evil", name: "Injected', "ForgeDock", [1]);

  // The owner value's embedded `"` must appear escaped (`\"`), not raw —
  // i.e. the literal `owner: "Evil", name: "Injected"` sequence (which would
  // exist if the value broke out unescaped) must NOT appear in the query.
  assert.doesNotMatch(q, /owner: "Evil", name: "Injected"/);
  assert.match(q, /owner: "Evil\\", name: \\"Injected"/);

  // The `owner:` argument's string literal must stay well-formed: an even
  // number of unescaped double-quotes between the two real string
  // boundaries. Concretely, the whole `repository(...)` header line must
  // still contain exactly two *unescaped* quote-delimited arguments.
  const headerLine = q.split("\n")[1];
  const unescapedQuoteCount = (headerLine.match(/(?<!\\)"/g) || []).length;
  assert.equal(unescapedQuoteCount, 4, "owner and name must still be exactly two well-formed quoted string args");
});

test("buildHeartbeatBatchQuery escapes a backslash in owner/repo without double-escaping", () => {
  const q = buildHeartbeatBatchQuery("owner\\name", "ForgeDock", [1]);
  assert.match(q, /owner: "owner\\\\name"/);
});

test("buildHeartbeatBatchQuery leaves plain alphanumeric owner/repo values unchanged (no-op escaping)", () => {
  const q = buildHeartbeatBatchQuery("RapierCraftStudios", "ForgeDock", [1]);
  assert.match(q, /repository\(owner: "RapierCraftStudios", name: "ForgeDock"\)/);
});

test("parseHeartbeatBatchResponse extracts the latest FORGE:HEARTBEAT body per issue", () => {
  const response = {
    data: {
      repository: {
        i0: {
          number: 101,
          comments: {
            nodes: [
              { body: "some unrelated comment" },
              { body: "<!-- FORGE:HEARTBEAT -->\n**Phase**: Phase 1\n**Timestamp**: 2026-01-01T00:00:00Z" },
              { body: "<!-- FORGE:HEARTBEAT -->\n**Phase**: Phase 3\n**Timestamp**: 2026-01-02T00:00:00Z" },
            ],
          },
        },
        i1: {
          number: 102,
          comments: { nodes: [{ body: "no heartbeat here" }] },
        },
      },
    },
  };
  const parsed = parseHeartbeatBatchResponse(response);
  assert.match(parsed.get(101), /Phase 3/, "must pick the LATEST heartbeat, not the first");
  assert.equal(parsed.get(102), null);
});

test("parseHeartbeatBatchResponse returns an empty Map for a malformed/errored response", () => {
  assert.equal(parseHeartbeatBatchResponse({}).size, 0);
  assert.equal(parseHeartbeatBatchResponse(null).size, 0);
  assert.equal(parseHeartbeatBatchResponse({ data: null }).size, 0);
});

// ---------------------------------------------------------------------------
// chunkArray
// ---------------------------------------------------------------------------
test("chunkArray splits into fixed-size slices with a smaller final chunk", () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 2), []);
});

// ---------------------------------------------------------------------------
// forge#2308: chunk-boundary coverage beyond the happy path above.
// ---------------------------------------------------------------------------
test("chunkArray produces no short final chunk when length is an exact multiple of size", () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("chunkArray returns a single chunk when size is >= array length", () => {
  assert.deepEqual(chunkArray([1, 2, 3], 25), [[1, 2, 3]]);
  assert.deepEqual(chunkArray([1, 2, 3], 3), [[1, 2, 3]]);
});

test("chunkArray with size 1 produces one chunk per element", () => {
  assert.deepEqual(chunkArray([1, 2, 3], 1), [[1], [2], [3]]);
});
