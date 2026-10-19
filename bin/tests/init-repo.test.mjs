/**
 * bin/tests/init-repo.test.mjs — repo-setup helpers for `forgedock init`
 * (forge#4173): owner listing, GitHub App coverage, repo creation, initial
 * push of `main`, and `staging` creation.
 *
 * Run with: node --test bin/tests/init-repo.test.mjs
 */

import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  APP_INSTALL_URL, listOwners, listAppInstallations, ownerCoverageWarning,
  createRepo, ensureInitialCommit, pushMain, createStaging,
} from "../init-repo.mjs";

/** Stub exec: maps "cmd arg1 arg2" → stdout string | Error; records calls. */
function stubExec(map = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    if (!Array.isArray(args)) throw new Error("exec must receive an argv array");
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [pattern, value] of Object.entries(map)) {
      if (key === pattern || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected: ${key}`);
  };
  return { exec, calls };
}

const USER_INSTALLS = "gh api /user/installations --paginate --jq .installations[] | [.app_slug, .account.login] | @tsv";

describe("listOwners", () => {
  it("returns the user login then their orgs", () => {
    const { exec } = stubExec({
      "gh api user --jq .login": "alice\n",
      "gh api user/orgs --paginate --jq .[].login": "acme\nwidgets\n",
    });
    assert.deepEqual(listOwners(exec), [
      { login: "alice", type: "User" },
      { login: "acme", type: "Organization" },
      { login: "widgets", type: "Organization" },
    ]);
  });

  it("returns [] when gh is unavailable or unauthenticated", () => {
    const { exec } = stubExec({ "gh *": new Error("gh: not logged in") });
    assert.deepEqual(listOwners(exec), []);
  });
});

describe("listAppInstallations", () => {
  const owners = [
    { login: "alice", type: "User" },
    { login: "Acme", type: "Organization" },
    { login: "widgets", type: "Organization" },
    { login: "secret-org", type: "Organization" },
  ];

  it("maps installed / not-installed / unknown per owner", () => {
    const { exec } = stubExec({
      [USER_INSTALLS]: "other-app\talice\nrapiercraft-forgedock\tacme\n",
      "gh api /orgs/widgets/installations --paginate --jq .installations[].app_slug": "some-other-app\n",
      "gh api /orgs/secret-org/installations *": new Error("HTTP 403"),
    });
    const cov = listAppInstallations(exec, owners);
    assert.equal(cov.get("alice"), "not-installed");
    assert.equal(cov.get("Acme"), "installed", "login comparison is case-insensitive");
    assert.equal(cov.get("widgets"), "not-installed");
    assert.equal(cov.get("secret-org"), "unknown");
  });

  it("falls back to the per-org endpoint, and never reports a failed lookup as installed", () => {
    const { exec } = stubExec({
      [USER_INSTALLS]: new Error("HTTP 403: Resource not accessible by integration"),
      "gh api /orgs/Acme/installations --paginate --jq .installations[].app_slug": "rapiercraft-forgedock\n",
      "gh api /orgs/*": new Error("HTTP 403"),
    });
    const cov = listAppInstallations(exec, owners);
    assert.equal(cov.get("alice"), "unknown");
    assert.equal(cov.get("Acme"), "installed");
    assert.equal(cov.get("widgets"), "unknown");
    assert.equal(cov.get("secret-org"), "unknown");
  });
});

describe("ownerCoverageWarning", () => {
  it("is empty only for an installed owner", () => {
    assert.equal(ownerCoverageWarning("acme", "installed"), "");
    assert.match(ownerCoverageWarning("alice", "not-installed"), /not installed on 'alice'/);
    assert.match(ownerCoverageWarning("alice", "unknown"), /Could not verify/);
    assert.match(ownerCoverageWarning("alice", undefined), /Could not verify/);
    for (const status of ["not-installed", "unknown"]) {
      assert.ok(ownerCoverageWarning("x", status).includes(APP_INSTALL_URL));
    }
  });
});

describe("createRepo", () => {
  it("creates a private repo by default with --source and --remote origin", () => {
    const { exec, calls } = stubExec({
      "git -C /p rev-parse --is-inside-work-tree": "true",
      "gh repo create *": "",
    });
    const res = createRepo(exec, { owner: "acme", name: "proj", root: "/p" });
    assert.deepEqual(res, { fullName: "acme/proj", visibility: "private" });
    assert.equal(calls.at(-1), "gh repo create acme/proj --private --source /p --remote origin");
  });

  it("public only when explicitly requested; git-inits a non-repo first", () => {
    const { exec, calls } = stubExec({
      "git -C /p rev-parse --is-inside-work-tree": new Error("not a git repository"),
      "git init -b main /p": "",
      "gh repo create *": "",
    });
    const res = createRepo(exec, { owner: "acme", name: "proj", root: "/p", private: false });
    assert.equal(res.visibility, "public");
    assert.deepEqual(calls.slice(1), ["git init -b main /p", "gh repo create acme/proj --public --source /p --remote origin"]);
  });

  it("rejects owner/repo names outside GitHub's charset before calling gh", () => {
    const { exec, calls } = stubExec({});
    assert.throws(() => createRepo(exec, { owner: "acme; rm -rf /", name: "proj", root: "/p" }), /Invalid GitHub owner/);
    assert.throws(() => createRepo(exec, { owner: "acme", name: "$(id)", root: "/p" }), /Invalid repository name/);
    assert.deepEqual(calls, []);
  });
});

describe("ensureInitialCommit / createStaging (stubbed)", () => {
  it("commits only when HEAD is unborn", () => {
    const born = stubExec({ "git -C /p rev-parse --verify --quiet HEAD": "abc123" });
    assert.deepEqual(ensureInitialCommit(born.exec, "/p"), { created: false });
    assert.equal(born.calls.length, 1);
    const unborn = stubExec({
      "git -C /p rev-parse --verify --quiet HEAD": new Error("exit 1"),
      "git -C /p commit --allow-empty -m chore: initial commit": "",
    });
    assert.deepEqual(ensureInitialCommit(unborn.exec, "/p"), { created: true });
  });

  it("pushes <from>:refs/heads/staging, and is a no-op when staging exists", () => {
    const fresh = stubExec({
      "git -C /p ls-remote --heads origin staging": "",
      "git -C /p push origin main:refs/heads/staging": "",
      "git -C /p fetch origin staging": "",
    });
    assert.deepEqual(createStaging(fresh.exec, "/p", "main"), { created: true });
    assert.ok(fresh.calls.includes("git -C /p push origin main:refs/heads/staging"));
    const existing = stubExec({
      "git -C /p ls-remote --heads origin staging": "abc\trefs/heads/staging",
      "git -C /p fetch origin staging": "",
    });
    assert.deepEqual(createStaging(existing.exec, "/p", "main"), { created: false });
    assert.ok(!existing.calls.some((c) => c.includes(" push ")));
  });
});

describe("pushMain + createStaging against a real bare remote", () => {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com",
  };
  const exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env, timeout: 20000 }).trim();

  it("empty local repo → initial commit, main pushed, staging created (idempotent)", () => {
    const base = tmpDir("fd-init-repo-");
    const bare = join(base, "remote.git");
    const root = join(base, "work");
    mkdirSync(root);
    exec("git", ["init", "--bare", bare]);
    exec("git", ["init", "-b", "main", root]);
    exec("git", ["-C", root, "remote", "add", "origin", bare]);

    assert.deepEqual(ensureInitialCommit(exec, root), { created: true });
    pushMain(exec, root, "main");
    assert.deepEqual(createStaging(exec, root, "main"), { created: true });

    const heads = exec("git", ["ls-remote", "--heads", bare]);
    assert.match(heads, /refs\/heads\/main/);
    assert.match(heads, /refs\/heads\/staging/);
    assert.match(exec("git", ["-C", root, "branch", "-r"]), /origin\/staging/, "re-detection must see origin/staging");
    assert.deepEqual(createStaging(exec, root, "main"), { created: false });
    assert.deepEqual(ensureInitialCommit(exec, root), { created: false });
  });
});
