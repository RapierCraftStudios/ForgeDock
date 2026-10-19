// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Container sandbox end to end (#4253): a real `docker run` of a stub lane. Skipped unless docker answers and the image
// (FORGEDOCK_E2E_IMAGE, default node:22.23.0-bookworm-slim) is already local; it never pulls.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { containerProvider, providerLanes, runDocker } from "./execution.mjs";
import { makeLedger } from "./ledger.mjs";
import { openBatch } from "./batch.mjs";
import { planGc, applyGc } from "../gc.mjs";

const IMAGE = process.env.FORGEDOCK_E2E_IMAGE || "node:22.23.0-bookworm-slim";
const has = (args) => { try { execFileSync("docker", args, { stdio: "ignore", timeout: 20000 }); return true; } catch { return false; } };
const skip = !has(["version"]) ? "docker unavailable" : !has(["image", "inspect", IMAGE]) ? `image ${IMAGE} not local (never pulled)` : false;
const LABELS = String(process.env.FORGE_DOCKER_LABELS ?? "").split(/\s+/).filter(Boolean);
const exists = (name) => has(["inspect", name]);
const names = new Set();
after(() => { for (const n of names) try { execFileSync("docker", ["rm", "-f", n], { stdio: "ignore" }); } catch { /* gone */ } });

describe("container provider e2e (#4253)", { skip }, () => {
  const work = tmpDir("exec-e2e-");
  const stubDir = join(work, "stub");
  mkdirSync(stubDir);
  // Stub lane: argv `<issue> --result-file <rf>`; issue 1 merges, 2 fails, 3 hangs (a lane whose dispatcher dies).
  writeFileSync(join(stubDir, "lane.mjs"), `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2); const n = Number(a[0]); const rf = a[a.indexOf("--result-file") + 1];
console.log("lane", n, "in", process.cwd(), "GH_REPO", process.env.GH_REPO, "leak", process.env.FD_E2E_LEAK ?? "none");
if (n === 3) setInterval(() => {}, 1000);
else writeFileSync(rf, JSON.stringify(n === 1 ? { terminalReason: "merged", pr: 41 } : { terminalReason: "needs-human", detail: "stub failure" }));
`);
  const batch = openBatch(join(work, "batches"), `e2e-${process.pid}`);
  const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const provider = containerProvider({ batch, repo: "o/r", image: IMAGE, gitDir, cacheDir: join(work, "cache"), labels: LABELS, mounts: [`${stubDir}:/stub:ro`],
    command: (issue, _args, rf) => ["node", "/stub/lane.mjs", String(issue), "--result-file", rf] });
  const root = join(work, "ledger");
  const ledgerFor = (n, pid = process.pid) => makeLedger({ root, batch: batch.id, lane: `sandbox-${n}`, owner: "e2e", issue: n, pid });
  const lanes = providerLanes({ provider, laneArgs: () => [], ledgerFor: (n) => ledgerFor(n), pollMs: 200, env: { FD_E2E_LEAK: "x" }, secrets: [] });

  it("success: the lane runs in the container, its result reaches the batch, the sandbox is gone", async () => {
    names.add(provider.idFor(1));
    const r = await lanes.runOne(1, null);
    assert.deepEqual(r, { terminalReason: "merged", pr: 41 });
    assert.equal(exists(provider.idFor(1)), false);
    assert.equal(ledgerFor(1).read(), null);
  });

  it("failure: the failure result reaches the batch and the sandbox is torn down", async () => {
    names.add(provider.idFor(2));
    const r = await lanes.runOne(2, null);
    assert.equal(r.terminalReason, "needs-human");
    assert.equal(exists(provider.idFor(2)), false);
    assert.equal(ledgerFor(2).read(), null);
  });

  it("runner kill: a sandbox whose dispatcher died stays in the ledger and gc --apply removes it", async () => {
    const id = provider.idFor(3);
    names.add(id);
    const dead = ledgerFor(3, 2 ** 22 + 12345); // a pid that is not running
    dead.register("sandbox", id, { provider: "container", handle: { provider: "container", id, issue: 3 } });
    await provider.start({ issue: 3, args: [], env: {}, secrets: [] });
    assert.equal(await provider.status({ id }), "running");
    const home = join(work, "home");
    mkdirSync(join(home, "tmp"), { recursive: true });
    const probes = { cwd: work, host: dead.read().host, ledgerRoot: root, forgeTmpRoot: join(home, "tmp"), worktreeRoot: join(work, "wt"),
      alive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, ppid: () => 0, procsInDir: () => [],
      docker: (args) => runDocker(args), git: async () => "", gh: async () => "[]" };
    const plan = await planGc({ probes, scopes: new Set(["sandboxes"]) });
    assert.deepEqual(plan.items.map((i) => [i.type, i.id, i.action]), [["sandbox", id, "reclaim"]]);
    const res = await applyGc(plan, probes);
    assert.deepEqual(res.failed, []);
    assert.equal(exists(id), false);
    assert.equal(existsSync(dead.path), false);
  });
});
