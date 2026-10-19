/**
 * init-repo.mjs — side-effecting repository setup helpers for
 * `forgedock init` (issue #4173).
 *
 * bin/init-detect.mjs stays pure (reads only). Everything that creates a
 * GitHub repository, makes the first commit, or pushes branches lives here,
 * behind an injectable `exec(cmd, args)` so tests can drive every helper
 * with a stub.
 *
 * SECURITY — every call is an argv array through execFileSync, never a
 * shell. Owner and repo names come from the user and are additionally
 * validated against GitHub's name charset before they reach `gh`.
 *
 * GitHub App coverage: the ForgeDock App can only act on repositories of
 * accounts it is installed on (field test: App on the org, repo created
 * under the personal account → the bot got a 404). listAppInstallations()
 * reports each owner as "installed", "not-installed", or "unknown" — a
 * failed lookup is never reported as covered.
 */

import { execFileSync } from "child_process";

export const APP_SLUG = "rapiercraft-forgedock";
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

/** GitHub account / repository name charset. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Default exec: run `cmd args` without a shell, return trimmed stdout.
 * Throws on non-zero exit.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string}
 */
export function defaultExec(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function tryExec(exec, cmd, args) {
  try {
    return { ok: true, out: String(exec(cmd, args) ?? "").trim() };
  } catch (err) {
    return { ok: false, out: "", error: err };
  }
}

function lines(out) {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * List the accounts the authenticated `gh` user can create repositories
 * under: their own login first, then their organizations.
 * @param {Function} exec
 * @returns {{ login: string, type: 'User'|'Organization' }[]}
 */
export function listOwners(exec = defaultExec) {
  const owners = [];
  const me = tryExec(exec, "gh", ["api", "user", "--jq", ".login"]);
  if (me.ok && me.out) owners.push({ login: me.out, type: "User" });
  const orgs = tryExec(exec, "gh", ["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
  if (orgs.ok) {
    for (const login of lines(orgs.out)) owners.push({ login, type: "Organization" });
  }
  return owners;
}

/**
 * Determine, per owner, whether the ForgeDock GitHub App is installed.
 *
 * Strategy:
 *   1. `gh api /user/installations` — installations visible to the user.
 *      Authoritative for the user's own account when it succeeds.
 *   2. Organizations not found in (1): `gh api /orgs/{org}/installations`
 *      (needs org admin). Success → installed / not-installed.
 *   3. Anything else → "unknown". Never "installed" without evidence.
 *
 * @param {Function} exec
 * @param {{ login: string, type: string }[]} owners
 * @param {string} [appSlug]
 * @returns {Map<string, 'installed'|'not-installed'|'unknown'>}
 */
export function listAppInstallations(exec = defaultExec, owners = [], appSlug = APP_SLUG) {
  const coverage = new Map();
  const userList = tryExec(exec, "gh", [
    "api", "/user/installations", "--paginate",
    "--jq", ".installations[] | [.app_slug, .account.login] | @tsv",
  ]);
  const covered = new Set();
  if (userList.ok) {
    for (const line of lines(userList.out)) {
      const [slug, login] = line.split("\t");
      if (slug === appSlug && login) covered.add(login.toLowerCase());
    }
  }

  for (const { login, type } of owners) {
    const key = login.toLowerCase();
    if (covered.has(key)) {
      coverage.set(login, "installed");
      continue;
    }
    if (type === "Organization") {
      const org = tryExec(exec, "gh", [
        "api", `/orgs/${login}/installations`, "--paginate",
        "--jq", ".installations[].app_slug",
      ]);
      if (org.ok) {
        coverage.set(login, lines(org.out).includes(appSlug) ? "installed" : "not-installed");
        continue;
      }
      coverage.set(login, "unknown");
      continue;
    }
    coverage.set(login, userList.ok ? "not-installed" : "unknown");
  }
  return coverage;
}

/**
 * Warning text when the chosen owner is not covered by the App, else "".
 * @param {string} owner
 * @param {'installed'|'not-installed'|'unknown'|undefined} status
 * @returns {string}
 */
export function ownerCoverageWarning(owner, status) {
  if (status === "installed") return "";
  if (status === "not-installed") {
    return `The ForgeDock GitHub App is not installed on '${owner}'. Pipeline bot actions on this repo will fail (404) until you install it: ${APP_INSTALL_URL}`;
  }
  return `Could not verify whether the ForgeDock GitHub App is installed on '${owner}'. Check, and install it if needed: ${APP_INSTALL_URL}`;
}

function isGitRepo(exec, root) {
  const r = tryExec(exec, "git", ["-C", root, "rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

function hasCommits(exec, root) {
  return tryExec(exec, "git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"]).ok;
}

/**
 * Create the GitHub repository and wire it up as `origin`.
 * Runs `git init -b <branch>` first when `root` is not a git repository.
 *
 * @param {Function} exec
 * @param {{ owner: string, name: string, private?: boolean, root: string, branch?: string }} opts
 * @returns {{ fullName: string, visibility: 'private'|'public' }}
 */
export function createRepo(exec = defaultExec, { owner, name, private: isPrivate = true, root, branch = "main" }) {
  if (!NAME_RE.test(owner || "")) throw new Error(`Invalid GitHub owner: '${owner}'`);
  if (!NAME_RE.test(name || "")) throw new Error(`Invalid repository name: '${name}'`);
  if (!isGitRepo(exec, root)) exec("git", ["init", "-b", branch, root]);
  const visibility = isPrivate === false ? "public" : "private";
  exec("gh", [
    "repo", "create", `${owner}/${name}`,
    `--${visibility}`,
    "--source", root,
    "--remote", "origin",
  ]);
  return { fullName: `${owner}/${name}`, visibility };
}

/**
 * Make an empty initial commit when HEAD is unborn, so `main` can be pushed.
 * Never commits the user's files.
 * @param {Function} exec
 * @param {string} root
 * @returns {{ created: boolean }}
 */
export function ensureInitialCommit(exec = defaultExec, root) {
  if (hasCommits(exec, root)) return { created: false };
  exec("git", ["-C", root, "commit", "--allow-empty", "-m", "chore: initial commit"]);
  return { created: true };
}

/**
 * Push the default branch and record it as the remote HEAD.
 * @param {Function} exec
 * @param {string} root
 * @param {string} branch
 */
export function pushMain(exec = defaultExec, root, branch = "main") {
  exec("git", ["-C", root, "push", "-u", "origin", branch]);
  // Best effort: lets detection read the remote default authoritatively.
  tryExec(exec, "git", ["-C", root, "remote", "set-head", "origin", branch]);
}

/**
 * Create `staging` on origin from `from`. No-op when it already exists.
 * @param {Function} exec
 * @param {string} root
 * @param {string} from
 * @returns {{ created: boolean }}
 */
export function createStaging(exec = defaultExec, root, from = "main") {
  const existing = tryExec(exec, "git", ["-C", root, "ls-remote", "--heads", "origin", "staging"]);
  if (existing.ok && existing.out) {
    tryExec(exec, "git", ["-C", root, "fetch", "origin", "staging"]);
    return { created: false };
  }
  exec("git", ["-C", root, "push", "origin", `${from}:refs/heads/staging`]);
  // Refresh origin/staging so re-detection sees it.
  tryExec(exec, "git", ["-C", root, "fetch", "origin", "staging"]);
  return { created: true };
}
