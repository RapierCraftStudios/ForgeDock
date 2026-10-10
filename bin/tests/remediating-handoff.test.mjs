// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#3541: autonomous remediation handoffs (ci-gate, in-pr-fix, base-sync) use the
// non-human `workflow:remediating` state, never `needs-human`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const review = read("commands/work-on/review.md");

/** The bullet of review.md R4 that starts with `marker` (up to the next top-level bullet). */
function bullet(marker) {
  const start = review.indexOf(marker);
  assert.ok(start >= 0, `review.md has no bullet starting ${marker}`);
  const next = review.indexOf("\n- ", start + marker.length);
  return review.slice(start, next < 0 ? undefined : next);
}
/** The "Bound unused" sub-bullet of a handoff bullet (up to "Bound already used"). */
function boundUnused(b) {
  const s = b.indexOf("**Bound unused**");
  assert.ok(s >= 0, "no Bound unused branch");
  const e = b.indexOf("**Bound already used**", s);
  return b.slice(s, e < 0 ? undefined : e);
}

describe("forge#3541 review.md R4 handoffs", () => {
  const paths = {
    "ci-gate": bullet('- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "ci gate"'),
    "inpr-fix": bullet('- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "in-pr fix required"'),
    "base-sync": bullet('- `REVIEW_RESULT: status: BLOCKED` from /review-pr whose blocker contains "base-conflict"'),
  };

  for (const [kind, b] of Object.entries(paths)) {
    it(`${kind}: bound-unused branch hands off via the remediating state and never adds needs-human`, () => {
      const text = kind === "ci-gate" ? b : boundUnused(b);
      assert.match(text, /remediation-pending handoff/i);
      assert.ok(text.includes(`remediation: ${kind}`), "must return the remediation kind");
      assert.ok(!/add `needs-human`/.test(text), "bound-unused path must not add needs-human");
    });
  }

  it("the shared handoff block sets workflow:remediating and clears needs-human on issue and PR", () => {
    const blk = bullet("- **Remediation-pending handoff");
    assert.match(blk, /transition-label'/);
    assert.match(blk, /remediating/);
    assert.match(blk, /--add-label "workflow:remediating"/);
    assert.match(blk, /gh issue edit \{NUMBER\} \{GH_FLAG\} --remove-label "needs-human"/);
    assert.match(blk, /gh pr edit \{PR_NUMBER\} \{GH_FLAG\} --remove-label "needs-human"/);
    assert.ok(!/--add-label "needs-human"/.test(blk));
  });

  it("exhausted bounds (genuine human gate) still land at needs-human", () => {
    assert.match(paths["ci-gate"], /remove `workflow:remediating`, label the issue `needs-human`/);
    assert.match(paths["base-sync"], /label the issue `needs-human`/);
    assert.match(paths["inpr-fix"], /label the issue `needs-human`/);
  });
});

describe("forge#3541 consumers accept workflow:remediating", () => {
  it("labels.json registers the state", () => {
    const labels = JSON.parse(read("bin/labels.json"));
    assert.ok(labels.some((l) => l.name === "workflow:remediating"));
  });

  it("remediate.md M0 accepts either label and clears the state on exit", () => {
    const t = read("commands/work-on/remediate.md");
    assert.match(t, /neither `needs-human` nor `workflow:remediating`/);
    assert.match(t, /--remove-label "needs-human,workflow:remediating"/);
    assert.match(t, /Stranded-state rule/);
  });

  it("orchestrate classifies it IN_PROGRESS (not GATED) and item 6.4 dispatches on it", () => {
    const t = read("commands/orchestrate/phase-4-execution.md");
    const fn = t.slice(t.indexOf("classify_predecessor_state() {"));
    const arm = fn.indexOf('grep -qx "workflow:remediating"');
    assert.ok(arm > 0, "classifier has a remediating arm");
    assert.match(fn.slice(arm, arm + 900), /echo "IN_PROGRESS"/);
    assert.ok(fn.indexOf('grep -qxE "needs-human|workflow:awaiting-merge"') < arm, "needs-human still wins (GATED)");
    assert.match(t, /\[ "\$PRED_CURRENT_LABEL" = "workflow:remediating" \]/);
  });

  it("review-pr base-conflict comments say the pipeline performs the sync", () => {
    const t = read("commands/review-pr.md");
    const hits = t.match(/the pipeline is performing the base sync/g) || [];
    assert.ok(hits.length >= 2, "both base-conflict comments reworded");
  });
});

describe("forge#3541 transition-label.sh", () => {
  it("accepts `remediating` and removes the other workflow states", () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-3541-"));
    const log = join(dir, "calls.log");
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\necho "$@" >> "${log}"\ncase "$*" in *"--json labels"*) if [ -e "${dir}/seen" ]; then echo "workflow:remediating"; else touch "${dir}/seen"; echo "workflow:in-review"; fi ;; esac\nexit 0\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const r = spawnSync("bash", [join(ROOT, "scripts/transition-label.sh"), "42", "-R", "o/r", "remediating"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /--add-label workflow:remediating/);
    assert.match(calls, /--remove-label [^\n]*workflow:in-review/);
    assert.ok(!/--remove-label [^\n]*workflow:remediating/.test(calls));
  });
});
