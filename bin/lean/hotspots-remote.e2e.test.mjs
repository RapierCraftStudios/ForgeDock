// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Remote lanes use the batch-pinned config for hotspot facts (#5193, deferred from #5163). No mocks: the pinned forge.yaml is
// materialised by the real pool/image/entrypoint.sh snippet, then the real io.hotspots runs the real scripts/hotspots.sh in a
// real git repo. Skipped when yq (which hotspots.sh needs to read forge.yaml) or jq is missing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { makeLeanIo } from "./effects.mjs";

const has = (bin) => { try { execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10000 }); return true; } catch { return false; } };
const skip = !has("yq") ? "yq unavailable" : !has("jq") ? "jq unavailable" : false;
const ENTRYPOINT = fileURLToPath(new URL("../../pool/image/entrypoint.sh", import.meta.url));
const PINNED = "maintenance:\n  hotspot:\n    exclude_globs:\n      - \"web/public/openapi.json\"\n  generated_paths:\n    - \"gen/*.json\"\n";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd, stdio: "pipe" }).toString();
const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n") + "\n";

/** the real entrypoint block that writes the batch-pinned config into the lane checkout (pool/image/entrypoint.sh) */
function pinnedBlock() {
  const m = readFileSync(ENTRYPOINT, "utf8").match(/if \[ -n "\$\{CS_FORGE_YAML_B64:-\}" \]; then\n[\s\S]*?\nfi\n/);
  assert.ok(m, "entrypoint.sh no longer writes CS_FORGE_YAML_B64 to forge.yaml");
  return m[0];
}

function lane(root) {
  mkdirSync(join(root, "web/public"), { recursive: true });
  mkdirSync(join(root, "gen"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "web/public/openapi.json"), lines(2100));
  writeFileSync(join(root, "gen/api.json"), lines(2100));
  writeFileSync(join(root, ".gitignore"), "forge.yaml\n"); // the supported layout: forge.yaml is untracked
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "lane");
  writeFileSync(join(root, "web/public/openapi.json"), lines(2446));
  writeFileSync(join(root, "gen/api.json"), lines(2446));
  git(root, "add", "-A"); git(root, "commit", "-qm", "grow");
}

describe("remote lane hotspot facts use the pinned config (#5193)", { skip }, () => {
  const io = makeLeanIo({ repo: "o/r" });
  const paths = ["web/public/openapi.json", "gen/api.json"];

  it("honours exclude_globs and generated_paths from the pinned forge.yaml the entrypoint writes", async () => {
    const root = tmpDir("hotspots-remote-");
    lane(root);
    execFileSync("bash", ["-c", pinnedBlock()], { cwd: root, env: { ...process.env, CS_FORGE_YAML_B64: Buffer.from(PINNED).toString("base64") } });
    assert.equal(readFileSync(join(root, "forge.yaml"), "utf8"), PINNED);
    const h = await io.hotspots({ cwd: root, base: "main", paths });
    assert.ok(h, "io.hotspots returned null");
    assert.deepEqual(h.generated_paths, ["gen/*.json"]);
    const by = Object.fromEntries(h.files.map((f) => [f.path, f]));
    assert.equal(by["web/public/openapi.json"].growth, 346);
    assert.equal(by["web/public/openapi.json"].excluded, true);
    assert.equal(by["gen/api.json"].generated, true);
    assert.equal(by["gen/api.json"].excluded, true);
  });

  it("control: without the pinned config the same files are not excluded (the defect this guards)", async () => {
    const root = tmpDir("hotspots-remote-ctl-");
    lane(root);
    const h = await io.hotspots({ cwd: root, base: "main", paths });
    const by = Object.fromEntries(h.files.map((f) => [f.path, f]));
    assert.equal(by["web/public/openapi.json"].excluded, false);
    assert.equal(by["gen/api.json"].excluded, false);
  });
});
