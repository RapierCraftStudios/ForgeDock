// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Late account capture for a lane (#5268). The tokenbaton shim exports the chosen account and then execs claude with
 * the same pid, so a single /proc read at spawn sees the shim's env and finds no account. `watchAccount` keeps
 * reading while the child is alive until an account shows up, so a usage limit can exclude the limited account.
 */

/**
 * Polls `read()` (a number or null) every `intervalMs` for up to `maxMs` until it returns a value, then calls `onFound`.
 * Reads once at once. Returns `{stop, current}`; `current()` is the account found so far (or null). Timers are unref'd.
 */
export function watchAccount(read, { intervalMs = 200, maxMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout, onFound = () => {} } = {}) {
  let found = null, timer = null, stopped = false, waited = 0;
  const probe = () => { try { const v = read(); return v ?? null; } catch { return null; } };
  const stop = () => { stopped = true; if (timer !== null) { clearTimer(timer); timer = null; } };
  const tick = () => {
    timer = null;
    if (stopped) return;
    const v = probe();
    if (v !== null) { found = v; stopped = true; onFound(v); return; }
    waited += intervalMs;
    if (waited >= maxMs) { stopped = true; return; }
    timer = setTimer(tick, intervalMs); timer?.unref?.();
  };
  tick();
  return { stop, current: () => found, refresh: () => { if (found === null) { const v = probe(); if (v !== null) { found = v; onFound(v); } } return found; } };
}
