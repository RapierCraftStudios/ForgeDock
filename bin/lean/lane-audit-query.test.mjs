import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAudits, summarizeActive, highestVersion } from "./lane-audit-query.mjs";
import { auditsFromCli } from "../engine-cli.mjs";
import { renderAudit } from "./lane-audit.mjs";

const mk = (issue, signature, v, extra = {}) => ({ key: `${issue}:0:${signature}`, issue, signature, class: "pipeline", active: true, fixed_in_later: false, status: "proposed", stamp: { engine_version: v }, ...extra });
const A = [
  mk(1, "s1", "1.2.0"), mk(2, "s1", "1.2.0"), mk(3, "s2", "1.2.0", { class: "env" }),
  mk(4, "s1", "1.2.0", { active: false, fixed_in_later: true }), mk(5, "s1", "1.1.0"),
];

test("filters", () => {
  assert.equal(filterAudits(A, { version: "1.1.0" }).length, 1);
  assert.equal(filterAudits(A, { sinceVersion: "1.2.0" }).length, 4);
  assert.equal(filterAudits(A, { signature: "s2" }).length, 1);
  assert.equal(filterAudits(A, { class: "env" })[0].issue, 3);
});

test("active summary excludes fixed_in_later and older versions", () => {
  assert.equal(highestVersion(A), "1.2.0");
  assert.deepEqual(summarizeActive(A), [
    { signature: "s1", class: "pipeline", count: 2, lanes: [1, 2] },
    { signature: "s2", class: "env", count: 1, lanes: [3] },
  ]);
  assert.equal(summarizeActive(A, { currentVersion: "1.1.0" })[0].lanes[0], 5);
});

const cm = (a, o = {}) => JSON.stringify({ body: `<!-- FORGE:LANE_AUDIT -->\n${renderAudit(a)}`, user: { login: "bot", type: "Bot" }, author_association: "OWNER", issue_url: `https://api.github.com/repos/o/r/issues/${a.issue}`, ...o });

test("auditsFromCli: json, active, skips malformed and untrusted", async () => {
  const lines = [...A.map((a) => cm(a)), "not json", cm(mk(9, "s1", "9.9.9"), { author_association: "NONE", user: { login: "rando", type: "User" } }), JSON.stringify({ body: "<!-- FORGE:LANE_AUDIT -->\nno json", author_association: "OWNER" })].join("\n");
  const exec = async () => lines;
  const logs = [];
  const orig = console.log; console.log = (s) => logs.push(s);
  try {
    const r = await auditsFromCli(["--repo", "o/r", "--active", "--json"], { exec });
    assert.deepEqual(r.rows.map((g) => [g.signature, g.count]), [["s1", 2], ["s2", 1]]);
    assert.deepEqual(JSON.parse(logs[0])[0].lanes, [1, 2]);
    const r2 = await auditsFromCli(["--repo", "o/r", "--signature", "s1"], { exec });
    assert.equal(r2.rows.length, 4);
  } finally { console.log = orig; }
  await assert.rejects(() => auditsFromCli(["--bogus"], { exec }), /usage/);
});
