// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5901: pool lanes run in per-sandbox checkouts; the depcache namespace must come from the repo, not the checkout path.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { depcacheNamespace, makeDepCache } from "../lean/depcache.mjs";
import { repoKey } from "../runner.mjs";
import { tmpDir } from "./_tmp.mjs";

describe("depcacheNamespace", () => {
  it("same repo from different worktree paths shares one depcache namespace", () => {
    const a = "/cache/work/sbx-a/repo", b = "/cache/work/sbx-b/repo";
    assert.notEqual(repoKey(a), repoKey(b)); // today's key: one namespace per lane
    assert.equal(depcacheNamespace({ repo: "Acme/Shop", fallback: repoKey(a) }), depcacheNamespace({ repo: "acme/shop", fallback: repoKey(b) }));
    assert.notEqual(depcacheNamespace({ repo: "acme/shop" }), depcacheNamespace({ repo: "acme/other" }));
    assert.match(depcacheNamespace({ repo: "acme/shop" }), /^[a-z0-9._-]+$/);
  });
  it("falls back to the path key when no repo is known", () => {
    assert.equal(depcacheNamespace({ repo: "", fallback: "x-1234" }), "x-1234");
  });
});

describe("depcache sharing across lanes", () => {
  it("same lockfiles from N worktrees on different bases give one snapshot entry", async () => {
    const root = tmpDir("dck-root-");
    let installs = 0;
    const exec = async (cmd, args, o) => { if (args[0] === "install" || args.includes("install") || args.includes("ci")) { installs++; mkdirSync(join(o?.cwd ?? ".", "node_modules/x"), { recursive: true }); writeFileSync(join(o?.cwd ?? ".", "node_modules/x/i.js"), "1"); } return ""; };
    const dc = makeDepCache({ root, exec });
    const ns = depcacheNamespace({ repo: "acme/shop", fallback: "unused" });
    const res = [];
    for (const lane of ["a", "b", "c"]) {
      const wt = tmpDir(`dck-wt-${lane}-`);
      writeFileSync(join(wt, "package.json"), '{"name":"s","version":"1.0.0"}');
      writeFileSync(join(wt, "package-lock.json"), '{"name":"s","lockfileVersion":3,"packages":{}}');
      res.push(...(await dc.prepare({ wt, repoKey: ns })));
    }
    const snaps = readdirSync(join(root, ns)).filter((n) => /^npm-[0-9a-f]{16}$/.test(n));
    assert.equal(snaps.length, 1);
    assert.ok(res.slice(1).every((r) => r.status === "hit"), JSON.stringify(res.map((r) => r.status)));
    assert.ok(Number(readFileSync(join(root, ns, snaps[0], "last-used"), "utf8")) > 0);
  });
});
