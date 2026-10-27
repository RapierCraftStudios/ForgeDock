// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/** #4662: bot token lifetime from the stamp scripts/refresh-bot-token.sh writes (~/.forge/bot-token.json). Pure; `doctor` renders it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MIN_REMAINING_MS = 10 * 60 * 1000;
export const MAX_AGE_MS = 50 * 60 * 1000;

export const stampPath = (env = process.env) => join(env.FORGE_HOME_DIR || join(homedir(), ".forge"), "bot-token.json");

/** @returns {{configured:boolean, ok:boolean, remainingMs?:number, ageMs?:number, refreshedAt?:string, reason?:string}} */
export function botTokenStatus({ now = Date.now(), env = process.env, read = (p) => readFileSync(p, "utf8") } = {}) {
  let raw;
  try { raw = read(stampPath(env)); } catch { return { configured: false, ok: true }; }
  let s;
  try { s = JSON.parse(raw); } catch { return { configured: true, ok: false, reason: "bot-token.json is not valid JSON" }; }
  const refreshed = Date.parse(s?.refreshedAt), expires = Date.parse(s?.expiresAt);
  if (!Number.isFinite(refreshed) || !Number.isFinite(expires)) return { configured: true, ok: false, reason: "bot-token.json has no refreshedAt/expiresAt" };
  const remainingMs = expires - now, ageMs = now - refreshed;
  const out = { configured: true, remainingMs, ageMs, refreshedAt: s.refreshedAt };
  if (remainingMs < MIN_REMAINING_MS) return { ...out, ok: false, reason: remainingMs <= 0 ? "token expired" : "less than 10 min of token lifetime remain" };
  if (ageMs > MAX_AGE_MS) return { ...out, ok: false, reason: "no refresh in the last 50 min" };
  return { ...out, ok: true };
}
