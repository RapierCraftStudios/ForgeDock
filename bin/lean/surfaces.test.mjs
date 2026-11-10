// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared surfaces (#5340): parse, match, reserved slots, generator exemption.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../tests/_tmp.mjs";
import { makeSequenceLeaseIo } from "./seqlease.mjs";
import { parseSharedSurfaces, matchSurfaces, generatorNote, claimSurfaces, globToRegExp } from "./surfaces.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => makeSequenceLeaseIo({ dir: tmpDir("surf-"), pickDir: tmpDir("surfpick-"), declDir: tmpDir("surfdecl-"), pollMs: 20 });
const SURF = parseSharedSurfaces("db/migrations/**, api/routes.ts, src/registry.ts => npm run gen:registry, , api/routes.ts");

describe("parse and match (#5340)", () => {
  it("parses a comma scalar and a list; drops blanks and duplicates; no declaration yields none", () => {
    assert.deepEqual(SURF.map((s) => [s.name, s.generate]), [["db/migrations/**", null], ["api/routes.ts", null], ["src/registry.ts", "npm run gen:registry"]]);
    assert.equal(parseSharedSurfaces(["a/", "b/**"]).length, 2);
    assert.deepEqual(parseSharedSurfaces(undefined), []);
  });
  it("globs: ** any depth, * one segment, trailing slash is the dir", () => {
    assert.ok(globToRegExp("db/**").test("db/a/b.sql"));
    assert.ok(globToRegExp("db/*.sql").test("db/a.sql"));
    assert.ok(!globToRegExp("db/*.sql").test("db/x/a.sql"));
    assert.ok(globToRegExp("i18n/").test("i18n/en/x.json"));
  });
  it("a generated registry is exempt from reservation and gets a builder note", () => {
    const m = matchSurfaces(SURF, ["db/migrations/0001.sql", "src/registry.ts", "README.md"]);
    assert.deepEqual(m.reserved.map((r) => r.name), ["db/migrations/**"]);
    assert.deepEqual(m.generated.map((g) => g.name), ["src/registry.ts"]);
    assert.match(generatorNote(m.generated), /do not hand-edit src\/registry\.ts; regenerate with `npm run gen:registry`/);
    assert.equal(generatorNote([]), "");
  });
});

describe("reserved slot (#5340)", () => {
  it("two lanes on one surface cannot both be admitted: the second waits for the first's release", async () => {
    const lease = mk(), order = [];
    const a = await claimSurfaces({ lease, repo: "o/r", issue: 1, surfaces: SURF, paths: ["api/routes.ts"], maxWaitS: 30 });
    const b = claimSurfaces({ lease, repo: "o/r", issue: 2, surfaces: SURF, paths: ["api/routes.ts"], maxWaitS: 30 }).then((g) => { order.push("b"); return g; });
    await sleep(150);
    assert.deepEqual(order, [], "b is still waiting");
    assert.deepEqual((await lease.declared({ repo: "o/r", except: 2 })).map((d) => d.issue), [1], "in-flight declaration is readable");
    order.push("a-release"); a.release();
    const gb = await b;
    assert.deepEqual(order, ["a-release", "b"]);
    gb.release();
  });
  it("different surfaces do not block; nothing declared or touched claims nothing; undeclare drops the record", async () => {
    const lease = mk();
    const a = await claimSurfaces({ lease, repo: "o/r", issue: 1, surfaces: SURF, paths: ["api/routes.ts"], maxWaitS: 30 });
    const b = await claimSurfaces({ lease, repo: "o/r", issue: 2, surfaces: SURF, paths: ["db/migrations/1.sql"], maxWaitS: 30 });
    assert.equal(b.timedOut, false);
    assert.equal(await claimSurfaces({ lease, repo: "o/r", issue: 3, surfaces: [], paths: ["api/routes.ts"] }), null);
    assert.equal(await claimSurfaces({ lease, repo: "o/r", issue: 3, surfaces: SURF, paths: ["x.md"] }), null);
    a.release(); b.release();
    await lease.undeclare({ repo: "o/r", issue: 1 });
    assert.deepEqual((await lease.declared({ repo: "o/r" })).map((d) => d.issue), [2]);
  });
});
