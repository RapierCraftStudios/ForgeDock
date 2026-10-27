// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4662: the bot token refresh timer template and the doctor's lifetime helper.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { botTokenStatus, stampPath } from "../bot-token-status.mjs";
import { GH_AUTH_RE } from "../lean/retry.mjs";

const unit = (n) => readFileSync(new URL(`../../scripts/systemd/${n}`, import.meta.url), "utf8");
const MIN = 60000;

describe("bot token refresh timer (#4662)", () => {
  it("the timer fires after boot and on an interval, and Persistent=true catches up a missed run", () => {
    const t = unit("forgedock-bot-token-refresh.timer");
    assert.match(t, /^OnBootSec=\S+/m);
    assert.match(t, /^(OnUnitActiveSec|OnCalendar)=\S+/m);
    assert.match(t, /^Persistent=true$/m);
    assert.match(t, /^WantedBy=timers\.target$/m);
  });
  it("the service is a oneshot running refresh-bot-token.sh", () => {
    const s = unit("forgedock-bot-token-refresh.service");
    assert.match(s, /^Type=oneshot$/m);
    assert.match(s, /^ExecStart=.*refresh-bot-token\.sh/m);
  });
});

describe("botTokenStatus (#4662)", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const stamp = (agoMin, lifeMin = 60) => JSON.stringify({ refreshedAt: new Date(now - agoMin * MIN).toISOString(), expiresAt: new Date(now - agoMin * MIN + lifeMin * MIN).toISOString() });
  const at = (raw) => botTokenStatus({ now, env: { FORGE_HOME_DIR: "/h" }, read: () => { if (raw == null) throw new Error("ENOENT"); return raw; } });
  it("reads the stamp from FORGE_HOME_DIR", () => assert.equal(stampPath({ FORGE_HOME_DIR: "/h" }), "/h/bot-token.json"));
  it("no stamp is not configured and never a failure", () => assert.deepEqual(at(null), { configured: false, ok: true }));
  it("a fresh token is ok and reports remaining lifetime and age", () => {
    const s = at(stamp(10));
    assert.equal(s.ok, true); assert.equal(s.remainingMs, 50 * MIN); assert.equal(s.ageMs, 10 * MIN);
  });
  it("fails when less than 10 min remain", () => assert.equal(at(stamp(52)).ok, false));
  it("fails when the last refresh is older than 50 min", () => {
    const s = at(stamp(51, 120));
    assert.equal(s.ok, false); assert.match(s.reason, /50 min/);
  });
  it("fails on an expired token and on a corrupt stamp", () => {
    assert.match(at(stamp(70)).reason, /expired/);
    assert.equal(at("{nope").ok, false);
  });
});

describe("GH_AUTH_RE (#4662)", () => {
  it("matches a 401 and bad credentials, not 403, 429 or 5xx", () => {
    for (const t of ["HTTP 401: Bad credentials (https://api.github.com/graphql)", "gh: To use GitHub CLI, run: gh auth login"]) assert.ok(GH_AUTH_RE.test(t), t);
    for (const t of ["HTTP 403: Resource not accessible", "HTTP 429: Too Many Requests", "HTTP 502: Bad Gateway"]) assert.ok(!GH_AUTH_RE.test(t), t);
  });
});
