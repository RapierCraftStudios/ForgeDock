// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Workflow-state consumer parity: every workflow:* state registered in labels.json must
// match transition-label.sh VALID_STATES, and every hard-coded in-flight/gated consumer
// list must name each non-terminal "work pending" state (forge#3564).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// Engine-managed terminal marker set by the engine itself, never via transition-label.sh.
const ENGINE_ONLY = new Set(["engine-error"]);

function labelsJsonStates() {
  const data = JSON.parse(read("bin/labels.json"));
  const list = Array.isArray(data) ? data : data.labels;
  return list
    .map((l) => l.name)
    .filter((n) => n.startsWith("workflow:"))
    .map((n) => n.slice("workflow:".length))
    .filter((n) => !ENGINE_ONLY.has(n))
    .sort();
}

function validStates() {
  const m = read("scripts/transition-label.sh").match(/VALID_STATES=\(([^)]*)\)/);
  assert.ok(m, "VALID_STATES array not found in transition-label.sh");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

describe("workflow state registries", () => {
  it("labels.json workflow:* names equal transition-label.sh VALID_STATES", () => {
    assert.deepEqual(labelsJsonStates(), validStates());
  });
});

// Consumers that skip or enumerate in-flight work; each must name workflow:remediating.
const REMEDIATING_CONSUMERS = [
  "bin/orchestrate-preflight.mjs",
  "scripts/select-fix-targets.sh",
  "commands/orchestrate/phase-1-resolve.md",
  "commands/orchestrate/safety.md",
  "commands/autopilot.md",
  "commands/pipeline-status.md",
  "commands/pipeline-resume.md",
  "commands/cleanup.md",
  "scripts/forge-run.sh",
  "scripts/doctor-pipeline-state.sh",
  "bin/opencode-adapter.mjs",
];

describe("workflow:remediating consumer parity", () => {
  it("is a registered state", () => {
    assert.ok(validStates().includes("remediating"));
    assert.ok(labelsJsonStates().includes("remediating"));
  });

  for (const file of REMEDIATING_CONSUMERS) {
    it(`${file} names workflow:remediating`, () => {
      assert.ok(read(file).includes("workflow:remediating"), `${file} does not list workflow:remediating`);
    });
  }

  it("select-fix-targets.sh excludes remediating and awaiting-merge in both live and fixture filters", () => {
    const src = read("scripts/select-fix-targets.sh");
    for (const label of ["workflow:remediating", "workflow:awaiting-merge"]) {
      const n = src.split(`. == "${label}"`).length - 1;
      assert.ok(n >= 2, `expected >=2 jq exclusions for ${label}, found ${n}`);
    }
  });

  it("every autopilot dispatch selector excludes workflow:remediating", () => {
    const sel = read("commands/autopilot.md").split("\n").filter((l) => l.includes('. == "needs-human"') && l.includes("map(.name)"));
    assert.ok(sel.length >= 4, `expected >=4 autopilot selectors, found ${sel.length}`);
    for (const l of sel) assert.ok(l.includes('. == "workflow:remediating"'), `selector lacks workflow:remediating: ${l.trim()}`);
  });

  it("select-fix-targets.sh --fixture-test passes (remediating P0 fixture excluded)", () => {
    const r = spawnSync("bash", [join(ROOT, "scripts/select-fix-targets.sh"), "--fixture-test"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /107 \(workflow:remediating\)/);
  });
});
