// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6034: Windows installer must survive a denied `tailscale ip` and support a no-logon keep-alive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ps = readFileSync(new URL("../../pool/install/install-agent.ps1", import.meta.url), "utf8");

test("tailscale IP resolution is null-safe and falls back to the adapter", () => {
  assert.doesNotMatch(ps, /ip -4 \| Select-Object -First 1\)\.Trim\(\)/);
  assert.match(ps, /Get-NetIPAddress -AddressFamily IPv4/);
  assert.match(ps, /InterfaceAlias -like 'Tailscale\*'/);
  assert.match(ps, /no Tailscale IPv4 address/);
});

test("-KeepaliveAtStartup registers a startup trigger with an S4U principal", () => {
  assert.match(ps, /\[switch\] \$KeepaliveAtStartup/);
  assert.match(ps, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(ps, /-LogonType S4U/);
});
