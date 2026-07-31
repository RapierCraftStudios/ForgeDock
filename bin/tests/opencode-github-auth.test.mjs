import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGitHubAuthRecovery,
  isGitHubAuthFailure,
  runGitHubSyncWithAuthRecovery,
  runGitHubWithAuthRecovery,
} from "../opencode/github-auth.mjs";

function authError() {
  return Object.assign(new Error("gh failed"), { stderr: "HTTP 401: Bad credentials" });
}

function failedAuthResult() {
  return { status: 1, stdout: "", stderr: "HTTP 401: Bad credentials" };
}

describe("OpenCode GitHub authentication recovery", () => {
  it("falls back from stale token overrides, refreshes once, and retries", async () => {
    const env = { Gh_Token: "expired", github_token: "also-expired", KEEP: "yes" };
    const refreshCalls = [];
    const recovery = createGitHubAuthRecovery({
      env,
      script: "/forge/scripts/refresh-bot-token.sh",
      fileExists: () => true,
      execute: async (bin, args, options) => {
        refreshCalls.push({ bin, args, env: options.env });
        return { stdout: "refreshed", stderr: "" };
      },
    });
    const commandEnvironments = [];
    let attempts = 0;

    const result = await runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        attempts++;
        commandEnvironments.push(options.env);
        if (attempts < 4) throw authError();
        return { stdout: "owner/repo", stderr: "" };
      },
    });

    assert.equal(result.stdout, "owner/repo");
    assert.equal(attempts, 4);
    assert.equal(commandEnvironments[0].Gh_Token, "expired");
    assert.equal(commandEnvironments[1].Gh_Token, undefined);
    assert.equal(commandEnvironments[1].github_token, "also-expired");
    assert.equal(commandEnvironments[2].github_token, undefined);
    assert.equal(commandEnvironments[3].github_token, undefined);
    assert.equal(refreshCalls.length, 1);
    assert.equal(refreshCalls[0].bin, "bash");
    assert.equal(refreshCalls[0].env.Gh_Token, undefined);
    assert.equal(refreshCalls[0].env.github_token, undefined);
    assert.equal(refreshCalls[0].env.KEEP, "yes");
    assert.deepEqual(recovery.shellOverrides(), { GH_TOKEN: "", GITHUB_TOKEN: "" });
  });

  it("tries GITHUB_TOKEN after a stale higher-priority GH_TOKEN", async () => {
    const env = { GH_TOKEN: "expired", GITHUB_TOKEN: "valid" };
    let refreshCalls = 0;
    const recovery = createGitHubAuthRecovery({
      env,
      fileExists: () => true,
      execute: async () => {
        refreshCalls++;
        return { stdout: "refreshed" };
      },
    });
    let attempts = 0;

    const result = await runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        attempts++;
        if (options.env.GH_TOKEN) throw authError();
        assert.equal(options.env.GITHUB_TOKEN, "valid");
        return { stdout: "secondary-token" };
      },
    });

    assert.equal(result.stdout, "secondary-token");
    assert.equal(attempts, 2);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(recovery.shellOverrides(), { GH_TOKEN: "" });
  });

  it("uses valid stored gh credentials without running the refresh script", async () => {
    const env = { GH_TOKEN: "expired" };
    let refreshCalls = 0;
    const recovery = createGitHubAuthRecovery({
      env,
      fileExists: () => true,
      execute: async () => {
        refreshCalls++;
        return { stdout: "refreshed" };
      },
    });

    const result = await runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        if (options.env.GH_TOKEN) throw authError();
        return { stdout: "stored-auth" };
      },
    });

    assert.equal(result.stdout, "stored-auth");
    assert.equal(refreshCalls, 0);
    assert.deepEqual(recovery.shellOverrides(), { GH_TOKEN: "", GITHUB_TOKEN: "" });
  });

  it("reports an unavailable refresh script without retrying indefinitely", async () => {
    const recovery = createGitHubAuthRecovery({ env: {}, script: "/missing/refresh.sh", fileExists: () => false });
    let attempts = 0;

    await assert.rejects(
      runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
        recovery,
        execute: async () => {
          attempts++;
          throw authError();
        },
      }),
      /no automatic refresh script was found at \/missing\/refresh\.sh/,
    );
    assert.equal(attempts, 1);
  });

  it("stops after one refresh when GitHub still returns 401", async () => {
    let refreshCalls = 0;
    const recovery = createGitHubAuthRecovery({
      env: {},
      fileExists: () => true,
      execute: async () => {
        refreshCalls++;
        return { stdout: "refreshed" };
      },
    });
    let attempts = 0;

    await assert.rejects(
      runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
        recovery,
        execute: async () => {
          attempts++;
          throw authError();
        },
      }),
      /still failed after automatic token refresh/,
    );
    assert.equal(attempts, 2);
    assert.equal(refreshCalls, 1);
  });

  it("applies the same bounded recovery to synchronous preflight calls", () => {
    const env = { GH_TOKEN: "expired", KEEP: "yes" };
    let refreshCalls = 0;
    const recovery = createGitHubAuthRecovery({
      env,
      fileExists: () => true,
      spawn: (_bin, _args, options) => {
        refreshCalls++;
        assert.equal(options.env.GH_TOKEN, undefined);
        return { status: 0, stdout: "refreshed", stderr: "" };
      },
    });
    const environments = [];
    let attempts = 0;

    const result = runGitHubSyncWithAuthRecovery(["issue", "list"], "/repo", {
      recovery,
      spawn: (_bin, _args, options) => {
        attempts++;
        assert.equal(options.timeout, 30_000);
        environments.push(options.env);
        return attempts < 3
          ? failedAuthResult()
          : { status: 0, stdout: "[]", stderr: "" };
      },
    });

    assert.equal(result.stdout, "[]");
    assert.equal(attempts, 3);
    assert.equal(refreshCalls, 1);
    assert.equal(environments[0].GH_TOKEN, "expired");
    assert.equal(environments[1].GH_TOKEN, undefined);
    assert.equal(environments[2].GH_TOKEN, undefined);
  });

  it("uses the detected absolute Git Bash path on Windows", async () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    const script = "C:\\forge\\scripts\\refresh-bot-token.sh";
    const expectedBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    let refreshBin = "";
    const recovery = createGitHubAuthRecovery({
      env,
      platform: "win32",
      script,
      fileExists: (path) => path === script || path === expectedBash,
      execute: async (bin) => {
        refreshBin = bin;
        return { stdout: "refreshed" };
      },
    });

    await runGitHubWithAuthRecovery(["repo", "view"], "C:\\repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        if (options.env.GH_TOKEN === undefined && recovery.mode() === "stored") return { stdout: "ok" };
        throw authError();
      },
    });
    assert.equal(refreshBin, expectedBash);
  });

  it("does not classify command arguments as authentication output", () => {
    const unrelated = Object.assign(
      new Error("Command failed: gh issue create --body reported expired token"),
      { stderr: "GraphQL: issue title is invalid" },
    );
    assert.equal(isGitHubAuthFailure(unrelated), false);
    assert.equal(isGitHubAuthFailure({ stderr: "HTTP 401: Bad credentials" }), true);
    assert.equal(
      isGitHubAuthFailure({ stderr: "To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable." }),
      true,
    );
  });

  it("never lets a slower fallback overwrite a concurrently confirmed stored mode", async () => {
    const env = { GH_TOKEN: "expired", GITHUB_TOKEN: "also-expired" };
    const recovery = createGitHubAuthRecovery({ env, fileExists: () => false });
    let releaseSecondary;
    let secondaryStarted;
    const secondaryReady = new Promise((resolve) => {
      secondaryStarted = resolve;
    });
    const secondaryRelease = new Promise((resolve) => {
      releaseSecondary = resolve;
    });

    const slower = runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        if (options.env.GH_TOKEN) throw authError();
        if (options.env.GITHUB_TOKEN) {
          secondaryStarted();
          await secondaryRelease;
          return { stdout: "secondary" };
        }
        throw authError();
      },
    });
    await secondaryReady;

    const stored = await runGitHubWithAuthRecovery(["repo", "view"], "/repo", {
      recovery,
      execute: async (_bin, _args, options) => {
        if (options.env.GH_TOKEN || options.env.GITHUB_TOKEN) throw authError();
        return { stdout: "stored" };
      },
    });
    assert.equal(stored.stdout, "stored");
    releaseSecondary();
    assert.equal((await slower).stdout, "secondary");
    assert.deepEqual(recovery.shellOverrides(), { GH_TOKEN: "", GITHUB_TOKEN: "" });
  });
});
