// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Credential lookup for sandbox providers (#4254): the env first, then the OS keychain under service `forgedock`
 * (Linux `secret-tool`, macOS `security`). A value is returned to the caller only; it is never logged, and a failed
 * lookup is `null`, never an error carrying the value or the keychain's output.
 */
import { execFileSync } from "node:child_process";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `security`/`secret-tool` lookup of `name` under service `forgedock`; null when absent, unsupported or failing. */
export function defaultKeychain(name, platform = process.platform) {
  const argv = platform === "darwin" ? ["security", ["find-generic-password", "-s", "forgedock", "-a", name, "-w"]]
    : platform === "linux" ? ["secret-tool", ["lookup", "service", "forgedock", "account", name]] : null;
  if (!argv) return null;
  try {
    const out = execFileSync(argv[0], argv[1], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
    return out.replace(/\r?\n$/, "") || null;
  } catch { return null; }
}

/** `env[name]` when non-empty, else the keychain entry `name`, else null. */
export function resolveCredential(name, { env = process.env, keychain = defaultKeychain, platform = process.platform } = {}) {
  if (!name || !NAME_RE.test(String(name))) return null;
  const v = env?.[name];
  if (v !== undefined && v !== null && String(v) !== "") return String(v);
  try { const k = keychain(String(name), platform); return k === undefined || k === null || String(k) === "" ? null : String(k); } catch { return null; }
}
