// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// forge#4174: /forgedock-init provisions a Projects v2 board (create/link + ForgeDock fields), flags a
// missing read:project/project scope with the exact `gh auth refresh` command, and bootstraps domain
// labels via `npx forgedock labels setup --domain` on top of bin/labels.json.
import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const MANIFEST = JSON.parse(read("bin/labels.json"));

/** Run `forgedock labels ...` with a stub gh that logs one `label create` per line. */
function runLabels(args) {
  const dir = tmpDir("forge-domain-labels-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\nprintf '%s\\t' "$@" >> "${log}"\necho >> "${log}"\nexit 0\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const r = spawnSync(process.execPath, [join(ROOT, "bin/forgedock.mjs"), "labels", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NO_COLOR: "1" },
    encoding: "utf8",
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t").filter((x) => x !== ""))
    : [];
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

const created = (calls) => calls.filter((c) => c[0] === "label" && c[1] === "create").map((c) => c[2]);
const callFor = (calls, name) => calls.find((c) => c[1] === "create" && c[2] === name);

describe("labels setup --domain", () => {
  it("creates the manifest plus each domain label once, with fixed colors and --force", () => {
    const { status, calls } = runLabels(["setup", "--repo", "o/r", "--domain", "frontend, backend,frontend,priority:P0,ml"]);
    assert.equal(status, 0);
    const names = created(calls);
    for (const l of MANIFEST) assert.ok(names.includes(l.name), `manifest label ${l.name} missing`);
    assert.equal(names.filter((n) => n === "frontend").length, 1);
    assert.equal(names.filter((n) => n === "backend").length, 1);
    assert.equal(names.filter((n) => n === "priority:P0").length, 1, "manifest name must not be duplicated");
    assert.equal(names.length, MANIFEST.length + 3);
    const fe = callFor(calls, "frontend");
    assert.deepEqual(fe.slice(3), ["--color", "1D76DB", "--description", "Domain: frontend. Managed by ForgeDock.", "--force", "--repo", "o/r"]);
    assert.equal(callFor(calls, "backend")[4], "0E8A16");
    assert.equal(callFor(calls, "ml")[4], "EDEDED");
  });

  it("rejects an empty or over-long name before any gh call", () => {
    for (const bad of ["a,,", "x".repeat(51), "--repo"]) {
      const { status, calls } = runLabels(["setup", "--domain", bad, "--repo", "o/r"]);
      assert.equal(status, 1, bad);
      assert.equal(calls.length, 0, `gh called for ${bad}`);
    }
  });

  it("without --domain creates exactly the bin/labels.json set", () => {
    const { status, calls } = runLabels(["setup", "--repo", "o/r"]);
    assert.equal(status, 0);
    assert.deepEqual(created(calls), MANIFEST.map((l) => l.name));
  });
});

describe("commands/forgedock-init.md board + labels provisioning", () => {
  const spec = read("commands/forgedock-init.md");
  it("prints the exact gh auth refresh command on a missing project scope", () => {
    assert.match(spec, /gh auth refresh -h github\.com -s read:project,project/);
    assert.match(spec, /BOARD_SCOPE_MISSING/);
  });
  it("creates or links the board and ensures every ForgeDock field", () => {
    for (const s of ["gh project create", "gh project link", "gh project field-create"]) assert.ok(spec.includes(s), s);
    for (const f of ["Lane", "Priority", "Workflow", "Component"]) assert.match(spec, new RegExp(`^${f}\\|`, "m"));
    assert.doesNotMatch(spec, /ensure_field\(\)/, "no positional-arg helper in a Skill-loaded spec");
    assert.match(spec, /Status` is built into every Projects v2 board/);
    assert.doesNotMatch(spec, /Zero project boards found AND `INTERACTIVE=false` → skip this section silently/);
  });
  it("bootstraps labels with domain labels", () => {
    assert.match(spec, /--domain-labels/);
    assert.match(spec, /npx forgedock labels setup --repo "\$\{OWNER\}\/\$\{REPO\}" --domain "\$DOMAIN_LABELS"/);
    assert.match(spec, /ALLOWED_SECTIONS="repos project_board services review verification labels"/);
    for (const d of ["frontend", "backend", "infra", "design", "legal-gated"]) assert.ok(spec.includes(`→ \`${d}\``), d);
  });
});
