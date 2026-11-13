// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { laneEnv, roleRefusal, assertRole, DRIVER_ENV, ROLES } from "./release-credentials.mjs";
import { createReleaseLedger } from "./release-ledger.mjs";

describe("release credentials (#5561)", () => {
  it("roles are driver, lane and gate", () => assert.deepEqual([...ROLES], ["driver", "lane", "gate"]));

  it("laneEnv removes the driver token and every configured variable, keeping the rest", () => {
    const env = { PATH: "/bin", FORGE_DRIVER_TOKEN: "d", FORGEDOCK_DRIVER_TOKEN: "d", FORGE_RELEASE_DRIVER_TOKEN: "d", EXTRA_SECRET: "x", KEEP: "1" };
    assert.deepEqual(laneEnv(env, ["EXTRA_SECRET"]), { PATH: "/bin", KEEP: "1" });
    assert.ok(DRIVER_ENV.every((k) => !(k in laneEnv(env))));
  });

  it("the driver token is absent in a really spawned lane process", () => {
    const env = { ...process.env, FORGE_DRIVER_TOKEN: "sekrit", CUSTOM_DRIVER: "sekrit2" };
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.FORGE_DRIVER_TOKEN, process.env.CUSTOM_DRIVER]))"], { env: laneEnv(env, ["CUSTOM_DRIVER"]), encoding: "utf8" });
    assert.deepEqual(JSON.parse(r.stdout), [null, null]);
  });

  it("I12: a lane-role context is refused ledger write, gate post, merge and out-of-band release/train pushes; each refusal names role and action", async () => {
    assert.match(roleRefusal("lane", "gate-post"), /role lane may not gate-post/);
    assert.match(roleRefusal("lane", "merge", { branch: "main" }), /role lane may not merge/);
    assert.match(roleRefusal("lane", "push", { branch: "release/20240101-1" }), /role lane may not push on release\//);
    assert.match(roleRefusal("lane", "push", { branch: "train/a" }), /role lane may not push/);
    assert.throws(() => assertRole({ credential: "lane" }, "ledger-write"), /role lane may not ledger-write/);
    await assert.rejects(() => createReleaseLedger({ io: {}, repo: "o/r", credential: "lane" }, "r20240101-000000-1", {}), (e) => e.refused === "not-driver" && /role lane may not ledger-write/.test(e.message));
  });

  it("allowed: the one fix push by a lane, the driver's own actions, the gate's post, and any non-release branch", () => {
    assert.equal(roleRefusal("lane", "push", { branch: "release/x", fixPush: true }), null);
    assert.equal(roleRefusal("lane", "push", { branch: "feat/x" }), null);
    for (const a of ["ledger-write", "merge"]) assert.equal(roleRefusal("driver", a), null);
    assert.equal(roleRefusal("driver", "push", { branch: "release/x" }), null);
    assert.equal(roleRefusal("gate", "gate-post"), null);
    assert.match(roleRefusal("driver", "gate-post"), /may not gate-post/);
    assert.match(roleRefusal(undefined, "merge"), /unknown/);
  });
});
