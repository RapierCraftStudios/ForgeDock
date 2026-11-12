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

// #5529: the unit the real installer writes must let a lane find claude; nothing in the install/render path is replaced
import { mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpDir } from "../tests/_tmp.mjs";

const exe = (p) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "#!/bin/sh\nexit 0\n"); chmodSync(p, 0o755); return p; };
/** systemd unquoting of one double-quoted word (`\x` escapes, doubled `$`/`%`). */
const sdWord = (w) => w.replace(/\\(.)/g, "$1").replace(/\$\$/g, "$").replace(/%%/g, "%");

test("#5529 the installed unit's PATH resolves the staged claude shim and carries the lane environment without the token value", () => {
  const root = tmpDir("iw5529-"), home = join(root, "home"), bin = join(root, "opt", "claude-bin"), tb = join(root, "tb");
  const claude = exe(join(bin, "claude"));
  const tokenFile = join(home, ".config", "computeshare", "forgedock.token");
  mkdirSync(join(tokenFile, ".."), { recursive: true }); writeFileSync(tokenFile, "file-token-xyz\n");
  const env = { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: "/tmp", TOKENBATON_HOME: tb, TOKENBATON_SWITCH_AT: "90", COMPUTESHARE_TOKEN: "secret-value-123", CLAUDE_CONFIG_DIR: "/x/claude" };
  const ran = [];
  const r = installWatchUnit({ ...o, platform: "linux", home, env, run: (c, a) => ran.push([c, ...a].join(" ")) });
  const unit = readFileSync(r.files[0], "utf8");
  // the observable: a shell started with the unit's PATH finds claude (the systemd default /usr/local/bin:/usr/bin did not)
  const envLine = (k) => { const m = new RegExp(`^Environment="${k}=((?:[^"\\\\]|\\\\.)*)"$`, "m").exec(unit); return m ? sdWord(m[1]) : null; };
  const path = envLine("PATH");
  assert.ok(path, "unit sets PATH");
  assert.equal(execFileSync("/bin/sh", ["-c", "command -v claude"], { env: { PATH: path }, encoding: "utf8" }).trim(), claude);
  assert.equal(path.split(":")[0], bin, "the resolved claude dir comes first");
  assert.equal(envLine("TMPDIR"), "/tmp");
  assert.equal(envLine("TOKENBATON_HOME"), tb);
  assert.equal(envLine("TOKENBATON_SWITCH_AT"), "90");
  assert.match(unit, /^UnsetEnvironment=CLAUDE_CONFIG_DIR$/m);
  assert.doesNotMatch(unit, /secret-value-123|file-token-xyz/, "the token value is never written into the unit");
  // the token is sourced when the unit starts: run the ExecStart wrapper with a PATH that has only cat (no secret-tool)
  const m = /^ExecStart=\/bin\/sh -c "((?:[^"\\]|\\.)*)" forgedock-issue-watch (.*)$/m.exec(unit);
  assert.ok(m, "ExecStart wraps the watch in a token-sourcing sh");
  assert.match(m[2], /forgedock\.mjs issue-watch run --name nomilestone --repo o\/r$/);
  const catOnly = join(root, "catbin"); mkdirSync(catOnly); symlinkSync(execFileSync("/bin/sh", ["-c", "command -v cat"], { encoding: "utf8" }).trim(), join(catOnly, "cat"));
  const out = execFileSync("/bin/sh", ["-c", sdWord(m[1]), "forgedock-issue-watch", "/bin/sh", "-c", 'printf %s "$COMPUTESHARE_TOKEN"'], { env: { PATH: catOnly }, encoding: "utf8" });
  assert.equal(out, "file-token-xyz");
  assert.ok(ran.some((l) => /enable --now forgedock-issue-watch-nomilestone\.service/.test(l)));
});

test("#5529 launchd plist carries the lane PATH/TMPDIR, never the token", () => {
  const root = tmpDir("iw5529-"), bin = join(root, "b"); exe(join(bin, "claude"));
  const written = {};
  installWatchUnit({ ...o, platform: "darwin", home: join(root, "h"), env: { PATH: `${bin}:/usr/bin`, COMPUTESHARE_TOKEN: "secret-value-123" }, run: () => {}, write: (p, t) => { written[p] = t; } });
  const p = Object.values(written)[0];
  assert.match(p, new RegExp(`<key>EnvironmentVariables</key><dict><key>PATH</key><string>${bin}:`));
  assert.match(p, /<key>TMPDIR<\/key><string>\/tmp<\/string>/);
  assert.doesNotMatch(p, /secret-value-123/);
});
