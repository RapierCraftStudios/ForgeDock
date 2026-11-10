// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProdParity, prodParityFailures, touchedSurfaces } from "./prodparity.mjs";
import { readEnvConfig } from "../engine-cli.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

const run = async ({ command }) => { const r = spawnSync("bash", ["-c", command], { encoding: "utf8" }); return { rc: r.status ?? 127, output: `${r.stdout}${r.stderr}` }; };
const dir = tmpDir("prodparity-");
const fail = join(dir, "fail.sh"); writeFileSync(fail, "echo \"parity: $*\" >&2; exit 1\n");
const pass = join(dir, "pass.sh"); writeFileSync(pass, "exit 0\n");

// The four AlterLab defects (2026-10-11..11-10): each prod-only surface is declared; the PR's files touch it.
const RULES = parseProdParity({
  "web/app/**": "note: exercise the page under the production ISR runtime (next start), including the not-found path",
  "infra/traefik/**": `bash ${fail}`,
  "db/migrations/**": `bash ${fail}`,
  ".env.production": `bash ${fail}`,
});
const REPLAYS = [
  ["#38270 /blog ISR", ["web/app/blog/[slug]/page.tsx"], "prod_parity_unjustified"],
  ["#38241 Traefik routing", ["infra/traefik/api-router.yml"], "prod_parity_failed"],
  ["#39108 migration role", ["db/migrations/0042_feedback.sql"], "prod_parity_failed"],
  ["#36906 shared env", [".env.production"], "prod_parity_failed"],
];

describe("prod_parity (#5284)", () => {
  for (const [name, files, kind] of REPLAYS) {
    it(`replay ${name} is flagged`, async () => {
      const f = await prodParityFailures({ rules: RULES, changedFiles: files, result: {}, run });
      assert.equal(f.length, 1);
      assert.equal(f[0].kind, kind);
      assert.equal(f[0].code, "conformance.unimplemented");
    });
  }
  it("a passing command or a recorded justification clears the surface", async () => {
    const ok = parseProdParity({ "db/migrations/**": `bash ${pass}` });
    assert.deepEqual(await prodParityFailures({ rules: ok, changedFiles: ["db/migrations/1.sql"], result: {}, run }), []);
    const result = { parity: [{ surface: "web/app/**", justification: "ran next start; /blog renders" }] };
    assert.deepEqual(await prodParityFailures({ rules: RULES, changedFiles: ["web/app/blog/page.tsx"], result, run }), []);
    const blank = { parity: [{ surface: "web/app/**", justification: " " }] };
    assert.equal((await prodParityFailures({ rules: RULES, changedFiles: ["web/app/blog/page.tsx"], result: blank, run })).length, 1);
  });
  it("untouched surfaces and no rules are silent; the command gets only matching paths", async () => {
    assert.deepEqual(await prodParityFailures({ rules: RULES, changedFiles: ["README.md"], result: {}, run }), []);
    assert.deepEqual(await prodParityFailures({ rules: [], changedFiles: [".env.production"], result: {}, run }), []);
    const f = await prodParityFailures({ rules: RULES, changedFiles: [".env.production", "README.md"], result: {}, run });
    assert.match(f[0].detail, /parity: \.env\.production\b/);
    assert.deepEqual(touchedSurfaces(RULES, ["README.md"]), []);
  });
  it("a command that cannot run is reported, not swallowed", async () => {
    const f = await prodParityFailures({ rules: parseProdParity({ "a/**": "x" }), changedFiles: ["a/b"], result: {}, run: async () => { throw new Error("boom"); } });
    assert.equal(f[0].kind, "prod_parity_failed");
    assert.match(f[0].detail, /exited 127/);
  });
  it("forge.yaml topology.prod_parity is read; repos without it get no key", () => {
    const withKey = tmpDir("pp-yaml-"), without = tmpDir("pp-yaml-");
    writeFileSync(join(withKey, "forge.yaml"), "topology:\n  prod_parity:\n    \"db/migrations/**\": \"bash scripts/check-role.sh\"\n    \".env.production\": \"note: confirm service env scope\"\n");
    writeFileSync(join(without, "forge.yaml"), "project: x/y\n");
    assert.deepEqual(parseProdParity(readEnvConfig(withKey).prodParity).map((r) => r.glob), ["db/migrations/**", ".env.production"]);
    assert.equal("prodParity" in readEnvConfig(without), false);
  });
});
