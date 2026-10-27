// Guard test template for repos with a drizzle-style migration journal (#4661). Copy it next to your tests and set JOURNAL.
// Newest-only migrators (drizzle `migrate()`) skip an entry whose `when` is older than one already applied. CI migrates a
// fresh database, so it never notices; parallel milestone branches interleave stamps and hit this on persistent databases.
// Run in CI with the base ref fetched: BASE_REF=origin/main node --test migration-journal-guard.test.mjs
//
// Optional upgrade test (repo-specific, not provided): migrate a database to the base's head, apply the branch's
// migrations, then assert that every migration the branch added is recorded as applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const JOURNAL = process.env.JOURNAL ?? "drizzle/meta/_journal.json";
const BASE_REF = process.env.BASE_REF ?? "origin/main";
const entries = JSON.parse(readFileSync(JOURNAL, "utf8")).entries;

test("journal `when` strictly increases", () => {
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].when > entries[i - 1].when, `${entries[i].tag} when ${entries[i].when} is not after ${entries[i - 1].tag}`);
});

test("no new entry is older than the base max `when`", (t) => {
  let base;
  try { base = JSON.parse(execFileSync("git", ["show", `${BASE_REF}:${JOURNAL}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).entries; } catch { return t.skip(`no ${JOURNAL} at ${BASE_REF}`); }
  const known = new Set(base.map((e) => e.tag)), max = Math.max(...base.map((e) => e.when));
  for (const e of entries.filter((x) => !known.has(x.tag))) assert.ok(e.when > max, `${e.tag} when ${e.when} is not above the base max ${max}: re-stamp it with the generator`);
});
