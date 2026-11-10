// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTimeline, buildFrames, readOnlyGh, resolveTarget, replayFromCli, writeOutput, MIN_SECONDS, MAX_SECONDS, FPS } from "../replay-timelapse.mjs";

const ev = (type, issue, ts, extra = {}) => JSON.stringify({ schema: "forgedock.event", v: 1, type, ts, issue, pr: extra.pr ?? null, ...(extra.cost_usd != null ? { cost_usd: extra.cost_usd } : {}), data: {} });
const LINES = [
  ev("lane.picked_up", 2, "2026-01-01T00:10:00Z"), ev("lane.picked_up", 1, "2026-01-01T00:00:00Z"), ev("pr.opened", 1, "2026-01-01T00:20:00Z", { pr: 11 }),
  ev("pr.merged", 1, "2026-01-01T00:30:00Z", { pr: 11, cost_usd: 1.5 }), ev("pr.merged", 2, "2026-01-01T01:00:00Z", { pr: 12, cost_usd: 2 }),
  ev("release.promoted", 2, "2026-01-01T01:10:00Z"), ev("pr.merged", 99, "2026-01-01T02:00:00Z", { cost_usd: 50 }), "not json",
];
const tmp = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "replay-"));

test("timeline is ordered, scoped to the issues, one 'issue' item each", () => {
  const items = buildTimeline(LINES, [1, 2]);
  assert.deepEqual(items.map((i) => i.t), [...items.map((i) => i.t)].sort((a, b) => a - b));
  assert.equal(items.filter((i) => i.kind === "issue").length, 2);
  assert.ok(!items.some((i) => i.issue === 99));
});

test("duration is clamped to 30-90 s whether the run was a minute or a month", () => {
  const items = buildTimeline(LINES, [1, 2]);
  assert.equal(buildFrames(items, { seconds: 5 }).length, MIN_SECONDS * FPS);
  assert.equal(buildFrames(items, { seconds: 1000 }).length, MAX_SECONDS * FPS);
  const long = [{ t: 0, kind: "issue", issue: 1 }, { t: 30 * 864e5, kind: "pr_merged", issue: 1, cost: 1 }];
  assert.equal(buildFrames(long).length, 60 * FPS);
});

test("running cost never decreases and ends at the total; gate shows at the end", () => {
  const frames = buildFrames(buildTimeline(LINES, [1, 2]));
  const costs = frames.map((f) => Number(/cost \$([\d.]+)/.exec(f)[1]));
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  assert.equal(costs.at(-1), 3.5);
  assert.match(frames[0], /gate pending/);
  assert.match(frames.at(-1), /gate PASSED/);
  assert.match(frames.at(-1), /merged 2\/2/);
});

test("readOnlyGh refuses writes and allows reads", () => {
  const gh = readOnlyGh(() => "{}");
  assert.equal(gh(["issue", "view", "1", "--json", "body"]), "{}");
  assert.equal(gh(["api", "repos/o/r/issues/1"]), "{}");
  for (const w of [["issue", "comment", "1"], ["pr", "merge", "2"], ["api", "x", "-X", "POST"], ["api", "x", "-f", "a=b"], ["issue", "edit", "1"]]) assert.throws(() => gh(w), /read-only/);
});

test("epic render: children from body, frames written, no gh write, encoder missing prints command", async () => {
  const dir = tmp(), calls = [];
  const file = join(dir, "e.jsonl");
  writeFileSync(file, LINES.join("\n"));
  const logs = [];
  const gh = (args) => { calls.push(args.join(" ")); return JSON.stringify({ body: "- [ ] #1\n- [ ] #2\nsee #7" }); };
  const code = await replayFromCli(["--timelapse", "#5", "--repo", "o/r", "--events", file, "--out", join(dir, "out")], { gh, root: join(dir, "none"), log: (s) => logs.push(s), spawn: () => ({ status: 1 }), cwd: dir });
  assert.equal(code, 0);
  assert.ok(calls.length === 1 && calls[0].startsWith("issue view 5"));
  const frames = readdirSync(join(dir, "out", "frames"));
  assert.equal(frames.length, 60 * FPS);
  assert.ok(existsSync(join(dir, "out", "timelapse.tape")));
  assert.match(logs.join("\n"), /vhs timelapse\.tape/);
});

test("batch target resolves from plan.json without gh; encoder run is reported", async () => {
  const dir = tmp(), root = join(dir, "batches");
  mkdirSync(join(root, "b1"), { recursive: true });
  writeFileSync(join(root, "b1", "plan.json"), JSON.stringify({ repo: "o/r", issues: [1, { issue: 2 }], created: "2025-12-31T23:00:00Z" }));
  const t = await resolveTarget("b1", { root });
  assert.deepEqual(t.issues, [1, 2]);
  const file = join(dir, "e.jsonl");
  writeFileSync(file, LINES.join("\n"));
  const logs = [];
  await replayFromCli(["--timelapse", "b1", "--events", file, "--out", join(dir, "o"), "--format", "mp4", "--duration", "30"], { root, log: (s) => logs.push(s), spawn: () => ({ status: 0 }), gh: () => { throw new Error("no gh for batch"); } });
  assert.match(logs.join("\n"), /rendered .*timelapse\.mp4/);
  assert.match(readFileSync(join(dir, "o", "timelapse.tape"), "utf8"), /Output timelapse\.mp4/);
});

test("usage errors", async () => {
  await assert.rejects(replayFromCli([]), /usage/);
  await assert.rejects(replayFromCli(["--timelapse", "x", "--format", "avi"]), /gif or mp4/);
  const r = writeOutput(tmp(), ["a"], { spawn: () => ({ error: new Error("ENOENT") }) });
  assert.equal(r.encoded, false);
});
