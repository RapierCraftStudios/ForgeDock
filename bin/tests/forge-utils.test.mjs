/**
 * bin/tests/forge-utils.test.mjs
 *
 * Unit tests for the diff-aware changelog summary helpers in
 * bin/forge-utils.mjs (forge#1947):
 *   - parseNameStatusDiff
 *   - classifyCommandChanges
 *   - countBreakingCommits
 *   - parseGitHubOwnerRepo
 *   - classifyConventionalCommitLines
 *   - formatUpdateChangelogSummary
 *   - formatVersionAvailableSummary
 *
 * Run with: node --test bin/tests/forge-utils.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseNameStatusDiff,
  classifyCommandChanges,
  countBreakingCommits,
  parseGitHubOwnerRepo,
  classifyConventionalCommitLines,
  formatUpdateChangelogSummary,
  formatVersionAvailableSummary,
} from "../forge-utils.mjs";

describe("parseNameStatusDiff", () => {
  it("parses plain A/M/D lines", () => {
    const diff = "A\tcommands/foo.md\nM\tbin/engine/state.mjs\nD\tcommands/bar.md\n";
    assert.deepEqual(parseNameStatusDiff(diff), [
      { status: "A", path: "commands/foo.md" },
      { status: "M", path: "bin/engine/state.mjs" },
      { status: "D", path: "commands/bar.md" },
    ]);
  });

  it("uses the new path and normalized letter for rename/copy lines", () => {
    const diff = "R100\tcommands/old.md\tcommands/new.md\nC075\ta.md\tb.md\n";
    assert.deepEqual(parseNameStatusDiff(diff), [
      { status: "R", path: "commands/new.md" },
      { status: "C", path: "b.md" },
    ]);
  });

  it("handles CRLF line endings", () => {
    const diff = "A\tcommands/foo.md\r\nD\tcommands/bar.md\r\n";
    assert.deepEqual(parseNameStatusDiff(diff), [
      { status: "A", path: "commands/foo.md" },
      { status: "D", path: "commands/bar.md" },
    ]);
  });

  it("skips blank and malformed lines instead of throwing", () => {
    const diff = "\nA\tcommands/foo.md\n\nnotarealline\n  \n";
    assert.deepEqual(parseNameStatusDiff(diff), [{ status: "A", path: "commands/foo.md" }]);
  });

  it("returns an empty array for non-string / empty input", () => {
    assert.deepEqual(parseNameStatusDiff(""), []);
    assert.deepEqual(parseNameStatusDiff(null), []);
    assert.deepEqual(parseNameStatusDiff(undefined), []);
    assert.deepEqual(parseNameStatusDiff(42), []);
  });
});

describe("classifyCommandChanges", () => {
  it("counts added/updated/removed commands and engine changes separately", () => {
    const entries = [
      { status: "A", path: "commands/new-one.md" },
      { status: "A", path: "commands/new-two.md" },
      { status: "M", path: "commands/existing.md" },
      { status: "D", path: "commands/gone.md" },
      { status: "M", path: "bin/engine/state.mjs" },
      { status: "A", path: "bin/engine/new-module.mjs" },
    ];
    assert.deepEqual(classifyCommandChanges(entries), {
      commandsAdded: 2,
      commandsUpdated: 1,
      commandsRemoved: 1,
      engineChanged: 2,
    });
  });

  it("treats renames/copies under commands/ as updated", () => {
    const entries = [{ status: "R", path: "commands/renamed.md" }];
    assert.deepEqual(classifyCommandChanges(entries), {
      commandsAdded: 0,
      commandsUpdated: 1,
      commandsRemoved: 0,
      engineChanged: 0,
    });
  });

  it("ignores files outside commands/ and bin/engine/", () => {
    const entries = [
      { status: "A", path: "bin/forgedock.mjs" },
      { status: "M", path: "docs/CONFIG.md" },
    ];
    assert.deepEqual(classifyCommandChanges(entries), {
      commandsAdded: 0,
      commandsUpdated: 0,
      commandsRemoved: 0,
      engineChanged: 0,
    });
  });

  it("normalizes backslash path separators before matching prefixes", () => {
    const entries = [{ status: "A", path: "commands\\windows-style.md" }];
    assert.deepEqual(classifyCommandChanges(entries), {
      commandsAdded: 1,
      commandsUpdated: 0,
      commandsRemoved: 0,
      engineChanged: 0,
    });
  });

  it("respects custom prefixes", () => {
    const entries = [{ status: "A", path: "src/commands/x.md" }];
    const result = classifyCommandChanges(entries, { commandsPrefix: "src/commands/" });
    assert.equal(result.commandsAdded, 1);
  });

  it("returns all-zero counts for non-array / empty input", () => {
    assert.deepEqual(classifyCommandChanges(null), {
      commandsAdded: 0,
      commandsUpdated: 0,
      commandsRemoved: 0,
      engineChanged: 0,
    });
    assert.deepEqual(classifyCommandChanges([]), {
      commandsAdded: 0,
      commandsUpdated: 0,
      commandsRemoved: 0,
      engineChanged: 0,
    });
  });
});

describe("countBreakingCommits", () => {
  it("counts conventional-commit '!' breaking markers", () => {
    const subjects = [
      "feat(cli)!: drop legacy --old-flag",
      "fix(update): correct version comparison",
      "refactor!: rename core module",
    ];
    assert.equal(countBreakingCommits(subjects), 2);
  });

  it("counts BREAKING CHANGE footer markers embedded in the subject", () => {
    const subjects = ["feat(api): new endpoint BREAKING CHANGE: removes v1 route"];
    assert.equal(countBreakingCommits(subjects), 1);
  });

  it("returns 0 for no breaking commits, non-array, or non-string entries", () => {
    assert.equal(countBreakingCommits(["fix: typo", "docs: update readme"]), 0);
    assert.equal(countBreakingCommits(null), 0);
    assert.equal(countBreakingCommits([42, null, "feat!: ok"]), 1);
  });
});

describe("parseGitHubOwnerRepo", () => {
  it("parses https remotes with and without .git suffix", () => {
    assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widget.git"), {
      owner: "acme",
      repo: "widget",
    });
    assert.deepEqual(parseGitHubOwnerRepo("https://github.com/acme/widget"), {
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses scp-style ssh remotes", () => {
    assert.deepEqual(parseGitHubOwnerRepo("git@github.com:acme/widget.git"), {
      owner: "acme",
      repo: "widget",
    });
  });

  it("parses ssh:// remotes", () => {
    assert.deepEqual(parseGitHubOwnerRepo("ssh://git@github.com/acme/widget.git"), {
      owner: "acme",
      repo: "widget",
    });
  });

  it("returns null for non-GitHub or unparseable remotes", () => {
    assert.equal(parseGitHubOwnerRepo("https://gitlab.com/acme/widget.git"), null);
    assert.equal(parseGitHubOwnerRepo("not a url"), null);
    assert.equal(parseGitHubOwnerRepo(""), null);
    assert.equal(parseGitHubOwnerRepo(null), null);
  });
});

describe("classifyConventionalCommitLines", () => {
  it("classifies a typical GitHub auto-generated release body", () => {
    const body = [
      "## What's Changed",
      "* feat(cli): add labels command by @bot in https://github.com/acme/widget/pull/1",
      "* fix(update): correct version comparison by @bot in https://github.com/acme/widget/pull/2",
      "* fix(cli): another fix by @bot in https://github.com/acme/widget/pull/3",
      "* docs: update readme by @bot in https://github.com/acme/widget/pull/4",
    ].join("\n");
    const { counts, breakingCount } = classifyConventionalCommitLines(body);
    assert.deepEqual(counts, { feat: 1, fix: 2, docs: 1 });
    assert.equal(breakingCount, 0);
  });

  it("counts breaking markers from '!' and BREAKING CHANGE text", () => {
    const body = [
      "* feat(cli)!: drop legacy flag by @bot in https://x/pull/1",
      "* fix(core): patch BREAKING CHANGE: removes old field by @bot in https://x/pull/2",
    ].join("\n");
    const { counts, breakingCount } = classifyConventionalCommitLines(body);
    assert.equal(counts.feat, 1);
    assert.equal(counts.fix, 1);
    assert.equal(breakingCount, 2);
  });

  it("buckets non-conventional bullet lines under 'other'", () => {
    const body = "* Bump some-dependency from 1.0 to 2.0 by @dependabot in https://x/pull/9";
    const { counts } = classifyConventionalCommitLines(body);
    assert.deepEqual(counts, { other: 1 });
  });

  it("returns empty counts for empty/non-string input", () => {
    assert.deepEqual(classifyConventionalCommitLines(""), { counts: {}, breakingCount: 0 });
    assert.deepEqual(classifyConventionalCommitLines(null), { counts: {}, breakingCount: 0 });
  });
});

describe("formatUpdateChangelogSummary", () => {
  it("formats a full summary with version bump, bullets, breaking note, and link", () => {
    const result = formatUpdateChangelogSummary({
      fromVersion: "1.1.7",
      toVersion: "1.1.9",
      commandsAdded: 3,
      commandsRemoved: 1,
      commandsUpdated: 2,
      engineChanged: 1,
      breakingCount: 1,
      compareUrl: "https://github.com/acme/widget/compare/v1.1.7...v1.1.9",
    });
    assert.match(result, /Updated v1\.1\.7 -> v1\.1\.9: 3 commands added, 1 removed, 2 updated, engine: 1 file changed/);
    assert.match(result, /1 breaking change — review before continuing\./);
    assert.match(result, /See full changelog: https:\/\/github\.com\/acme\/widget\/compare\/v1\.1\.7\.\.\.v1\.1\.9/);
  });

  it("omits zero-count bullets and pluralizes correctly", () => {
    const result = formatUpdateChangelogSummary({
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      commandsAdded: 1,
    });
    assert.equal(result, "Updated v1.0.0 -> v1.0.1: 1 command added");
  });

  it("falls back to a bare headline when there is nothing to report", () => {
    const result = formatUpdateChangelogSummary({ fromVersion: "1.0.0", toVersion: "1.0.1" });
    assert.equal(result, "Updated v1.0.0 -> v1.0.1.");
  });

  it("omits the version label entirely when versions are unknown", () => {
    const result = formatUpdateChangelogSummary({ commandsAdded: 1 });
    assert.equal(result, "Updated: 1 command added");
  });

  it("handles missing opts object", () => {
    assert.equal(formatUpdateChangelogSummary(), "Updated.");
  });
});

describe("formatVersionAvailableSummary", () => {
  it("formats counts sorted descending with a release link", () => {
    const result = formatVersionAvailableSummary({
      currentVersion: "1.1.7",
      latestVersion: "1.1.9",
      typeCounts: { fix: 3, feat: 5, docs: 1 },
      releaseUrl: "https://github.com/acme/widget/releases/tag/v1.1.9",
    });
    assert.match(result, /^Changelog v1\.1\.7 -> v1\.1\.9: 5 feat, 3 fix, 1 docs/);
    assert.match(result, /See full changelog: https:\/\/github\.com\/acme\/widget\/releases\/tag\/v1\.1\.9/);
  });

  it("includes a breaking-change note when present", () => {
    const result = formatVersionAvailableSummary({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      typeCounts: { feat: 1 },
      breakingCount: 2,
    });
    assert.match(result, /2 breaking changes — review before updating\./);
  });

  it("falls back to a bare headline when there are no type counts", () => {
    const result = formatVersionAvailableSummary({
      currentVersion: "1.0.0",
      latestVersion: "1.0.1",
    });
    assert.equal(result, "Changelog v1.0.0 -> v1.0.1.");
  });

  it("handles missing opts object", () => {
    assert.equal(formatVersionAvailableSummary(), "Changelog.");
  });
});
