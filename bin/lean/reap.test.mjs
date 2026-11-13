// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { labelDockerArgs } from "./heavy.mjs";
import { runCheckCommand, reapContainers } from "./effects.mjs";

describe("#5598 reap containers", () => {
  it("labels docker run/create once; other commands untouched", () => {
    const env = { FORGE_REAP_LABEL: "forgedock.reap=x" };
    assert.deepEqual(labelDockerArgs("docker", ["run", "--rm", "img"], env), ["run", "--label", "forgedock.reap=x", "--rm", "img"]);
    assert.deepEqual(labelDockerArgs("docker", ["--debug", "create", "i"], env), ["--debug", "create", "--label", "forgedock.reap=x", "i"]);
    const done = ["run", "--label", "forgedock.reap=x", "i"];
    assert.deepEqual(labelDockerArgs("docker", done, env), done);
    assert.deepEqual(labelDockerArgs("docker", ["ps"], env), ["ps"]);
    assert.deepEqual(labelDockerArgs("docker", ["run", "i"], {}), ["run", "i"]);
    assert.deepEqual(labelDockerArgs("pytest", ["run"], env), ["run"]);
  });

  it("a timed-out check removes the containers labelled for it", async () => {
    const dir = tmpDir("reap-"), log = join(dir, "calls.log");
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> ${log}\n[ "$1" = ps ] && echo abc123\nexit 0\n`);
    chmodSync(join(dir, "docker"), 0o755);
    const r = await runCheckCommand({ command: "sleep 30", cwd: dir, timeoutMs: 300, graceMs: 100, env: { PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(r.rc, 124);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /ps -aq --filter label=forgedock\.reap=/);
    assert.match(calls, /rm -f abc123/);
  });

  it("a missing docker never throws and keeps rc", async () => {
    assert.deepEqual(await reapContainers("forgedock.reap=none", { env: { PATH: "/nonexistent" } }), []);
    const r = await runCheckCommand({ command: "exit 3", cwd: tmpDir("reap-") });
    assert.equal(r.rc, 3);
  });
});
