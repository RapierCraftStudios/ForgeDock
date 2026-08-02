import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  affectedFiles,
  buildPreflightPlan,
  domainsFor,
  explicitDependencies,
  reconcileCompletedDependencies,
  runPreflight,
} from "../orchestrate-preflight.mjs";

const issue = (number, overrides = {}) => ({
  number,
  title: `Fix issue ${number}`,
  body: "## Problem\nSomething is wrong.",
  labels: [{ name: "bug" }],
  milestone: null,
  state: "OPEN",
  ...overrides,
});

describe("OpenCode orchestration preflight", () => {
  it("extracts only scoped affected-file sections", () => {
    const body = [
      "## Problem",
      "`not-a-change.py` is prior art.",
      "## Affected Files",
      "- `services/api/app/main.py`",
      "- `services/api/app/main.py`",
      "## Context",
      "- `should-not-be-included.ts`",
    ].join("\n");

    assert.deepEqual(affectedFiles(body), ["services/api/app/main.py"]);
  });

  it("parses explicit dependency markers and domains", () => {
    assert.deepEqual(explicitDependencies("Depends on #12; blocked by #4; after #12."), [4, 12]);
    assert.deepEqual(domainsFor(issue(1, { title: "Fix billing worker migration" })), ["BILLING", "WORKER", "DATABASE"]);
  });

  it("builds a compact ready queue with hard file and database edges", () => {
    const issues = [
      issue(1, { body: "## Affected Files\n- `services/api/app/users.py`", labels: [{ name: "priority:P1" }] }),
      issue(2, { body: "## Affected Files\n- `services/api/app/users.py`" }),
      issue(3, { title: "Add migration", body: "## Affected Files\n- `infra/migrations/0100_add.sql" }),
      issue(4, { body: "## Problem\nDepends on #1" }),
    ];

    const plan = buildPreflightPlan({ input: "1 2 3 4 --auto", repo: "owner/repo", issues, maxConcurrent: 3 });

    assert.equal(plan.supported, true);
    assert.deepEqual(plan.ready, [1, 3]);
    assert.deepEqual(plan.dispatchNow, [1, 3]);
    assert.deepEqual(plan.issues.find((item) => item.number === 2).predecessors, [1]);
    assert.deepEqual(plan.issues.find((item) => item.number === 4).predecessors, [1]);
    assert.ok(plan.edges.some((edge) => edge.kind === "same-file" && edge.predecessor === 1 && edge.successor === 2));
  });

  it("filters orchestration coordination issues from work batches", () => {
    const plan = buildPreflightPlan({
      input: "1 2 --auto",
      issues: [
        issue(1),
        issue(2, { title: "orchestrate: claims board for batch test", body: "<!-- FORGE:COORD_ISSUE -->" }),
      ],
    });
    assert.deepEqual(plan.issues.map((item) => item.number), [1]);
    assert.deepEqual(plan.excluded, [{ number: 2, reason: "orchestration coordination issue" }]);
  });

  it("filters workflow exclusions and supports explicit in-flight recovery", () => {
    const issues = [
      issue(1),
      issue(2, { labels: [{ name: "needs-human" }] }),
      issue(3, { labels: [{ name: "workflow:building" }] }),
    ];

    const normal = buildPreflightPlan({ input: "1 2 3", issues });
    assert.deepEqual(normal.ready, [1]);
    assert.deepEqual(normal.excluded.map((item) => item.number), [2]);
    assert.deepEqual(normal.deferred, [{ number: 3, reason: "in-flight" }]);
    assert.deepEqual(normal.issues.map((item) => item.number), [1]);

    const recovery = buildPreflightPlan({ input: "1 2 3 --include-in-flight", issues });
    assert.deepEqual(recovery.issues.map((item) => item.number), [1, 3]);
    assert.deepEqual(recovery.inFlight, [3]);
  });

  it("retains current-run active issues as non-dispatchable conflict vertices", () => {
    const sharedFile = "## Affected Files\n- `pi/extensions/forgedock.ts`";
    const plan = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=is%3Aissue+state%3Aopen+label%3Aworkflow%3Aready-to-build --auto",
      repo: "owner/repo",
      issues: [
        issue(1, { title: "Add migration", body: sharedFile, labels: [{ name: "workflow:ready-to-build" }] }),
        issue(2, { labels: [{ name: "workflow:building" }] }),
        issue(3, {
          title: "Investigate migration",
          body: `${sharedFile}\n\nBlocked by #99`,
          labels: [{ name: "workflow:building" }],
        }),
      ],
      conflictIssueNumbers: [...Array(40).fill("invalid"), ...Array(40).fill(3), -1],
    });

    assert.deepEqual(plan.issues.map((item) => item.number), [1, 3]);
    assert.deepEqual(plan.deferred, []);
    assert.equal(plan.issues.find((item) => item.number === 3).conflictOnly, true);
    assert.deepEqual(plan.issues.find((item) => item.number === 1).predecessors, [3]);
    assert.ok(plan.edges.some((edge) => edge.kind === "same-file" && edge.predecessor === 3 && edge.successor === 1));
    assert.ok(plan.edges.some((edge) => edge.kind === "database" && edge.predecessor === 3 && edge.successor === 1));
    assert.deepEqual(plan.investigations, []);
    assert.equal(plan.requiresDeepPlan, false);
    assert.deepEqual(plan.ready, []);
    assert.deepEqual(plan.dispatchNow, []);
    assert.deepEqual(plan.queued, []);

    const reconciled = reconcileCompletedDependencies(plan, []);
    assert.deepEqual(reconciled.ready, []);
    assert.deepEqual(reconciled.dispatchNow, []);
    assert.deepEqual(reconciled.queued, []);
  });

  it("routes unsupported and deep-plan inputs away from the compact dispatcher", () => {
    const issues = [issue(1)];
    const unsupported = buildPreflightPlan({ input: "mcp:next 3", issues });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.mode, "full-spec-required");

    const deep = buildPreflightPlan({ input: "1 --deep-plan --auto", issues });
    assert.equal(deep.supported, true);
    assert.equal(deep.requiresDeepPlan, true);
    assert.deepEqual(deep.dispatchNow, []);
  });

  it("routes external dependencies to the full workflow for live-state verification", () => {
    const plan = buildPreflightPlan({
      input: "1 --auto",
      issues: [issue(1, { body: "## Problem\nBlocked by #99" })],
    });

    assert.equal(plan.supported, true);
    assert.equal(plan.requiresDeepPlan, true);
    assert.deepEqual(plan.issues[0].externalDependencies, [99]);
    assert.deepEqual(plan.dispatchNow, []);
    assert.match(plan.warnings.join("\n"), /verify their live terminal state/);
  });

  it("reconciles completed external dependencies without weakening unresolved gates", () => {
    const original = buildPreflightPlan({
      input: "2 --auto",
      issues: [issue(2, { body: "## Problem\nBlocked by #1\nDepends on #99" })],
    });

    const reconciled = reconcileCompletedDependencies(original, new Set([1]));

    assert.deepEqual(reconciled.issues[0].externalDependencies, [99]);
    assert.equal(reconciled.requiresDeepPlan, true);
    assert.deepEqual(reconciled.dispatchNow, []);
    assert.deepEqual(original.issues[0].externalDependencies, [1, 99]);

    const ready = reconcileCompletedDependencies(original, new Set([1, 99]));
    assert.deepEqual(ready.issues[0].externalDependencies, []);
    assert.equal(ready.requiresDeepPlan, false);
    assert.deepEqual(ready.ready, [2]);
    assert.deepEqual(ready.dispatchNow, [2]);
  });

  it("preserves non-external deep-plan causes after completed dependency reconciliation", () => {
    const deep = buildPreflightPlan({
      input: "2 --deep-plan --auto",
      issues: [issue(2, { body: "## Problem\nBlocked by #1" })],
    });

    const reconciled = reconcileCompletedDependencies(deep, [1]);

    assert.deepEqual(reconciled.issues[0].externalDependencies, []);
    assert.equal(reconciled.requiresDeepPlan, true);
    assert.deepEqual(reconciled.dispatchNow, []);
  });

  it("does not dispatch implementation issues while an investigation requires the full phase path", () => {
    const issues = [
      issue(1, { title: "Investigate the deployment failure" }),
      issue(2),
    ];

    const plan = buildPreflightPlan({ input: "1 2 --auto", issues });

    assert.equal(plan.requiresDeepPlan, true);
    assert.deepEqual(plan.ready, [1, 2]);
    assert.deepEqual(plan.dispatchNow, []);
    assert.deepEqual(plan.queued, [1, 2]);
  });

  it("keeps the interactive confirmation gate explicit", () => {
    const plan = buildPreflightPlan({ input: "1", issues: [issue(1)] });
    assert.equal(plan.confirmed, false);
    assert.equal(plan.requiresConfirmation, true);
    assert.deepEqual(plan.ready, [1]);
    assert.deepEqual(plan.dispatchNow, []);
  });

  it("resolves a same-repository encoded GitHub issue-search URL", () => {
    const issues = [
      issue(1),
      issue(2, { milestone: { title: "planned" } }),
      issue(3, { labels: [{ name: "workflow:building" }] }),
    ];
    const input = "https://github.com/owner/repo/issues?q=is%3Aissue+state%3Aopen+no%3Amilestone+sort%3Aupdated-desc --auto";
    const plan = buildPreflightPlan({ input, repo: "owner/repo", issues });

    assert.equal(plan.supported, true);
    assert.equal(plan.pattern, "no:milestone");
    assert.equal(plan.confirmed, true);
    assert.deepEqual(plan.issues.map((item) => item.number), [1]);
    assert.deepEqual(plan.dispatchNow, [1]);
  });

  it("supports exact URL label and milestone predicates without changing raw slug behavior", () => {
    const issues = [
      issue(1, { labels: [{ name: "bug" }], milestone: { title: "planned" } }),
      issue(2, { labels: [{ name: "feature" }], milestone: { title: "planned" } }),
      issue(3, { labels: [{ name: "bug/fix" }], milestone: { title: "release/one" } }),
      issue(4, { labels: [{ name: "bug-fix" }], milestone: { title: "release-one" } }),
    ];
    const label = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=is%3Aissue+state%3Aopen+label%3Abug --confirm",
      repo: "owner/repo",
      issues,
    });
    const milestone = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=milestone%3Aplanned",
      repo: "owner/repo",
      issues,
    });

    const exactLabel = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=label%3A%22bug%2Ffix%22",
      repo: "owner/repo",
      issues,
    });
    const exactMilestone = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=milestone%3A%22release%2Fone%22",
      repo: "owner/repo",
      issues,
    });

    assert.deepEqual(label.issues.map((item) => item.number), [1]);
    assert.deepEqual(milestone.issues.map((item) => item.number), [1, 2]);
    assert.deepEqual(exactLabel.issues.map((item) => item.number), [3]);
    assert.deepEqual(exactMilestone.issues.map((item) => item.number), [3]);
    assert.deepEqual(buildPreflightPlan({ input: "no:milestone", repo: "owner/repo", issues }).issues, []);
  });

  it("fails closed for cross-repository, malformed, missing, and unsupported URLs", () => {
    const cases = [
      ["https://github.com/other/repo/issues?q=no%3Amilestone", /does not match configured repository/],
      ["https://github.com/owner/repo/not-issues?q=no%3Amilestone", /must target/],
      ["https://github.com/owner/repo/issues", /exactly one q parameter/],
      ["https://github.com/owner/repo/issues?q=is%3Apr+state%3Aopen", /is:pr/],
      ["https://github.com/owner/repo/issues?q=is%3Aissue+state%3Aopen+assignee%3Aoctocat", /unsupported.*assignee/],
      ["https:/github.com/owner/repo/issues?q=no%3Amilestone", /malformed/],
      ["https//github.com/owner/repo/issues?q=no%3Amilestone", /malformed/],
      ["https://github.com/owner/repo/issues?q=label%3Abug%2", /malformed query encoding/],
      ["https://github.com/owner/repo/issues?q=label%3A%FF", /malformed query encoding/],
    ];

    for (const [input, reason] of cases) {
      const plan = buildPreflightPlan({ input, repo: "owner/repo", issues: [issue(1)] });
      assert.equal(plan.supported, false, input);
      assert.equal(plan.mode, "full-spec-required");
      assert.match(plan.reason, reason, input);
      assert.deepEqual(plan.dispatchNow, []);
    }
  });

  it("does not view literal issues for an invalid GitHub URL", () => {
    const calls = [];
    const result = runPreflight({
      cwd: ".",
      repo: "owner/repo",
      input: "https://github.com/other/repo/issues?q=no%3Amilestone --auto",
      gh: (_cwd, args) => {
        calls.push(args);
        return [issue(1)];
      },
    });

    assert.equal(result.supported, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "list");
  });

  it("uses one issue-list snapshot and only views missing literal issues", () => {
    const calls = [];
    const result = runPreflight({
      cwd: ".",
      repo: "owner/repo",
      input: "1 2 --auto",
      gh: (_cwd, args) => {
        calls.push(args);
        if (args[1] === "list") return [issue(1)];
        return issue(2);
      },
    });

    assert.equal(result.supported, true);
    assert.deepEqual(result.ready, [1, 2]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], "list");
    assert.equal(calls[1][1], "view");
  });

  it("resolves forge.yaml from a parent of the nested Git worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-preflight-config-"));
    const nested = join(root, "repo");
    mkdirSync(nested);
    writeFileSync(join(root, "forge.yaml"), "project:\n  owner: owner\n  repo: repo\n");

    try {
      const calls = [];
      const result = runPreflight({
        cwd: nested,
        input: "1 --auto",
        gh: (_cwd, args) => {
          calls.push(args);
          return [issue(1)];
        },
      });

      assert.equal(result.repo, "owner/repo");
      assert.equal(calls[0][calls[0].indexOf("-R") + 1], "owner/repo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
