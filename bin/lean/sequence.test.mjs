// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture: a drizzle-style migrations dir (NNNN_name.sql + meta/_journal.json + meta/NNNN_snapshot.json) where the base
// gains 0007 while the lane adds its own 0007 (#4322).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { sequenceCollisions, journalProblems, snapshotLane, verifyRenumber, numberOnlyChange, renumberLane, resolveSequenceConflicts } from "./sequence.mjs";
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

describe("deterministic renumber (#4386)", () => {
  /** main gets `baseFiles`, the lane (from main) adds `laneFiles`, then main gets `laterBase`; returns the repo on the lane. */
  const repo = (baseFiles, laneFiles, laterBase) => {
    const d = tmpDir("seq4386-");
    sh(d, "init", "-q", "-b", "main");
    put(d, baseFiles); commit(d, "base");
    sh(d, "checkout", "-qb", "lane");
    put(d, laneFiles); commit(d, "lane");
    sh(d, "checkout", "-q", "main"); put(d, laterBase); commit(d, "later base");
    sh(d, "checkout", "-q", "lane");
    return d;
  };
  const show = (d, p) => sh(d, "show", `HEAD:${p}`);
  const snap = (id, prevId, tables = { t: 1 }) => `${JSON.stringify({ version: "7", id, prevId, tables }, null, 2)}\n`;
  const NCLT_SQL = "INSERT INTO adapters (name) VALUES ('nclt');\n";
  /** base 0048; the lane adds a data-only 0049_nclt; then the base takes 0049-0051. */
  const drizzle = ({ laneTables = { t: 1 } } = {}) => repo(
    { "db/0048_init.sql": "CREATE TABLE t (id int);\n", "db/meta/_journal.json": journal("0048_init"), "db/meta/0048_snapshot.json": snap("s48", "s47") },
    { "db/0049_nclt.sql": NCLT_SQL, "db/meta/_journal.json": journal("0048_init", "0049_nclt"), "db/meta/0049_snapshot.json": snap("lane49", "s48", laneTables) },
    {
      "db/0049_a.sql": "a;\n", "db/0050_b.sql": "b;\n", "db/0051_c.sql": "CREATE TABLE u (id int);\n",
      "db/meta/_journal.json": journal("0048_init", "0049_a", "0050_b", "0051_c"),
      "db/meta/0049_snapshot.json": snap("s49", "s48"), "db/meta/0050_snapshot.json": snap("s50", "s49"), "db/meta/0051_snapshot.json": snap("s51", "s50", { t: 1, u: 1 }),
    },
  );

  it("verifyRenumber accepts an ADR whose only change is its own heading number, and an index row change (#4386)", async () => {
    const adr = (body) => repo(
      { "docs/adr/0015-a.md": "# 0015. A\n", "docs/adr/0016-b.md": "# 0016. B\n", "docs/adr/README.md": "| 0015 | A |\n| 0016 | B |\n" },
      { "docs/adr/0017-nclt.md": "# 0017. NCLT adapter\n\nWe adopt 0017-style adapters.\n", "docs/adr/README.md": "| 0015 | A |\n| 0016 | B |\n| 0017 | [NCLT](0017-nclt.md) |\n" },
      { "docs/adr/0017-other.md": "# 0017. Other\n", "docs/adr/README.md": "| 0015 | A |\n| 0016 | B |\n| 0017 | Other |\n" },
    );
    for (const [body, ok] of [["We adopt 0017-style adapters.", true], ["We adopt other adapters.", false]]) {
      const d = adr();
      const before = await snapshotLane({ git: gitIn(d), base: "main" });
      try { sh(d, "merge", "--no-edit", "main"); } catch { /* README conflict: resolved below */ }
      sh(d, "mv", "-f", "docs/adr/0017-nclt.md", "docs/adr/0018-nclt.md");
      put(d, { "docs/adr/0018-nclt.md": `# 0018. NCLT adapter\n\n${body}\n`, "docs/adr/README.md": "| 0015 | A |\n| 0016 | B |\n| 0017 | Other |\n| 0018 | [NCLT](0018-nclt.md) |\n" });
      commit(d, "renumber");
      const v = await verifyRenumber({ git: gitIn(d), base: "main", before });
      assert.equal(v.ok, ok, v.problems.join("; "));
      if (!ok) assert.match(v.problems.join("\n"), /docs\/adr\/0017-nclt\.md: content changed/);
    }
  });

  it("base takes 0049-0051 while the lane holds 0049: renumberLane moves it to 0052, clones the tip snapshot, appends the journal, and the lane merges", async () => {
    const d = drizzle();
    const before = await snapshotLane({ git: gitIn(d), base: "main" });
    const r = await renumberLane({ git: gitIn(d), base: "main", cwd: d, uuid: () => "fresh-id" });
    assert.deepEqual(r.moves, [{ from: "db/0049_nclt.sql", to: "db/0052_nclt.sql" }]);
    assert.equal(r.commit, sh(d, "rev-parse", "HEAD").trim());
    assert.equal(show(d, "db/0052_nclt.sql"), NCLT_SQL, "SQL byte-identical");
    assert.ok(!existsSync(join(d, "db/0049_nclt.sql")));
    assert.equal(show(d, "db/meta/0049_snapshot.json"), snap("s49", "s48"), "base snapshot restored at the shared path");
    const base51 = JSON.parse(show(d, "db/meta/0051_snapshot.json")), mine = JSON.parse(show(d, "db/meta/0052_snapshot.json"));
    assert.deepEqual(mine, { ...base51, id: "fresh-id", prevId: "s51" });
    const j = JSON.parse(show(d, "db/meta/_journal.json"));
    const baseJ = JSON.parse(sh(d, "show", "main:db/meta/_journal.json"));
    assert.deepEqual(j.entries.slice(0, 4), baseJ.entries);
    assert.deepEqual(j.entries[4], { idx: 4, tag: "0052_nclt", when: 1001 });
    assert.deepEqual(j.entries.map((e) => e.idx), [0, 1, 2, 3, 4]);
    assert.deepEqual(await journalProblems({ git: gitIn(d), dirs: ["db"] }), []);
    assert.deepEqual(await sequenceCollisions({ git: gitIn(d), base: "main" }), []);
    assert.deepEqual(await verifyRenumber({ git: gitIn(d), base: "main", before, moves: r.moves }), { ok: true, problems: [] });
    sh(d, "checkout", "-q", "main");
    sh(d, "merge", "--no-edit", "lane"); // the lane merges into its base without conflicts
    assert.deepEqual(await journalProblems({ git: gitIn(d), dirs: ["db"] }), []);
  });

  it("references to the old basename are rewritten repo-wide (a link from another ADR, a code comment) and the index keeps both rows", async () => {
    const d = repo(
      { "docs/adr/0015-a.md": "# 0015. A\n", "docs/adr/0016-b.md": "# 0016. B\n", "docs/adr/0017-c.md": "# 0017. C\n", "docs/adr/0018-d.md": "# 0018. D\n", "docs/adr/README.md": "# ADRs\n\n- 0018 D\n", "src/x.ts": "export const x = 1;\n" },
      { "docs/adr/0019-nclt.md": "# 0019. NCLT\n\nSupersedes nothing.\n", "docs/adr/0015-a.md": "# 0015. A\n\nSee [NCLT](0019-nclt.md).\n", "docs/adr/README.md": "# ADRs\n\n- 0018 D\n- [0019 NCLT](0019-nclt.md)\n", "src/x.ts": "// docs/adr/0019-nclt.md\nexport const x = 1;\n" },
      { "docs/adr/0019-other.md": "# 0019. Other\n", "docs/adr/README.md": "# ADRs\n\n- 0018 D\n- 0019 Other\n" },
    );
    const before = await snapshotLane({ git: gitIn(d), base: "main" });
    const r = await renumberLane({ git: gitIn(d), base: "main", cwd: d });
    assert.deepEqual(r.moves, [{ from: "docs/adr/0019-nclt.md", to: "docs/adr/0020-nclt.md" }]);
    assert.equal(show(d, "docs/adr/0020-nclt.md"), "# 0020. NCLT\n\nSupersedes nothing.\n");
    assert.equal(show(d, "docs/adr/0015-a.md"), "# 0015. A\n\nSee [NCLT](0020-nclt.md).\n");
    assert.equal(show(d, "src/x.ts"), "// docs/adr/0020-nclt.md\nexport const x = 1;\n");
    const idx = show(d, "docs/adr/README.md");
    assert.match(idx, /0019 Other/);
    assert.match(idx, /\(0020-nclt\.md\)/);
    assert.doesNotMatch(idx, /<<<<<<<|0019-nclt/);
    assert.equal(sh(d, "status", "--porcelain").trim(), "");
    assert.deepEqual(await verifyRenumber({ git: gitIn(d), base: "main", before, moves: r.moves }), { ok: true, problems: [] });
  });

  it("falls back (unsupported, branch unchanged) for a schema-changing migration without regenerate or a .py migration; a regenerate command fills the snapshot", async () => {
    let d = drizzle({ laneTables: { t: 1, nclt: 1 } });
    let head = sh(d, "rev-parse", "HEAD");
    let r = await renumberLane({ git: gitIn(d), base: "main", cwd: d });
    assert.match(r.unsupported, /schema-changing migration db\/0049_nclt\.sql needs lean\.sequence\.regenerate/);
    assert.equal(sh(d, "rev-parse", "HEAD"), head);
    assert.equal(sh(d, "status", "--porcelain").trim(), "");
    const calls = [];
    r = await renumberLane({ git: gitIn(d), base: "main", cwd: d, regenerate: "pnpm db:generate", run: async (cmd, o) => { calls.push(cmd); writeFileSync(join(o.cwd, "db/meta/0052_snapshot.json"), snap("gen", "s51", { t: 1, u: 1, nclt: 1 })); } });
    assert.ok(r.ok, r.unsupported);
    assert.deepEqual(calls, ["pnpm db:generate"]);
    assert.equal(JSON.parse(show(d, "db/meta/0052_snapshot.json")).id, "gen");
    assert.deepEqual(await journalProblems({ git: gitIn(d), dirs: ["db"] }), []);
    d = repo({ "app/migrations/0001_initial.py": "i\n", "app/migrations/0002_x.py": "x\n" }, { "app/migrations/0003_y.py": "y\n" }, { "app/migrations/0003_z.py": "z\n" });
    head = sh(d, "rev-parse", "HEAD");
    r = await renumberLane({ git: gitIn(d), base: "main", cwd: d });
    assert.match(r.unsupported, /app\/migrations\/0003_y\.py: no deterministic renumber for \.py migrations/);
    assert.equal(sh(d, "rev-parse", "HEAD"), head);
  });

  it("resolveSequenceConflicts takes the base side for journal/snapshot conflicts, then renumberLane from the pre-merge head gives a valid chain; another conflicted file is unsupported", async () => {
    let d = drizzle();
    const pre = sh(d, "rev-parse", "HEAD").trim();
    assert.throws(() => sh(d, "merge", "--no-edit", "main"));
    const files = sh(d, "diff", "--name-only", "--diff-filter=U").trim().split("\n");
    assert.deepEqual(files.sort(), ["db/meta/0049_snapshot.json", "db/meta/_journal.json"]);
    assert.deepEqual(await resolveSequenceConflicts({ git: gitIn(d), files }), { ok: true });
    assert.ok(!existsSync(join(d, ".git", "MERGE_HEAD")), "merge committed");
    const r = await renumberLane({ git: gitIn(d), base: "main", cwd: d, laneRef: pre, uuid: () => "u52" });
    assert.deepEqual(r.moves, [{ from: "db/0049_nclt.sql", to: "db/0052_nclt.sql" }]);
    assert.deepEqual(JSON.parse(show(d, "db/meta/_journal.json")).entries.map((e) => e.tag), ["0048_init", "0049_a", "0050_b", "0051_c", "0052_nclt"]);
    assert.equal(JSON.parse(show(d, "db/meta/0052_snapshot.json")).prevId, "s51");
    assert.deepEqual(await journalProblems({ git: gitIn(d), dirs: ["db"] }), []);
    d = repo({ "db/0001_a.sql": "a\n", "db/0002_b.sql": "b\n", "db/meta/_journal.json": journal("0001_a", "0002_b"), "src/a.ts": "1\n" },
      { "db/0003_c.sql": "c\n", "db/meta/_journal.json": journal("0001_a", "0002_b", "0003_c"), "src/a.ts": "2\n" },
      { "db/0003_d.sql": "d\n", "db/meta/_journal.json": journal("0001_a", "0002_b", "0003_d"), "src/a.ts": "3\n" });
    assert.throws(() => sh(d, "merge", "--no-edit", "main"));
    const f2 = sh(d, "diff", "--name-only", "--diff-filter=U").trim().split("\n");
    assert.deepEqual(await resolveSequenceConflicts({ git: gitIn(d), files: f2 }), { unsupported: "non-sequence conflict: src/a.ts" });
    assert.ok(readFileSync(join(d, "src/a.ts"), "utf8").includes("<<<<<<<"), "left for the builder");
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
