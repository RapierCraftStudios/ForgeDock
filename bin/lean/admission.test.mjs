// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { quotaCores, hostParallelism } from "./admission.mjs";

const files = (m) => (f) => { if (!(f in m)) throw new Error("ENOENT"); return m[f]; };

describe("quotaCores (#6047)", () => {
  it("cgroup v2 cpu.max `400000 100000` on 20 VM cores gives 4; `max 100000` gives 20", () => {
    assert.equal(quotaCores({ cores: 20, read: files({ "/sys/fs/cgroup/cpu.max": "400000 100000\n" }) }), 4);
    assert.equal(quotaCores({ cores: 20, read: files({ "/sys/fs/cgroup/cpu.max": "max 100000\n" }) }), 20);
  });
  it("cgroup v1 quota/period; -1 is unlimited", () => {
    const v1 = (q) => files({ "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": q, "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" });
    assert.equal(quotaCores({ cores: 20, read: v1("200000") }), 2);
    assert.equal(quotaCores({ cores: 20, read: v1("-1") }), 20);
  });
  it("unreadable files give the VM cores; CS_CPU_QUOTA is the fallback; a quota above the VM is capped", () => {
    assert.equal(quotaCores({ cores: 20, read: files({}) }), 20);
    assert.equal(quotaCores({ cores: 20, read: files({}), env: { CS_CPU_QUOTA: "4" } }), 4);
    assert.equal(quotaCores({ cores: 2, read: files({ "/sys/fs/cgroup/cpu.max": "800000 100000" }) }), 2);
    assert.equal(quotaCores({ cores: 20, read: files({}), env: { CS_CPU_QUOTA: "junk" } }), 20);
  });
  it("hostParallelism with the quota divides the container's cores, not the VM's", () => {
    const cores = quotaCores({ cores: 20, read: files({ "/sys/fs/cgroup/cpu.max": "400000 100000" }) });
    assert.equal(hostParallelism({ cores, lanes: 2 }), 2);
    assert.equal(hostParallelism({ cores: 20, lanes: 2 }), 10);
  });
});
