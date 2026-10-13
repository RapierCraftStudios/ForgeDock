// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#3567: workflow-label writes must survive a repo that never ran `forgedock labels setup`
// (so `workflow:remediating` and friends do not exist). `gh issue edit` is atomic across its
// label arguments, so a missing label cancels the whole edit.
import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * Stub gh with a fake repo. `repo` = labels existing on the repo, `issue` = labels on the issue.
 * `issue edit` fails (exit 1, nothing applied) when any --add-label/--remove-label names a label
 * absent from the repo, like the real CLI. `label create` registers the label unless FAIL_CREATE.
 */
function runTransition(target, { repo = [], issue = [], failCreate = false } = {}) {
  const dir = tmpDir("forge-label-bootstrap-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "repo"), repo.join("\n") + "\n");
  writeFileSync(join(dir, "issue"), issue.join("\n") + "\n");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
echo "$*" >> "${log}"
R="${dir}/repo"; I="${dir}/issue"
case "$1 $2" in
  "label create")
    [ -n "${failCreate ? "1" : ""}" ] && exit 1
    grep -qxF -- "$3" "$R" || echo "$3" >> "$R"; exit 0 ;;
  "issue view")
    case "$*" in *"--json labels"*) grep -v '^$' "$I" | paste -sd, - ; exit 0 ;; esac
    exit 0 ;;
  "issue edit")
    args=("$@"); adds=(); rems=()
    for ((i=0;i<\${#args[@]};i++)); do
      case "\${args[i]}" in
        --add-label) IFS=, read -ra a <<< "\${args[i+1]}"; adds+=("\${a[@]}") ;;
        --remove-label) IFS=, read -ra a <<< "\${args[i+1]}"; rems+=("\${a[@]}") ;;
      esac
    done
    for l in "\${adds[@]}" "\${rems[@]}"; do
      grep -qxF -- "$l" "$R" || { echo "failed to update: '$l' not found" >&2; exit 1; }
    done
    for l in "\${adds[@]}"; do echo "$l" >> "$I"; done
    for l in "\${rems[@]}"; do grep -vxF -- "$l" "$I" > "$I.tmp"; mv "$I.tmp" "$I"; done
    exit 0 ;;
esac
exit 0
`);
  chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync("bash", [join(ROOT, "scripts/transition-label.sh"), "42", "-R", "o/r", target], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FORGE_LABEL_MAP: "" },
    encoding: "utf8" });
  const lines = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
  return { r, repo: lines("repo"), issue: lines("issue"), calls: lines("calls.log") };
}

describe("forge#3567 transition-label.sh ensures the target label", () => {
  it("e1: missing workflow:remediating is created, then the add succeeds", () => {
    const { r, repo, issue } = runTransition("remediating", { repo: ["workflow:in-review"], issue: ["workflow:in-review"] });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(repo.includes("workflow:remediating"));
    assert.ok(issue.includes("workflow:remediating"));
    assert.ok(!issue.includes("workflow:in-review"), "stale state removed");
  });

  it("e3: label already on the repo: ensure is harmless", () => {
    const { r, issue } = runTransition("remediating", { repo: ["workflow:remediating"], issue: [] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(issue, ["workflow:remediating"]);
  });

  it("e5: re-running the ensure (concurrent create race) is idempotent", () => {
    const a = runTransition("remediating", { repo: ["workflow:remediating"] });
    const b = runTransition("remediating", {});
    assert.equal(a.r.status, 0);
    assert.equal(b.r.status, 0);
  });

  it("e2: a failing `gh label create` is ignored; the add surfaces its own error", () => {
    const { r, calls } = runTransition("remediating", { failCreate: true });
    assert.notEqual(r.status, 0, "add fails because the label is still missing");
    assert.ok(calls.some((c) => c.startsWith("label create workflow:remediating")));
    assert.ok(calls.some((c) => c.startsWith("issue edit") && c.includes("--add-label workflow:remediating")));
  });

  it("an unmanaged custom label name is never created", () => {
    const dir = tmpDir("forge-label-bootstrap-map-");
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/calls.log"\ncase "$*" in *"--json labels"*) echo "";; esac\nexit 0\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const r = spawnSync("bash", [join(ROOT, "scripts/transition-label.sh"), "42", "-R", "o/r", "building"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FORGE_LABEL_MAP: '{"workflow:building":"team:wip"}' },
      encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(dir, "calls.log"), "utf8");
    assert.ok(!/label create team:wip/.test(calls));
    assert.ok(/--add-label team:wip/.test(calls));
  });

  it("the built-in ensure table matches bin/labels.json for every workflow:* label and needs-human", () => {
    const sh = read("scripts/transition-label.sh");
    const labels = JSON.parse(read("bin/labels.json")).filter((l) => l.name.startsWith("workflow:") || l.name === "needs-human");
    assert.ok(labels.length > 0);
    for (const l of labels) {
      assert.ok(
        sh.includes(`"${l.name}") LBL_COLOR="${l.color}"; LBL_DESC="${l.description}" ;;`),
        `ensure_label table drifted from labels.json for ${l.name}`);
    }
  });
});

describe("forge#3567 spec call sites never combine a possibly-missing label in one atomic edit", () => {
  const rem = read("commands/work-on/remediate.md");
  const rev = read("commands/work-on/review.md");

  it("e4: remediate.md ensures needs-human, adds it, and removes workflow:remediating as separate edits", () => {
    assert.ok(rem.includes("label create"));
    assert.ok(!/--add-label "needs-human" --remove-label "workflow:remediating"/.test(rem));
    const i = rem.indexOf('gh label create "needs-human"');
    assert.ok(i >= 0, "needs-human ensured");
    const tail = rem.slice(i, i + 900);
    assert.ok(tail.indexOf('--add-label "needs-human"') < tail.indexOf('--remove-label "workflow:remediating"'), "add before remove");
  });

  it("review.md and remediate.md ensure the labels they swap in", () => {
    assert.match(rev, /gh label create "workflow:remediating"/);
    assert.match(rev, /gh label create "workflow:in-review"/);
    assert.match(rem, /gh label create "workflow:in-review"/);
    assert.match(rem, /gh label create "workflow:remediating"/);
  });

  it("no in-review swap combines add and remove in one gh issue edit", () => {
    for (const [name, t] of [["remediate.md", rem], ["review.md", rev]]) {
      for (const line of t.split("\n")) {
        if (!/gh issue edit/.test(line) || !/--add-label "workflow:in-review"/.test(line)) continue;
        assert.ok(!/--remove-label/.test(line), `${name}: add and remove combined: ${line.trim().slice(0, 120)}`);
      }
      assert.ok(!/--remove-label "needs-human,workflow:remediating"/.test(t), `${name}: combined remove list`);
    }
  });
});
