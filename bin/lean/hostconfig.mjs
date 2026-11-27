// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5917: a lane must not rewrite host-global tool config (`poetry config virtualenvs.create false` poisoned every later host
 * `poetry install`). Every tool reads its user config from an env-named path, so the lane env points those at files under the
 * per-run dir: any process the lane spawns writes there. Nothing is seeded from the host (a poisoned value would carry over);
 * git's global file `[include]`s the host's so identity and credential helpers still apply while `--global` writes stay in the lane.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const HOSTCONFIG_DIR = "hostconfig";
export const ENV_POETRY_CREATE_FALSE = "env.host_poetry_config";

const realFs = { exists: existsSync, mkdir: (p) => mkdirSync(p, { recursive: true }), read: (p) => readFileSync(p, "utf8"), write: writeFileSync };

/** The env that redirects tool user-config into `<dir>/hostconfig`. Creates the dir and the git include file; {} without a dir. */
export function laneConfigEnv({ dir, hostHome = homedir(), env = process.env, fs = realFs } = {}) {
  if (!dir) return {};
  const root = join(dir, HOSTCONFIG_DIR), poetry = join(root, "poetry"), gitFile = join(root, "gitconfig");
  const out = {
    POETRY_CONFIG_DIR: poetry,
    npm_config_userconfig: join(root, "npmrc"),
    PIP_CONFIG_FILE: join(root, "pip.conf"),
    UV_CONFIG_FILE: join(root, "uv.toml"),
    GIT_CONFIG_GLOBAL: gitFile,
  };
  try {
    fs.mkdir(poetry);
    const host = env.GIT_CONFIG_GLOBAL || (hostHome ? join(hostHome, ".gitconfig") : "");
    fs.write(gitFile, host && fs.exists(host) ? `[include]\n\tpath = ${host}\n` : "");
  } catch { /* best effort: the vars still redirect writes into the lane dir */ }
  return out;
}

/** Host poetry config with `virtualenvs.create = false`: every `poetry install` there skips the venv. Null when fine, missing or unreadable. */
export function hostPoetryConfigProblem({ env = process.env, home = homedir(), read = (p) => readFileSync(p, "utf8") } = {}) {
  const base = env.POETRY_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "pypoetry");
  const file = join(base, "config.toml");
  let text;
  try { text = read(file); } catch { return null; }
  let section = "";
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = line.match(/^(?:"?virtualenvs"?\.)?"?create"?\s*=\s*(\S+)$/);
    const full = line.match(/^virtualenvs\.create\s*=\s*(\S+)$/);
    const v = full ? full[1] : kv && section === "virtualenvs" ? kv[1] : null;
    if (v === "false") return { code: ENV_POETRY_CREATE_FALSE, detail: `${file} sets virtualenvs.create = false: every host \`poetry install\` skips the virtualenv and fails; run \`poetry config virtualenvs.create true\` (or remove the line)` };
  }
  return null;
}
