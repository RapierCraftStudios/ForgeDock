// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routerFresh, upgradeAgentsAfterUpdate } from "../pool/version.mjs";

const installed = { version: "1.69.0", code: "new", image: "img" };
const sleep = async () => {};

test("a router already on the installed code is fresh, with no restart", async () => {
  let restarts = 0;
  const r = await routerFresh("x", { installed, probe: async () => ({ version: "1.69.0", code: "new" }), restart: async () => { restarts++; return true; }, sleep });
  assert.equal(r.ok, true); assert.equal(restarts, 0);
});

test("a stale router is restarted and polled until it runs the installed code", async () => {
  let restarted = false;
  const r = await routerFresh("x", { installed, probe: async () => (restarted ? { version: "1.69.0", code: "new" } : { version: "1.68.0", code: "old" }), restart: async () => { restarted = true; return true; }, sleep });
  assert.equal(r.ok, true); assert.equal(restarted, true);
});

test("a router that stays stale or cannot restart is not fresh, and the agents are not pushed", async () => {
  const stale = await routerFresh("x", { installed, probe: async () => ({ version: "1.68.0", code: "old" }), restart: async () => true, sleep, waitMs: 3000 });
  assert.equal(stale.ok, false); assert.match(stale.why, /did not come back/);
  assert.equal((await routerFresh("x", { installed, probe: async () => ({ version: "1.68.0", code: "old" }), restart: async () => false, sleep })).ok, false);
  const dir = mkdtempSync(join(tmpdir(), "fresh-")); const configPath = join(dir, "router.json"); writeFileSync(configPath, "{}");
  const calls = [], warns = [];
  const out = await upgradeAgentsAfterUpdate({ configPath, runPoolCli: async (a) => { calls.push(a); }, warn: (m) => warns.push(m), ensureRouterFresh: async () => ({ ok: false, running: "1.68.0", installed: "1.69.0", why: "could not restart the router" }) });
  assert.equal(out, "skipped"); assert.deepEqual(calls, []); assert.match(warns[0], /pool upgrade skipped/);
});
