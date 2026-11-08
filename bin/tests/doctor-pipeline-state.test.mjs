// scripts/doctor-pipeline-state.sh I4/I6 (#5255): lean lanes and lane/bot PRs are not findings.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpDir } from "./_tmp.mjs";

const SCRIPT = resolve(import.meta.dirname, "../../scripts/doctor-pipeline-state.sh");
let dir;

before(() => {
  dir = tmpDir("doctor-");
  // Fake gh: `issue list` -> GH_BUILDING for workflow:building else []; `issue view` -> GH_COMMENTS; `pr list` -> GH_PRS.
  writeFileSync(join(dir, "gh"), `#!/bin/bash
args="$*"
case "$1 $2" in
  "issue list") if [[ "$args" == *workflow:building* ]]; then echo "$GH_BUILDING"; else echo "[]"; fi ;;
  "issue view") while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && f="$2"; shift; done
                echo "{\\"comments\\":$GH_COMMENTS}" | jq -r "$f" ;;
  "pr list") echo "$GH_PRS" ;;
  *) echo "[]" ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
});

const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const run = (env) => {
  const r = spawnSync("bash", [SCRIPT, "--repo", "o/r", "--json"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_BUILDING: "[]", GH_COMMENTS: "[]", GH_PRS: "[]", ...env },
    encoding: "utf8",
    cwd: dir,
  });
  return JSON.parse(r.stdout).findings;
};
const building = (h) => JSON.stringify([{ number: 7, title: "t", updatedAt: ago(h), labels: [{ name: "workflow:building" }] }]);
const pr = (o) => ({ number: 1, title: "t", body: "", createdAt: ago(5), author: { login: "alice" }, headRefName: "my-branch", ...o });

describe("doctor-pipeline-state I4", () => {
  it("I4 lean lane with FORGE:CONTRACT produces no finding", () => {
    const f = run({ GH_BUILDING: building(60), GH_COMMENTS: JSON.stringify([{ body: "<!-- FORGE:CONTRACT -->" }]) });
    assert.equal(f.filter((x) => x.type === "missing_annotation").length, 0);
  });
  it("I4 young workflow:building issue produces no CRITICAL", () => {
    const f = run({ GH_BUILDING: building(0), GH_COMMENTS: "[]" });
    assert.equal(f.filter((x) => x.severity === "critical").length, 0);
  });
  it("I4 old building issue without evidence is still CRITICAL", () => {
    const f = run({ GH_BUILDING: building(60), GH_COMMENTS: "[]" });
    assert.ok(f.some((x) => x.type === "missing_annotation" && x.severity === "critical"));
  });
});

describe("doctor-pipeline-state I6", () => {
  const has = (f) => f.some((x) => x.type === "pr_missing_annotations");
  it("I6 lean head branch PR is skipped", () => {
    assert.equal(has(run({ GH_PRS: JSON.stringify([pr({ headRefName: "feat/issue-5-lean" })]) })), false);
  });
  it("I6 pipeline bot app PR is skipped", () => {
    assert.equal(has(run({ GH_PRS: JSON.stringify([pr({ author: { login: "app/rapiercraft-forgedock" } })]) })), false);
  });
  it("I6 dependabot PR is skipped", () => {
    assert.equal(has(run({ GH_PRS: JSON.stringify([pr({ author: { login: "app/dependabot" } })]) })), false);
  });
  it("I6 hand-made PR with no markers still warns", () => {
    assert.equal(has(run({ GH_PRS: JSON.stringify([pr({})]) })), true);
  });
});
