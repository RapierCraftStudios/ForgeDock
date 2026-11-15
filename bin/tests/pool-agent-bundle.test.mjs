// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// The router ships pool agents only AGENT_BUNDLE_PATHS. In 1.61.0 bin/pool/ci-events.mjs statically imported
// ../lean/ci-classify.mjs, which the bundle does not carry, so the self-updated agent crash-looped on import.
// This test unpacks exactly the bundle paths into an empty directory and loads the agent's systemd entry point there.
import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AGENT_BUNDLE_PATHS } from "../pool/router.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("pool agent bundle", () => {
  it("names only paths that exist in the package", () => {
    for (const p of AGENT_BUNDLE_PATHS) assert.ok(existsSync(join(ROOT, p)), `bundle path missing: ${p}`);
  });

  it("the agent entry point (cli.mjs) and its modules load from the bundle alone", () => {
    const dir = tmpDir("pool-agent-bundle-");
    mkdirSync(dir, { recursive: true });
    for (const p of AGENT_BUNDLE_PATHS) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
    const entries = ["bin/pool/cli.mjs", "bin/pool/agent.mjs", "bin/pool/router.mjs", "bin/pool/ci-events.mjs"];
    const code = `for (const m of ${JSON.stringify(entries)}) await import("./" + m);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `bundle import failed:\n${r.stderr}`);
  });
});
