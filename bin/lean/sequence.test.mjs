// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture: a drizzle-style migrations dir (NNNN_name.sql + meta/_journal.json + meta/NNNN_snapshot.json) where the base
// gains 0007 while the lane adds its own 0007 (#4322).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { sequenceCollisions, journalProblems, snapshotLane, verifyRenumber } from "./sequence.mjs";
import { sequencePrompt, sequenceSyncNote } from "./prompts.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitIn = (cwd) => async (a) => sh(cwd, ...a);
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
const commit = (d, m) => { sh(d, "add", "-A"); sh(d, "commit", "-qm", m); };
const journal = (...tags) => `${JSON.stringify({ version: "7", entries: tags.map((tag, idx) => ({ idx, tag, when: 1000 + idx })) }, null, 2)}\n`;

const USAGE_SQL = "CREATE TABLE usage (id int);\n";
/** main: 0006 init; lane (from main): 0007_usage; then main gains 0007_billing_reconcile. */
function fixture() {
  const d = tmpDir("seq-");
  sh(d, "init", "-q", "-b", "main");
  put(d, { "db/drizzle/0006_init.sql": "CREATE TABLE t (id int);\n", "db/drizzle/meta/_journal.json": journal("0006_init"), "db/drizzle/meta/0006_snapshot.json": '{"id":"s6"}\n' });
  commit(d, "init");
  sh(d, "checkout", "-qb", "lane");
  put(d, { "db/drizzle/0007_usage.sql": USAGE_SQL, "db/drizzle/meta/_journal.json": journal("0006_init", "0007_usage"), "db/drizzle/meta/0007_snapshot.json": '{"id":"lane7","prevId":"s6"}\n' });
  commit(d, "lane migration");
  sh(d, "checkout", "-q", "main");
  put(d, { "db/drizzle/0007_billing_reconcile.sql": "CREATE TABLE billing (id int);\n", "db/drizzle/meta/_journal.json": journal("0006_init", "0007_billing_reconcile"), "db/drizzle/meta/0007_snapshot.json": '{"id":"s7","prevId":"s6"}\n' });
  commit(d, "base migration");
  sh(d, "checkout", "-q", "lane");
  return d;
}

/** What the builder does when asked: merge the base, keep the base's journal/snapshot, rename the lane's SQL, regenerate. */
function renumber(d, { sql = null, tags = ["0006_init", "0007_billing_reconcile", "0008_usage"] } = {}) {
  try { sh(d, "merge", "--no-edit", "main"); } catch { /* journal and snapshot conflict: resolved below */ }
  sh(d, "checkout", "--theirs", "--", "db/drizzle/meta/_journal.json", "db/drizzle/meta/0007_snapshot.json");
  sh(d, "mv", "db/drizzle/0007_usage.sql", "db/drizzle/0008_usage.sql");
  if (sql) put(d, { "db/drizzle/0008_usage.sql": sql });
  put(d, { "db/drizzle/meta/_journal.json": journal(...tags), "db/drizzle/meta/0008_snapshot.json": '{"id":"lane8","prevId":"s7"}\n' });
  commit(d, "renumber");
}

describe("sequence-numbered migrations at hand-off (#4322)", () => {
  it("detects the lane's 0007 against the base's 0007 (other name, and same snapshot path with other content) and proposes 0008", async () => {
    const d = fixture();
    const c = await sequenceCollisions({ git: gitIn(d), base: "main" });
    assert.deepEqual(c.map((x) => [x.lane, x.base, x.next]), [
      ["db/drizzle/0007_usage.sql", ["db/drizzle/0007_billing_reconcile.sql"], "0008"],
      ["db/drizzle/meta/0007_snapshot.json", ["db/drizzle/meta/0007_snapshot.json"], "0008"],
    ]);
    const p = sequencePrompt(c, "main");
    assert.match(p, /git merge --no-edit origin\/main/);
    assert.match(p, /db\/drizzle\/0007_usage\.sql -> number 0008 \(base has db\/drizzle\/0007_billing_reconcile\.sql\)/);
    assert.match(p, /byte-identical[\s\S]*regenerate the snapshot and journal with the repo's own migration generator \(never hand- or text-merge the journal\)[\s\S]*strictly ordered/);
  });

  it("a correct renumber verifies: SQL unchanged, snapshot regenerated, journal strictly ordered, no collision left", async () => {
    const d = fixture();
    const before = await snapshotLane({ git: gitIn(d), base: "main" });
    assert.deepEqual(before.map((f) => f.path), ["db/drizzle/0007_usage.sql", "db/drizzle/meta/0007_snapshot.json"]);
    renumber(d);
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main" }), []);
    assert.deepEqual(await verifyRenumber({ git: gitIn(d), base: "main", before }), { ok: true, problems: [] });
  });

  it("an edited SQL body, an unordered journal, or no renumber at all fails verification", async () => {
    let d = fixture(); let before = await snapshotLane({ git: gitIn(d), base: "main" });
    renumber(d, { sql: "CREATE TABLE usage (id bigint);\n" });
    assert.match((await verifyRenumber({ git: gitIn(d), base: "main", before })).problems.join("\n"), /0007_usage\.sql: content changed/);

    d = fixture(); before = await snapshotLane({ git: gitIn(d), base: "main" });
    renumber(d, { tags: ["0006_init", "0008_usage", "0007_billing_reconcile"] });
    const v = await verifyRenumber({ git: gitIn(d), base: "main", before });
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /_journal\.json: 0007_billing_reconcile not numbered after 0008_usage/);

    d = fixture(); before = await snapshotLane({ git: gitIn(d), base: "main" });
    const left = await verifyRenumber({ git: gitIn(d), base: "main", before });
    assert.match(left.problems.join("\n"), /0007_usage\.sql still shares number 0007 with db\/drizzle\/0007_billing_reconcile\.sql/);
  });

  it("a text-clean base merge still collides (no journal: e.g. app/migrations/0007_x.py), and later lane files move to keep the order", async () => {
    const d = tmpDir("seq-");
    sh(d, "init", "-q", "-b", "main");
    put(d, { "app/migrations/0006_init.py": "x\n" }); commit(d, "init");
    sh(d, "checkout", "-qb", "lane");
    put(d, { "app/migrations/0007_a.py": "a\n", "app/migrations/0008_b.py": "b\n" }); commit(d, "lane");
    sh(d, "checkout", "-q", "main");
    put(d, { "app/migrations/0007_c.py": "c\n" }); commit(d, "base");
    sh(d, "checkout", "-q", "lane");
    sh(d, "merge", "--no-edit", "main");
    const c = await sequenceCollisions({ git: gitIn(d), base: "main" });
    assert.deepEqual(c.map((x) => [x.lane, x.base.length, x.next]), [["app/migrations/0007_a.py", 1, "0008"], ["app/migrations/0008_b.py", 0, "0009"]]);
    assert.deepEqual(await journalProblems({ git: gitIn(d), dirs: ["app/migrations"] }), []);
  });

  it("regression guard: no numbered file added, or numbers above the base's, is no collision; a broken git never throws", async () => {
    const d = fixture();
    sh(d, "reset", "-q", "--hard", "main");
    put(d, { "src/a.ts": "x\n", "db/drizzle/0008_new.sql": "y\n" }); commit(d, "lane2");
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main" }), []);
    const bad = async () => { throw new Error("boom"); };
    assert.deepEqual(await sequenceCollisions({ git: bad, base: "main" }), []);
    assert.equal(sequenceSyncNote(["src/a.ts", "package.json"]), "");
    assert.match(sequenceSyncNote(["db/drizzle/meta/_journal.json"]), /do not text-merge/);
    assert.match(sequenceSyncNote(["db/drizzle/0007_usage.sql"]), /Renumber the lane's files/);
  });
});
