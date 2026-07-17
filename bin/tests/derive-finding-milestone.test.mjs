/**
 * bin/tests/derive-finding-milestone.test.mjs
 *
 * Unit tests for scripts/derive-finding-milestone.sh — the single source of
 * truth for deriving the milestone a review-finding issue should inherit
 * from the PR that spawned it.
 *
 * Regression coverage for forge#2443: `/review-pr` composed review-finding
 * issue bodies without deriving `**Code branch**`/milestone from the PR
 * being reviewed. For a PR based on a milestone branch (e.g.
 * `milestone/engine-v2-harness`), findings with no explicit `Closes #N` and
 * no milestone set directly fell through to `classify-lane.sh`'s implicit
 * `staging` default — the one branch where the subject code was guaranteed
 * absent, causing `/work-on`'s investigation phase to close the finding as
 * invalid.
 *
 * This suite exercises scripts/derive-finding-milestone.sh directly via
 * bash (mirrors the script's own `#!/usr/bin/env bash` shebang — works
 * under Git Bash on Windows and natively on Linux CI), covering all 3
 * resolution tiers plus the exact Instance-B regression case named in the
 * issue (a PR based on `milestone/engine-v2-harness` resolves via slug
 * match, not empty/staging).
 *
 * `gh` is faked via a PATH-shadowed shim (bin/tests/fixtures/fake-gh/gh) so
 * these tests never touch the network. The shim is driven entirely by
 * environment variables set per test case — see fixtures/fake-gh/gh for the
 * exact contract.
 *
 * Run with: node --test bin/tests/derive-finding-milestone.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "derive-finding-milestone.sh");
const FAKE_GH_DIR = join(__dirname, "fixtures", "fake-gh");
const FAKE_GH_PATH = join(FAKE_GH_DIR, "gh");

// The fake `gh` shim is resolved via PATH lookup (derive-finding-milestone.sh
// invokes `gh` directly, not `bash gh`), so it must carry the executable bit.
// The bit is committed as part of the fixture (100755), but git checkouts on
// filesystems/tools that don't preserve the executable bit (e.g. some zip/tar
// packaging, or a repo checked out with core.fileMode=false) can silently
// strip it, which would fail every test in this suite with EACCES only on
// Linux CI runners (Windows/Git Bash ignores the unix permission bit
// entirely, so this class of breakage is invisible locally). Defensively
// re-assert the bit at suite load time — same pattern as
// bin/tests/forge-run-die-json.test.mjs's chmodSync(stubPath, 0o755).
try {
  chmodSync(FAKE_GH_PATH, 0o755);
} catch {
  // Non-fatal: if this fails, the "fails loud" nature of the tests below
  // (spawnSync exit codes) will still surface the real problem clearly.
}

/**
 * Run derive-finding-milestone.sh via bash with the given arguments, with a
 * fake `gh` shadowing the real one on PATH and the given env vars driving
 * its canned responses.
 * Returns { stdout, stderr, status }.
 */
function run(args, fakeGhEnv = {}) {
  const result = spawnSync("bash", [SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${FAKE_GH_DIR}${delimiter}${process.env.PATH}`,
      ...fakeGhEnv,
    },
  });
  return result;
}

describe("scripts/derive-finding-milestone.sh — PR -> milestone derivation (forge#2443)", () => {
  it("usage error: exits 1 with no stdout when called with no arguments", () => {
    const result = run([]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /Usage/);
  });

  it("usage error: exits 1 for a non-numeric PR number", () => {
    const result = run(["abc"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /must be numeric/);
  });

  it("usage error: exits 1 for a malformed -R value", () => {
    const result = run(["123", "-R", "not-owner-slash-repo"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
  });

  it("Tier 1: PR's own milestone wins outright, no further tiers consulted", () => {
    const result = run(["123"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: { title: "Tier 1 Milestone" },
        body: "Closes #999", // would resolve to a DIFFERENT milestone via tier 2 if tier 1 didn't short-circuit
        baseRefName: "milestone/some-other-slug", // would resolve to yet another milestone via tier 3
        headRefName: "feat/example",
      }),
      // Deliberately do NOT set GH_FAKE_ISSUE_JSON or GH_FAKE_MILESTONES_JSON —
      // if tier 1 fails to short-circuit, the fake gh calls below would fail
      // loudly (unset env var), proving tier ordering is correct.
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "Tier 1 Milestone");
  });

  it("Tier 2: falls through to the originating issue's milestone via 'Closes #N'", () => {
    const result = run(["124"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: null,
        body: "Some description.\n\nCloses #4242",
        baseRefName: "staging",
        headRefName: "fix/example",
      }),
      GH_FAKE_ISSUE_JSON: JSON.stringify({ milestone: { title: "Tier 2 Milestone" } }),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "Tier 2 Milestone");
  });

  it("Tier 2: recognizes 'Fixes #N' and 'Resolves #N' (case-insensitive), not just 'Closes'", () => {
    for (const phrase of ["fixes #55", "RESOLVES #55", "Resolves#55"]) {
      const result = run(["125"], {
        GH_FAKE_PR_JSON: JSON.stringify({
          milestone: null,
          body: `Body text. ${phrase}`,
          baseRefName: "staging",
          headRefName: "fix/example",
        }),
        GH_FAKE_ISSUE_JSON: JSON.stringify({ milestone: { title: "Tier 2 Milestone" } }),
      });
      assert.equal(result.status, 0, `phrase "${phrase}" — stderr: ${result.stderr}`);
      assert.equal(result.stdout.trim(), "Tier 2 Milestone", `phrase "${phrase}" did not resolve`);
    }
  });

  it("Tier 3: falls through to branch-slug match when PR and issue have no milestone", () => {
    const result = run(["126"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: null,
        body: "No closing keyword here.",
        baseRefName: "milestone/watch-fleet-observability",
        headRefName: "feat/example-2409",
      }),
      GH_FAKE_MILESTONES_JSON: JSON.stringify([
        { title: "Watch & Fleet Observability" },
        { title: "Some Other Milestone" },
      ]),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "Watch & Fleet Observability");
  });

  it("REGRESSION (forge#2443 Instance B): milestone/engine-v2-harness resolves via slug match, not empty/staging", () => {
    const result = run(["2426"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: null,
        body: "Refactor the harness runner.",
        baseRefName: "milestone/engine-v2-harness",
        headRefName: "feat/harness-runner-cleanup",
      }),
      GH_FAKE_MILESTONES_JSON: JSON.stringify([
        { title: "engine-v2-harness" },
        { title: "Watch & Fleet Observability" },
      ]),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const milestone = result.stdout.trim();
    assert.equal(milestone, "engine-v2-harness");
    assert.notEqual(milestone, "", "must not resolve to empty (which would default classify-lane.sh to staging)");
    assert.notEqual(milestone, "staging", "must never resolve literally to the staging fast lane");
  });

  it("Tier 3 also checks headRefName when baseRefName is not a milestone branch", () => {
    const result = run(["127"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: null,
        body: "No closing keyword.",
        baseRefName: "staging",
        headRefName: "milestone/engine-v2-harness",
      }),
      GH_FAKE_MILESTONES_JSON: JSON.stringify([{ title: "engine-v2-harness" }]),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "engine-v2-harness");
  });

  it("no tier resolves: exits 0 with empty stdout (normal fast-lane case, not an error)", () => {
    const result = run(["128"], {
      GH_FAKE_PR_JSON: JSON.stringify({
        milestone: null,
        body: "A plain fast-lane fix with no closing keyword.",
        baseRefName: "staging",
        headRefName: "fix/plain-example",
      }),
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
  });

  it("fails loud (exit 1) when the PR itself cannot be fetched", () => {
    const result = run(["999999"], {
      GH_FAKE_PR_VIEW_EXIT: "1",
      GH_FAKE_PR_VIEW_STDERR: "GraphQL: Could not resolve to a PullRequest",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), "");
    assert.match(result.stderr, /failed to fetch PR/);
  });
});
