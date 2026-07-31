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

  it("routes unsupported and deep-plan inputs away from the compact dispatcher", () => {
    const issues = [issue(1)];
    const unsupported = buildPreflightPlan({ input: "mcp:next 3", issues });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.mode, "full-spec-required");

    const backlog = buildPreflightPlan({ input: "mcp:next 3 --include-backlog", issues });
    assert.equal(backlog.supported, false);
    assert.equal(backlog.requiresDeepPlan, true);

    const deep = buildPreflightPlan({ input: "1 --deep-plan --auto", issues });
    assert.equal(deep.supported, true);
    assert.equal(deep.requiresDeepPlan, true);
    assert.deepEqual(deep.dispatchNow, []);
  });

  it("requires a Wave-0 replan before admitting investigation-class issues", () => {
    const issues = [
      issue(1, { title: "Investigate the deployment failure" }),
      issue(2),
    ];

    const plan = buildPreflightPlan({ input: "1 2 --auto", issues });

    assert.equal(plan.requiresDeepPlan, true);
    assert.deepEqual(plan.ready, [1, 2]);
    assert.deepEqual(plan.dispatchNow, []);
    assert.deepEqual(plan.investigations, [1]);
  });

  it("does not treat a negated create-issues constraint as an investigation deliverable", () => {
    const implementationBodies = [
      [
        "## Expected Behavior",
        "The compiler cannot create issues, edit labels, or dispatch agents.",
        "## Affected Files",
        "- `bin/orchestrate-preflight.mjs`",
        "## Acceptance Criteria",
        "- [ ] Emit an immutable compiled plan.",
      ].join("\n"),
      "## Constraint\n- Create issues: not supported by the compiler.\n## Affected Files\n- `bin/compiler.mjs`",
      "This is not a task whose deliverable is to create issues; implement code instead.\n## Affected Files\n- `bin/compiler.mjs`",
      "## Deliverable\nDo not create issues.\n## Affected Files\n- `bin/compiler.mjs`",
      "No component should create issues.\n## Affected Files\n- `bin/compiler.mjs`",
      "Create issues are unsupported.\n## Affected Files\n- `bin/compiler.mjs`",
      "Create issues may not be performed.\n## Affected Files\n- `bin/compiler.mjs`",
      "`Create issues` is the legacy command label being renamed.\n## Affected Files\n- `bin/compiler.mjs`",
      "No deliverable is to create issues.\n## Affected Files\n- `bin/compiler.mjs`",
      "This is not an issue whose deliverable is to create issues.\n## Affected Files\n- `bin/compiler.mjs`",
    ];
    for (const body of implementationBodies) {
      const implementation = issue(1, { title: "feat(engine): compile immutable plans", body });
      const plan = buildPreflightPlan({ input: "1 --auto", issues: [implementation] });
      assert.equal(plan.issues[0].classification, "IMPLEMENTATION", body);
      assert.equal(plan.requiresDeepPlan, false, body);
      assert.deepEqual(plan.dispatchNow, [1], body);
    }

    const investigationBodies = [
      "## Deliverable\nCreate issues for each confirmed finding.",
      "## Deliverable\n+ Create issues for each confirmed finding.",
      "## Acceptance Criteria\n- [ ] Create issues for each confirmed finding.",
      "Deliverable: **Create issues for each confirmed finding.**",
      "The deliverable is to create issues for each confirmed finding.",
      "No deliverable is to create issues for unconfirmed findings. The deliverable is to create issues for confirmed findings.",
    ];
    for (const body of investigationBodies) {
      const investigation = issue(2, { title: "Plan follow-up reliability work", body });
      const plan = buildPreflightPlan({ input: "2 --auto", issues: [investigation] });
      assert.equal(plan.issues[0].classification, "INVESTIGATION", body);
      assert.equal(plan.requiresDeepPlan, true, body);
      assert.deepEqual(plan.dispatchNow, [], body);
    }
  });

  it("fails closed for include-backlog compact scopes", () => {
    const plan = buildPreflightPlan({ input: "1 --include-backlog --auto", issues: [issue(1)] });
    assert.equal(plan.supported, true);
    assert.equal(plan.requiresDeepPlan, true);
    assert.deepEqual(plan.dispatchNow, []);
  });

  it("keeps the interactive confirmation gate explicit", () => {
    const plan = buildPreflightPlan({ input: "1", issues: [issue(1)] });
    assert.equal(plan.confirmed, false);
    assert.equal(plan.requiresConfirmation, true);
    assert.deepEqual(plan.ready, [1]);
    assert.deepEqual(plan.dispatchNow, []);
  });

  it("resolves an encoded GitHub milestone issues URL", () => {
    const input = "https://github.com/RapierCraftStudios/ForgeDock/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Aengine-v2-harness";
    const issues = [
      issue(1, { milestone: { title: "Engine v2 Harness" } }),
      issue(2, { milestone: { title: "Other milestone" } }),
      issue(3, { milestone: { title: "engine-v2-harness" } }),
    ];

    const plan = buildPreflightPlan({ input, repo: "RapierCraftStudios/ForgeDock", issues });

    assert.equal(plan.supported, true);
    assert.equal(plan.pattern, "milestone");
    assert.deepEqual(plan.issues.map((item) => item.number), [3]);

    const quoted = buildPreflightPlan({
      input: "https://github.com/RapierCraftStudios/ForgeDock/issues?q=is%3Aissue%20state%3Aopen%20milestone%3A%22Engine%20v2%20Harness%22",
      repo: "RapierCraftStudios/ForgeDock",
      issues,
    });
    assert.equal(quoted.supported, true);
    assert.deepEqual(quoted.issues.map((item) => item.number), [1]);

    const punctuation = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease%2Fcandidate",
      repo: "owner/repo",
      issues: [
        issue(4, { milestone: { title: "release/candidate" } }),
        issue(5, { milestone: { title: "release candidate" } }),
      ],
    });
    assert.deepEqual(punctuation.issues.map((item) => item.number), [4]);

    const controlToken = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3A--auto --auto",
      repo: "owner/repo",
      issues: [
        issue(6, { milestone: { title: "--auto" } }),
        issue(7, { milestone: { title: "milestone-auto" } }),
      ],
    });
    assert.equal(controlToken.confirmed, true);
    assert.deepEqual(controlToken.issues.map((item) => item.number), [6]);
    assert.deepEqual(controlToken.dispatchNow, [6]);
  });

  it("fails closed for unsupported or cross-repository GitHub issue URLs", () => {
    const unsupported = buildPreflightPlan({
      input: "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug",
      repo: "owner/repo",
      issues: [issue(1)],
    });
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.pattern, "github-issues-url");
    assert.match(unsupported.reason, /qualifier "label"/);

    const wrongRepo = buildPreflightPlan({
      input: "https://github.com/other/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      repo: "owner/repo",
      issues: [issue(1)],
    });
    assert.equal(wrongRepo.supported, false);
    assert.match(wrongRepo.reason, /targets other\/repo/);

    const malformedInputs = [
      "https:/github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease%ZZ",
      "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease%C0",
      "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20%22milestone%3Arelease%22",
      "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3A*",
      "https:///github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "https://github.com\\owner\\repo\\issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "https://github.com/owner//repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "https://github.com/owner%2Frepo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "//evil.io/owner/repo/issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
      "www.github.com\\owner\\repo\\issues?q=is%3Aissue%20state%3Aopen%20milestone%3Arelease",
    ];
    for (const input of malformedInputs) {
      const malformed = buildPreflightPlan({ input, repo: "owner/repo", issues: [issue(1)] });
      assert.equal(malformed.supported, false, input);
      assert.equal(malformed.pattern, "github-issues-url", input);
    }
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
