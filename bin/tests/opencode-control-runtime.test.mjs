import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { existingBuilderBranch, runNativeWorkOn } from "../opencode/control.mjs";
import { createOpenCodePhaseRunner } from "../opencode/runner.mjs";
import { cleanupMergedWorktree, ensureWorktree, worktreePath } from "../opencode/worktree.mjs";
import { readLog } from "../engine/runlog.mjs";

const roots = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function assistant() {
  return {
    info: {
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "text", text: "complete" }],
  };
}

function fakeClient(overrides = {}) {
  const calls = { create: [], prompt: [], abort: [] };
  const client = {
    session: {
      create: async (options) => {
        calls.create.push(options);
        if (overrides.create) return overrides.create(options);
        return { data: { id: "session-1" } };
      },
      prompt: async (options) => {
        calls.prompt.push(options);
        if (overrides.prompt) return overrides.prompt(options);
        return { data: assistant() };
      },
      abort: async (options) => {
        calls.abort.push(options);
        if (overrides.abort) return overrides.abort(options);
        return { data: true };
      },
    },
  };
  return { client, calls };
}

function context(root = resolve("/repo")) {
  return {
    issue: 42,
    repo: "acme/app",
    cwd: root,
    lane: "staging",
    branch: "feat/example-42",
    worktree: null,
  };
}

describe("OpenCode runner cancellation", () => {
  it("replays an already-aborted signal before preparation and never creates or prompts", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient();
    let prepareCalls = 0;
    const runner = createOpenCodePhaseRunner({
      client: fake.client,
      context: context(),
      signal: controller.signal,
      preparePhase: async () => { prepareCalls++; return resolve("/repo"); },
    });

    await assert.rejects(
      runner({ commandName: "work-on/investigate", args: ["42"] }),
      (error) => error.code === "OPENCODE_CANCELLED",
    );
    assert.equal(prepareCalls, 0);
    assert.equal(fake.calls.create.length, 0);
    assert.equal(fake.calls.prompt.length, 0);
  });

  it("catches cancellation during prepare, create, onSession, and session-bound telemetry", async () => {
    for (const window of ["prepare", "create", "onSession", "runtimeEvent"]) {
      const controller = new AbortController();
      const gate = deferred();
      const entered = deferred();
      const fake = fakeClient({
        create: window === "create"
          ? async () => { entered.resolve(); return gate.promise; }
          : undefined,
      });
      const runner = createOpenCodePhaseRunner({
        client: fake.client,
        context: context(),
        signal: controller.signal,
        preparePhase: window === "prepare"
          ? async () => { entered.resolve(); return gate.promise; }
          : async () => resolve("/repo"),
        onSession: window === "onSession"
          ? async () => { entered.resolve(); await gate.promise; }
          : undefined,
        onRuntimeEvent: window === "runtimeEvent"
          ? async (event) => {
            if (event.event === "OPENCODE_SESSION_BOUND") {
              entered.resolve();
              await gate.promise;
            }
          }
          : undefined,
      });

      const running = runner({ commandName: "work-on/investigate", args: ["42"] });
      await entered.promise;
      controller.abort();
      gate.resolve(window === "create" ? { data: { id: "session-1" } } : resolve("/repo"));

      await assert.rejects(running, (error) => error.code === "OPENCODE_CANCELLED", window);
      assert.equal(fake.calls.prompt.length, 0, `${window}: a cancelled session must never be prompted`);
      assert.equal(fake.calls.abort.length, window === "prepare" ? 0 : 1,
        `${window}: a created session must be aborted exactly once`);
    }
  });

  it("records an SDK {error} abort response as a best-effort diagnostic", async () => {
    const controller = new AbortController();
    const promptEntered = deferred();
    const promptResult = deferred();
    const events = [];
    const fake = fakeClient({
      prompt: async () => { promptEntered.resolve(); return promptResult.promise; },
      abort: async () => {
        promptResult.resolve({ data: assistant() });
        return { error: { message: "abort denied" } };
      },
    });
    const runner = createOpenCodePhaseRunner({
      client: fake.client,
      context: context(),
      signal: controller.signal,
      onRuntimeEvent: async (event) => { events.push(event); },
    });

    const running = runner({ commandName: "work-on/investigate", args: ["42"] });
    await promptEntered.promise;
    controller.abort();

    await assert.rejects(running, (error) => error.code === "OPENCODE_CANCELLED");
    const diagnostic = events.find((event) => event.event === "OPENCODE_SESSION_ABORT_FAILED");
    assert.match(diagnostic?.failure || "", /abort denied/);
  });

  it("forwards model variant at the session.prompt body root", async () => {
    const fake = fakeClient();
    const runner = createOpenCodePhaseRunner({
      client: fake.client,
      context: { ...context(), model: "acme/model", variant: "fast" },
    });

    await runner({ commandName: "work-on/investigate", args: ["42"] });

    assert.deepEqual(fake.calls.prompt[0].body.model, { providerID: "acme", modelID: "model" });
    assert.equal(fake.calls.prompt[0].body.variant, "fast");
  });
});

function branchIo(comments, { viewer = "forge-bot", defaultBranch = "main", branches = {} } = {}) {
  const branchLookups = [];
  return {
    branchLookups,
    io: {
      gh: async (args) => {
        if (args[0] === "api" && args[1] === "user") return viewer;
        if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ comments });
        if (args[0] === "api" && args[1] === "repos/acme/app") return defaultBranch;
        if (args[0] === "api" && args[1].startsWith("repos/acme/app/branches/")) {
          const branch = decodeURIComponent(args[1].slice("repos/acme/app/branches/".length));
          branchLookups.push(branch);
          return JSON.stringify({ name: branch, protected: branches[branch] ?? false });
        }
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
    },
  };
}

describe("trusted builder branch selection", () => {
  it("skips a newer untrusted redirect and accepts the latest trusted repository actor", async () => {
    const trusted = "feat/trusted-42";
    const untrusted = "feat/redirect-42";
    const fixture = branchIo([
      {
        body: `FORGE:BUILDER:COMPLETE **Branch**: \`${trusted}\``,
        authorAssociation: "MEMBER",
        author: { login: "maintainer" },
      },
      {
        body: `FORGE:BUILDER:COMPLETE **Branch**: \`${untrusted}\``,
        authorAssociation: "NONE",
        author: { login: "stranger" },
      },
    ]);

    const branch = await existingBuilderBranch(fixture.io, 42, {
      repo: "acme/app",
      base: "staging",
      defaultBranch: "main",
    });

    assert.equal(branch, trusted);
    assert.deepEqual(fixture.branchLookups, [trusted]);
  });

  it("accepts the authenticated viewer bot even without a repository association", async () => {
    const branch = "feat/bot-42";
    const fixture = branchIo([{
      body: `FORGE:BUILDER:COMPLETE **Branch**: \`${branch}\``,
      authorAssociation: "NONE",
      author: { login: "Forge-Bot" },
    }]);

    assert.equal(await existingBuilderBranch(fixture.io, 42, {
      repo: "acme/app",
      base: "staging",
      defaultBranch: "main",
    }), branch);
  });

  it("rejects unsafe, default, base, and protected marker branches", async () => {
    const cases = [
      { branch: "refs/heads/feat/redirect", base: "staging" },
      { branch: "main", base: "staging" },
      { branch: "staging", base: "staging" },
      { branch: "feat/protected-42", base: "staging", protected: true },
    ];
    for (const item of cases) {
      const fixture = branchIo([{
        body: `FORGE:BUILDER:COMPLETE **Branch**: \`${item.branch}\``,
        authorAssociation: "OWNER",
        author: { login: "owner" },
      }], { branches: { [item.branch]: item.protected === true } });
      assert.equal(await existingBuilderBranch(fixture.io, 42, {
        repo: "acme/app",
        base: item.base,
        defaultBranch: "main",
      }), "", item.branch);
    }
  });
});

function writeForgeConfig(root) {
  writeFileSync(join(root, "forge.yaml"), `project:\n  owner: "acme"\n  repo: "app"\npaths:\n  root: "${root.replaceAll("\\", "/")}"\nbranches:\n  default: "main"\n  staging: "staging"\n  feature_pattern: "milestone/{slug}"\n`);
}

function controllerExecute(root, issue) {
  const calls = [];
  return {
    calls,
    execute: async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return root;
      if (bin === "git" && args[0] === "rev-parse" && args[1] === "--git-common-dir") return join(root, ".git");
      if (bin === "gh" && args[0] === "repo" && args[1] === "view") return "acme/app";
      if (bin === "gh" && args[0] === "issue" && args[1] === "view" && args.includes("-R")) return JSON.stringify(issue);
      if (bin === "gh" && args[0] === "api" && args[1] === "user") return "forge-bot";
      if (bin === "gh" && args[0] === "issue" && args[1] === "view" && args.includes("comments")) {
        return JSON.stringify({ comments: [] });
      }
      if (bin === "gh" && args[0] === "api" && args[1] === "repos/acme/app") return "main";
      throw new Error(`unexpected command: ${bin} ${args.join(" ")}`);
    },
  };
}

describe("runNativeWorkOn controller short circuits", () => {
  it("returns a mutation-free dry run without requiring an OpenCode client", async () => {
    const root = temp("fd-native-control-");
    const logDir = join(root, "runs");
    writeForgeConfig(root);
    const fixture = controllerExecute(root, {
      number: 42,
      title: "Example feature",
      body: "Issue body",
      state: "OPEN",
      labels: [],
      milestone: null,
      url: "https://example.test/42",
    });

    const result = await runNativeWorkOn({
      cwd: root,
      arguments: "42 --dry-run",
      dir: logDir,
      execute: fixture.execute,
    });

    assert.equal(result.status, "dry-run");
    assert.equal(result.branch, "feat/example-feature-42");
    assert.deepEqual(result.mutations, []);
    assert.deepEqual(readLog(logDir, 42), []);
  });

  it("returns an existing closed terminal result before comments, sessions, or run-log mutation", async () => {
    const root = temp("fd-native-terminal-");
    const logDir = join(root, "runs");
    writeForgeConfig(root);
    const fixture = controllerExecute(root, {
      number: 42,
      title: "Already shipped",
      body: "Issue body",
      state: "CLOSED",
      labels: [{ name: "workflow:merged" }],
      milestone: null,
      url: "https://example.test/42",
    });

    const result = await runNativeWorkOn({
      cwd: root,
      arguments: "42",
      dir: logDir,
      execute: fixture.execute,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.terminalReason, "merged");
    assert.deepEqual(result.sessions, []);
    assert.equal(result.cleanup.reason, "already-terminal");
    assert.deepEqual(readLog(logDir, 42), []);
    assert.ok(!fixture.calls.some((call) => call.includes("comments")));
    assert.ok(!fixture.calls.some((call) => call[1] === "api"));
  });
});

function git(cwd, ...args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function gitFixture() {
  const parent = temp("fd-native-worktree-");
  const root = join(parent, "repo");
  const origin = join(parent, "origin.git");
  git(parent, "init", "--bare", origin);
  git(parent, "init", "-b", "main", root);
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "-c", "user.name=ForgeDock Test", "-c", "user.email=forge@example.test", "commit", "-m", "fixture");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-u", "origin", "main");
  git(root, "branch", "staging");
  git(root, "push", "origin", "staging");
  return { parent, root };
}

describe("owned OpenCode worktrees", () => {
  it("rejects arbitrary paths, the primary checkout, and an existing branch worktree outside the owned root", async () => {
    const { parent, root } = gitFixture();

    await assert.rejects(ensureWorktree({
      repoRoot: root,
      worktreeRoot: root,
      branch: "feat/arbitrary-42",
      base: "staging",
      path: join(parent, "arbitrary"),
    }), (error) => error.code === "OPENCODE_WORKTREE_UNOWNED");

    await assert.rejects(ensureWorktree({
      repoRoot: root,
      worktreeRoot: root,
      branch: "main",
      base: "staging",
      path: worktreePath(root, "main"),
    }), (error) => error.code === "OPENCODE_WORKTREE_UNOWNED");

    git(root, "branch", "feat/outside-42");
    git(root, "worktree", "add", join(parent, "outside"), "feat/outside-42");
    await assert.rejects(ensureWorktree({
      repoRoot: root,
      worktreeRoot: root,
      branch: "feat/outside-42",
      base: "staging",
      path: worktreePath(root, "feat/outside-42"),
    }), (error) => error.code === "OPENCODE_WORKTREE_UNOWNED");
  });

  it("retains a dirty owned worktree and removes it without force once clean and merged", async () => {
    const { root } = gitFixture();
    const branch = "feat/cleanup-42";
    const path = worktreePath(root, branch);
    const ensured = await ensureWorktree({
      repoRoot: root,
      worktreeRoot: root,
      branch,
      base: "staging",
      path,
      protectedBranches: ["main", "staging"],
    });
    writeFileSync(join(path, "untracked.txt"), "retain me\n");

    const dirty = await cleanupMergedWorktree({
      repoRoot: root,
      worktreeRoot: root,
      path,
      branch,
      base: "staging",
    });
    assert.deepEqual(dirty, { removed: false, reason: "dirty-worktree" });
    assert.equal(existsSync(path), true);

    rmSync(join(path, "untracked.txt"));
    const clean = await cleanupMergedWorktree({
      repoRoot: root,
      worktreeRoot: root,
      path: ensured.path,
      branch,
      base: "staging",
    });
    assert.equal(clean.removed, true);
    assert.equal(existsSync(path), false);
  });
});
