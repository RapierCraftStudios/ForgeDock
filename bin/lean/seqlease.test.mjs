// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Host sequence lease (#4386): one numbered-file lane per (repo, lane, dir) in the renumber→CI→merge window.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { makeSequenceLeaseIo, sequenceLeaseKey } from "./seqlease.mjs";
import { sequenceCollisions, journalProblems, renumberLane } from "./sequence.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lease = () => makeSequenceLeaseIo({ dir: tmpDir("seqlease-"), pollMs: 20 });

describe("sequence lease (#4386)", () => {
  it("a second acquire on the same (repo, lane, dir) waits for the release; other dirs, lanes and repos do not; release is idempotent", async () => {
    const io = lease(), order = [];
    const a = await io.acquire({ repo: "o/r", lane: "staging", dirs: ["db"], maxWaitS: 30 });
    const other = await io.acquire({ repo: "o/r", lane: "staging", dirs: ["docs/adr"], maxWaitS: 30 });
    const otherLane = await io.acquire({ repo: "o/r", lane: "milestone/x", dirs: ["db"], maxWaitS: 30 });
    assert.equal(other.timedOut, false);
    assert.equal(otherLane.timedOut, false);
    const b = io.acquire({ repo: "o/r", lane: "staging", dirs: ["db"], maxWaitS: 30 }).then((g) => { order.push("b"); return g; });
    await sleep(150);
    order.push("a-release");
    a.release(); a.release();
    const gb = await b;
    assert.deepEqual(order, ["a-release", "b"]);
    assert.ok(gb.waitMs >= 100);
    gb.release(); other.release(); otherLane.release();
    assert.notEqual(sequenceLeaseKey("o/r", "staging", "db"), sequenceLeaseKey("o/r", "staging", "db2"));
  });

  it("a wait over maxWaitS proceeds without the lease (fail-open)", async () => {
    const io = lease();
    const a = await io.acquire({ repo: "o/r", lane: "staging", dirs: ["db"], maxWaitS: 30 });
    const b = await io.acquire({ repo: "o/r", lane: "staging", dirs: ["db"], maxWaitS: 0.1 });
    assert.equal(b.timedOut, true);
    b.release(); a.release();
  });
});

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
const gitIn = (cwd) => async (a) => sh(cwd, ...a);
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };
const journal = (...tags) => `${JSON.stringify({ version: "7", entries: tags.map((tag, idx) => ({ idx, tag, when: 1000 + idx })) }, null, 2)}\n`;
const snap = (id, prevId) => `${JSON.stringify({ version: "7", id, prevId, tables: { t: 1 } }, null, 2)}\n`;

describe("two lanes adding migrations to the same lane branch (#4386) [integration]", () => {
  it("the second renumbers at the merge gate under the lease and merges; neither ends base.conflict", async () => {
    const root = tmpDir("seqlanes-"), origin = join(root, "origin.git"), seed = join(root, "seed");
    sh(root, "init", "-q", "--bare", "-b", "staging", origin);
    sh(root, "clone", "-q", origin, seed);
    sh(seed, "checkout", "-qb", "staging");
    put(seed, { "db/0048_init.sql": "CREATE TABLE t (id int);\n", "db/meta/_journal.json": journal("0048_init"), "db/meta/0048_snapshot.json": snap("s48", "s47") });
    commit(seed, "init");
    sh(seed, "push", "-q", "origin", "staging");
    const lanes = ["a", "b"].map((n) => {
      const d = join(root, `lane-${n}`);
      sh(root, "clone", "-q", "-b", "staging", origin, d);
      sh(d, "checkout", "-qb", `feat/${n}`);
      put(d, { [`db/0049_${n}.sql`]: `INSERT INTO t VALUES ('${n}');\n`, "db/meta/_journal.json": journal("0048_init", `0049_${n}`), "db/meta/0049_snapshot.json": snap(`lane-${n}`, "s48") });
      commit(d, `lane ${n}`);
      return d;
    });
    const io = lease(), outcomes = [];
    let inWindow = 0, maxInWindow = 0;
    /** The merge gate of one lane: lease, re-fetch, late renumber when the number is taken, "CI", merge, release. */
    const gate = async (d) => {
      const l = await io.acquire({ repo: "o/r", lane: "staging", dirs: ["db"], maxWaitS: 60 });
      inWindow++; maxInWindow = Math.max(maxInWindow, inWindow);
      try {
        sh(d, "fetch", "-q", "origin", "staging");
        const base = "origin/staging";
        const c = await sequenceCollisions({ git: gitIn(d), base });
        let how = "no collision";
        if (c.length) {
          const r = await renumberLane({ git: gitIn(d), base, cwd: d });
          assert.ok(r.ok, r.unsupported);
          how = `renumbered ${r.moves.map((m) => m.to).join(", ")}`;
        }
        await sleep(100); // required checks
        sh(d, "push", "-q", "origin", "HEAD:staging"); // the merge: rejected if the base moved meanwhile
        outcomes.push({ d, how, outcome: "merged" });
      } catch (e) { outcomes.push({ d, outcome: "base.conflict", error: String(e?.message ?? e) }); }
      finally { inWindow--; l.release(); }
    };
    await Promise.all(lanes.map(gate));
    assert.deepEqual(outcomes.map((o) => o.outcome), ["merged", "merged"], JSON.stringify(outcomes));
    assert.equal(maxInWindow, 1, "one numbered-file PR in the window at a time");
    assert.equal(outcomes[0].how, "no collision");
    assert.match(outcomes[1].how, /renumbered db\/0050_[ab]\.sql/);
    sh(seed, "pull", "-q", "origin", "staging");
    const tags = JSON.parse(sh(seed, "show", "HEAD:db/meta/_journal.json")).entries.map((e) => e.tag);
    assert.deepEqual(tags.map((t) => t.slice(0, 4)), ["0048", "0049", "0050"]);
    assert.deepEqual(await journalProblems({ git: gitIn(seed), dirs: ["db"] }), []);
  });
});
