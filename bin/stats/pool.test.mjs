// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { poolUtilisation, formatPoolLines } from "./pool.mjs";
import { parseArgs } from "./index.mjs";

const NOW = Date.parse("2026-10-24T00:00:00Z"), DAY = 86400000;
function batch(root, id, created, rows, repo = "o/r") {
  const d = join(root, id); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "plan.json"), JSON.stringify({ repo, created: new Date(created).toISOString() }));
  writeFileSync(join(d, "report.json"), JSON.stringify({ rows }));
}
const sbx = (issue, by) => ({ issue, outcome: "merged", sandbox: { minutes: Object.values(by).reduce((a, b) => a + b, 0), by_agent: by } });

test("poolUtilisation sums minutes, lanes and share per agent per window", () => {
  const root = tmpDir("pool-stats-");
  batch(root, "b1", NOW - 2 * DAY, [sbx(1, { legion: 30 }), sbx(2, { legion: 10, box2: 10 }), { issue: 3, outcome: "merged" }]);
  batch(root, "b2", NOW - 20 * DAY, [sbx(4, { box2: 50 })]);
  batch(root, "b3", NOW - DAY, [sbx(9, { other: 99 })], "x/y");
  const w = poolUtilisation({ batchRoot: root, repo: "o/r", windows: [7 * DAY, 30 * DAY], now: NOW });
  assert.equal(w["7d"].remote_lanes, 2);
  assert.deepEqual(w["7d"].agents.legion, { minutes: 40, lanes: 2, share: 0.8 });
  assert.equal(w["30d"].agents.box2.minutes, 60);
  assert.equal(w["30d"].agents.other, undefined);
  assert.match(formatPoolLines(w).join("\n"), /legion: 40\.0 min, 2 lanes, 80% of pool/);
});

test("poolUtilisation with no agent data prints n/a; --window works with --pool", () => {
  const root = tmpDir("pool-stats-");
  batch(root, "b1", NOW - DAY, [{ issue: 1, outcome: "merged", sandbox: { minutes: 3 } }]);
  const w = poolUtilisation({ batchRoot: root, repo: "o/r", windows: [7 * DAY], now: NOW });
  assert.match(formatPoolLines(w).join("\n"), /per-agent minutes: n\/a/);
  assert.equal(poolUtilisation({ batchRoot: join(root, "none"), windows: [DAY], now: NOW })["1d"].batches, 0);
  assert.equal(parseArgs(["--pool", "--window", "7d"]).pool, true);
});
