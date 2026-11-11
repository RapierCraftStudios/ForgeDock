// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSystemdUnit, renderWatchdog, renderLaunchdPlist, installWatchUnit, watchUnitName } from "./issuewatch-install.mjs";

const o = { node: "/usr/bin/node", cli: "/x/forgedock.mjs", name: "nomilestone", repo: "o/r", cwd: "/work dir" };

test("#5465 systemd unit restarts on failure and runs the named watch from the repo dir", () => {
  const u = renderSystemdUnit(o);
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^WorkingDirectory=\/work dir$/m);
  assert.match(u, /ExecStart=\/usr\/bin\/node \/x\/forgedock\.mjs issue-watch run --name nomilestone --repo o\/r$/m);
  assert.match(renderWatchdog(o).service, /issue-watch watchdog/);
  assert.match(renderWatchdog(o).timer, /OnUnitActiveSec=60s/);
});

test("#5465 launchd plist keeps the agent alive only after a failed exit", () => {
  const p = renderLaunchdPlist(o);
  assert.match(p, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(p, /<string>issue-watch<\/string>/);
});

test("#5465 installWatchUnit writes three systemd files and enables them; other platforms are refused", () => {
  const written = [], ran = [];
  const r = installWatchUnit({ ...o, platform: "linux", home: "/h", run: (c, a) => ran.push([c, ...a].join(" ")), write: (p) => written.push(p) });
  assert.equal(written.length, 3); assert.equal(r.files.length, 3);
  assert.ok(written[0].endsWith(`${watchUnitName("nomilestone")}.service`));
  assert.ok(ran.some((l) => /enable --now forgedock-issue-watch-nomilestone\.service/.test(l)));
  assert.throws(() => installWatchUnit({ ...o, platform: "win32" }), /unsupported platform/);
});
