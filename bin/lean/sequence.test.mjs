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
import { sequenceCollisions, journalProblems, snapshotLane, verifyRenumber, numberOnlyChange } from "./sequence.mjs";
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

  /** A base commit with `baseFiles`, a lane commit adding `laneFiles`, then `laterBase` on main; returns the repo on the lane. */
  const twoCommits = (baseFiles, laneFiles, laterBase = null) => {
    const d = tmpDir("seq-");
    sh(d, "init", "-q", "-b", "main");
    put(d, baseFiles); commit(d, "base");
    sh(d, "checkout", "-qb", "lane");
    put(d, laneFiles); commit(d, "lane");
    if (laterBase) { sh(d, "checkout", "-q", "main"); put(d, laterBase); commit(d, "later base"); sh(d, "checkout", "-q", "lane"); }
    return d;
  };

  it("date and issue-number filename prefixes are not sequence numbers (#4343)", async () => {
    const d = twoCommits(
      { "blog/2026-10-05-first.md": "a\n", "news/20261005-a.md": "a\n", "docs/4322-a.md": "a\n", "docs2/2447-a.md": "a\n", "docs2/4160-b.md": "b\n" },
      { "blog/2026-10-20-second.md": "b\n", "news/20261020-b.md": "b\n", "docs/4322-b.md": "b\n", "docs2/4160-c.md": "c\n" },
    );
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main" }), []);
    assert.deepEqual(await snapshotLane({ git: gitIn(d), base: "main" }).then((s) => s.map((f) => f.path).sort()), ["docs/4322-b.md", "docs2/4160-c.md"]);
    assert.equal(sequenceSyncNote(["blog/2026-10-05-first.md"]), "");
    assert.equal(sequenceSyncNote(["news/20261005-a.md"]), "");
  });

  it("real series still collide: SQL, Python, drizzle with a single base migration plus journal (#4343)", async () => {
    const d = twoCommits(
      {
        "db/0006_a.sql": "a\n", "db/0007_other.sql": "o\n",
        "app/migrations/0001_initial.py": "i\n", "app/migrations/0002_x.py": "x\n", "app/migrations/__init__.py": "",
        "drizzle/0000_init.sql": "CREATE TABLE t (id int);\n", "drizzle/meta/_journal.json": journal("0000_init"),
      },
      { "db/0007_usage.sql": "u\n", "app/migrations/0002_y.py": "y\n", "drizzle/0000_x.sql": "CREATE TABLE x (id int);\n", "drizzle/meta/0000_snapshot.json": '{"id":"lane0"}\n' },
      { "drizzle/meta/0000_snapshot.json": '{"id":"s0"}\n' },
    );
    const c = await sequenceCollisions({ git: gitIn(d), base: "main" });
    assert.deepEqual(c.map((x) => [x.lane, x.base, x.next]).sort((a, b) => a[0].localeCompare(b[0])), [
      ["app/migrations/0002_y.py", ["app/migrations/0002_x.py"], "0003"],
      ["db/0007_usage.sql", ["db/0007_other.sql"], "0008"],
      ["drizzle/0000_x.sql", ["drizzle/0000_init.sql"], "0001"],
      ["drizzle/meta/0000_snapshot.json", ["drizzle/meta/0000_snapshot.json"], "0001"],
    ]);
  });
});

describe("sequence-numbered documents: two siblings each add an ADR (#4385)", () => {
  const INDEX = "# ADRs\n\n- [0001](0001-one.md)\n- [0002](0002-two.md)\n- [0003](0003-three.md)\n";
  /** main: docs/adr/0001..0003 + README index; the lane adds 0004-b.md; main then merges a sibling's 0004-a.md. */
  function adrFixture() {
    const d = tmpDir("seq-adr-");
    sh(d, "init", "-q", "-b", "main");
    put(d, { "docs/adr/0001-one.md": "# 1. One\n", "docs/adr/0002-two.md": "# 2. Two\n", "docs/adr/0003-three.md": "# 3. Three\n", "docs/adr/README.md": INDEX });
    commit(d, "init");
    sh(d, "checkout", "-qb", "lane");
    put(d, { "docs/adr/0004-b.md": "# 4. Use B\n\nStatus: accepted (ADR 0004)\n", "docs/adr/README.md": `${INDEX}- [0004](0004-b.md)\n` });
    commit(d, "lane adr");
    sh(d, "checkout", "-q", "main");
    put(d, { "docs/adr/0004-a.md": "# 4. Use A\n", "docs/adr/README.md": `${INDEX}- [0004](0004-a.md)\n` });
    commit(d, "sibling adr");
    sh(d, "checkout", "-q", "lane");
    return d;
  }
  /** The builder: merge the base (the index conflicts), rename to 0005, fix its own title, write the index. */
  function renumberAdr(d, { title = "# 5. Use B\n\nStatus: accepted (ADR 0005)\n", index = `${INDEX}- [0004](0004-a.md)\n- [0005](0005-b.md)\n` } = {}) {
    try { sh(d, "merge", "--no-edit", "main"); } catch { /* README.md conflicts: written below */ }
    sh(d, "mv", "docs/adr/0004-b.md", "docs/adr/0005-b.md");
    put(d, { "docs/adr/0005-b.md": title, "docs/adr/README.md": index });
    commit(d, "renumber adr");
  }

  it("the lane's ADR collides with the sibling's 0004 and moves to 0005", async () => {
    const d = adrFixture();
    const c = await sequenceCollisions({ git: gitIn(d), base: "main" });
    assert.deepEqual(c.map((x) => [x.lane, x.base, x.next]), [["docs/adr/0004-b.md", ["docs/adr/0004-a.md"], "0005"]]);
  });

  it("a renumber that changes only the ADR's own number and lists both in the index verifies: distinct numbers, index correct", async () => {
    const d = adrFixture();
    const before = await snapshotLane({ git: gitIn(d), base: "main" });
    renumberAdr(d);
    const v = await verifyRenumber({ git: gitIn(d), base: "main", before });
    assert.deepEqual(v, { ok: true, problems: [] });
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main" }), []);
  });

  it("an index still linking the old name, or a body change beyond the number, fails verification", async () => {
    const d = adrFixture();
    const before = await snapshotLane({ git: gitIn(d), base: "main" });
    renumberAdr(d, { index: `${INDEX}- [0004](0004-a.md)\n- [0004](0004-b.md)\n` });
    const v = await verifyRenumber({ git: gitIn(d), base: "main", before });
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => /docs\/adr\/README\.md: still references 0004-b/.test(p)), v.problems.join("\n"));
    const d2 = adrFixture();
    const before2 = await snapshotLane({ git: gitIn(d2), base: "main" });
    renumberAdr(d2, { title: "# 5. Use C instead\n\nStatus: accepted (ADR 0005)\n" });
    const v2 = await verifyRenumber({ git: gitIn(d2), base: "main", before: before2 });
    assert.equal(v2.ok, false);
    assert.ok(v2.problems.some((p) => /0004-b\.md: content changed/.test(p)), v2.problems.join("\n"));
  });

  it("numberOnlyChange accepts padded and unpadded own-number edits only", () => {
    assert.equal(numberOnlyChange("# 16. X (0016)\nsee 160 and 16x\n", "# 17. X (0017)\nsee 160 and 16x\n", "0016", "0017"), true);
    assert.equal(numberOnlyChange("# 16. X\n", "# 17. Y\n", "0016", "0017"), false);
    assert.equal(numberOnlyChange("CREATE TABLE t;\n", "CREATE TABLE t;\n", "0007", "0008"), true);
    assert.equal(numberOnlyChange("a\n", "b\n", null, "0008"), false);
  });

  it("the renumber prompt names numbered documents and the series index", () => {
    const p = sequencePrompt([{ dir: "docs/adr", number: "0004", lane: "docs/adr/0004-b.md", base: ["docs/adr/0004-a.md"], next: "0005" }], "staging");
    assert.match(p, /ADR/);
    assert.match(p, /series index/);
  });
});
