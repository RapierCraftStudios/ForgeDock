// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// The deploy gate's marker scan (.github/workflows/gate-marker-check.yml, "Scan PR comments for gate markers"), run as
// the workflow runs it with a stub `gh`: a GATE_PASS counts only as the final staging-review verdict for the current
// head; the pre-dispatch open-finding pass and a pass for an earlier head leave the status pending; a failure without a
// head line still blocks; the newest counted marker wins.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";

const wf = readFileSync(new URL("../../.github/workflows/gate-marker-check.yml", import.meta.url), "utf8");

/** The `run: |` body of the named step, dedented. */
function stepScript(name) {
  const lines = wf.split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `step ${name} not found`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === "run: |");
  const indent = lines[run + 1].match(/^ */)[0].length;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.match(/^ */)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

const SCAN = stepScript("Scan PR comments for gate markers");
const HEAD = "a".repeat(40), OLD = "b".repeat(40), BOT = "forge-bot";
const at = (m) => `2026-10-31T12:${String(m).padStart(2, "0")}:00Z`;
const comment = (m, body, login = BOT) => ({ createdAt: at(m), author: { login }, body });
const preDispatchPass = (m) => comment(m, "<!-- FORGE:GATE_PASS -->\n## Deploy Gate: PASSED\n<!-- FORGE:GATE_PASS:TYPE=open-review-finding -->");
const finalMarker = (m, kind, head) => comment(m, `<!-- FORGE:GATE_${kind} -->\n## Staging review\n**Head**: \`${head}\`\n<!-- FORGE:GATE_${kind}:TYPE=staging-review|BUNDLE=1 2 -->`);

/** marker_found after scanning `comments` with the PR head at `head`. */
function scan(comments, head = HEAD) {
  const dir = tmpDir("gate-scan-");
  writeFileSync(join(dir, "comments.json"), JSON.stringify(comments));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nif [ "$1" = pr ]; then cat "${join(dir, "comments.json")}"; else echo '[]'; fi\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const out = join(dir, "out");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-e", "-c", SCAN], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: out, PR_NUMBER: "1", REPO: "o/r", TRUSTED_AUTHORS_RAW: `${BOT}, other`, HEAD_SHA: head },
  });
  assert.equal(r.status, 0, r.stderr);
  return /marker_found=(\w+)/.exec(readFileSync(out, "utf8"))?.[1];
}

describe("deploy gate marker scan", () => {
  it("the pre-dispatch open-finding pass alone leaves the gate pending", () => {
    assert.equal(scan([preDispatchPass(1)]), "none");
  });
  it("the final staging-review pass for the current head passes", () => {
    assert.equal(scan([preDispatchPass(1), finalMarker(40, "PASS", HEAD)]), "pass");
  });
  it("a pass for an earlier head does not cover commits pushed since", () => {
    assert.equal(scan([finalMarker(40, "PASS", OLD)]), "none");
  });
  it("an untrusted author's pass does not count", () => {
    assert.equal(scan([comment(40, finalMarker(40, "PASS", HEAD).body, "someone")]), "none");
  });
  it("a failure without a head line blocks (pre-dispatch open-finding gate)", () => {
    assert.equal(scan([comment(1, "<!-- FORGE:GATE_FAILURE -->\n<!-- FORGE:GATE_FAILURE:TYPE=open-review-finding -->")]), "failure");
  });
  it("a failure for an earlier head is superseded by the push; a failure for this head blocks", () => {
    assert.equal(scan([finalMarker(20, "FAILURE", OLD)]), "none");
    assert.equal(scan([finalMarker(20, "FAILURE", HEAD)]), "failure");
  });
  it("the newest counted marker wins", () => {
    assert.equal(scan([finalMarker(20, "FAILURE", HEAD), finalMarker(50, "PASS", HEAD)]), "pass");
    assert.equal(scan([finalMarker(20, "PASS", HEAD), finalMarker(50, "FAILURE", HEAD)]), "failure");
  });
});
