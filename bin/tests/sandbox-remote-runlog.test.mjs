import { tmpDir } from "./_tmp.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendEvent, readLog, capLog, attachRunLog, mergeRemoteLog } from "../engine/runlog.mjs";
import { remoteProvider } from "../lean/sandbox-remote.mjs";
import { readLocalRuns } from "../stats/local-source.mjs";

const REPO = "o/r";
/** A lane-side run log (the sandbox's own runs dir) holding the setup events. */
function laneLog() {
  const dir = tmpDir("rl-lane-");
  appendEvent(dir, 7, { event: "RUN_START", repo: REPO }, { repo: REPO });
  appendEvent(dir, 7, { event: "DEPS_PREPARED", outcome: "hit", ms: 8900 }, { repo: REPO });
  appendEvent(dir, 7, { event: "LANE_SETUP_TIMING", ms: 1200 }, { repo: REPO });
  return dir;
}
function hostProvider(result) {
  const hostDir = tmpDir("rl-host-");
  const transport = { launch: async () => ({}), status: async () => "exited", logs: async () => ({ text: "", cursor: 0 }), result: async () => result, usage: async () => null, destroy: async () => true };
  const provider = remoteProvider({ batch: { id: "b1", logFile: () => join(tmpDir("rl-lanes-"), "x.log") }, repo: REPO, settings: {}, transport, env: { FORGE_RUNS_DIR: hostDir }, credentials: () => null, gitIdentity: () => ({}) });
  return { provider, hostDir };
}

describe("remote lane run log export (#5697)", () => {
  it("fetchResult merges the lane run log into the host run log", async () => {
    const result = attachRunLog({ terminalReason: "needs-human" }, { dir: laneLog(), issue: 7, repo: REPO });
    const { provider, hostDir } = hostProvider(result);
    const r = await provider.fetchResult({ id: "sb", issue: 7 });
    assert.equal(r.runLog, undefined);
    assert.equal(r.terminalReason, "needs-human");
    const names = readLog(hostDir, 7, { repo: REPO }).map((e) => e.event);
    assert.ok(names.includes("DEPS_PREPARED") && names.includes("LANE_SETUP_TIMING"));
  });

  it("re-collecting a run log does not duplicate events", async () => {
    const result = attachRunLog({ terminalReason: "merged" }, { dir: laneLog(), issue: 7, repo: REPO });
    const { provider, hostDir } = hostProvider(result);
    await provider.fetchResult({ id: "sb", issue: 7 });
    await provider.fetchResult({ id: "sb", issue: 7 });
    const log = readLog(hostDir, 7, { repo: REPO });
    assert.equal(log.length, 3);
    assert.deepEqual(log.map((e) => e.seq), [1, 2, 3]);
    assert.equal(mergeRemoteLog(hostDir, 7, result.runLog, { repo: REPO }), 0);
  });

  it("capLog truncates a log over 20 MB from the middle with a marker", () => {
    const line = (i) => JSON.stringify({ seq: i, event: "E", pad: "x".repeat(1000) });
    const text = Array.from({ length: 21 * 1024 }, (_, i) => line(i + 1)).join("\n") + "\n";
    assert.ok(Buffer.byteLength(text) > 20 * 1024 * 1024);
    const out = capLog(text);
    assert.ok(Buffer.byteLength(out) <= 20 * 1024 * 1024 + 1024);
    const events = out.trim().split("\n").map((l) => JSON.parse(l));
    const i = events.findIndex((e) => e.event === "LOG_TRUNCATED");
    assert.ok(i > 0 && i < events.length - 1);
    assert.equal(events[0].seq, 1);
    assert.equal(events.at(-1).seq, 21 * 1024);
  });

  it("readLocalRuns includes a merged remote lane", async () => {
    const result = attachRunLog({ terminalReason: "merged" }, { dir: laneLog(), issue: 7, repo: REPO });
    const { provider, hostDir } = hostProvider(result);
    await provider.fetchResult({ id: "sb", issue: 7 });
    const runs = readLocalRuns(hostDir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].issue, 7);
  });
});
