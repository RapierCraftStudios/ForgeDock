// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4410: tool calls per turn and re-reads of a builder session, from the runner's stream tool uses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readPaths, toolStats, REREAD_MIN } from "./toolstats.mjs";

const bash = (cmd, msg = "m") => ({ msg, name: "Bash", path: null, cmd });

describe("#4410 readPaths", () => {
  it("the Read tool's path, ./ stripped", () => {
    assert.deepEqual(readPaths({ name: "Read", path: "./src/a.js" }), ["src/a.js"]);
    assert.deepEqual(readPaths({ name: "Read", path: null }), []);
    assert.deepEqual(readPaths({ name: "Edit", path: "src/a.js" }), []);
  });
  it("cat / sed -n / head / tail operands of a Bash command; grep, wc, sed -i and globs are not reads", () => {
    assert.deepEqual(readPaths(bash("cat a.sh b.sh")), ["a.sh", "b.sh"]);
    assert.deepEqual(readPaths(bash("sed -n '30,60p' scripts/memory-alert.sh")), ["scripts/memory-alert.sh"]);
    assert.deepEqual(readPaths(bash("sed -n -e 1,2p x.js")), ["x.js"]);
    assert.deepEqual(readPaths(bash("head -n 5 f.txt; tail -40 g.log 2>/dev/null")), ["f.txt", "g.log"]);
    assert.deepEqual(readPaths(bash("grep -n A f1 f2; sed -n 1,2p b.js && wc -l c.js | head -3")), ["b.js"]);
    assert.deepEqual(readPaths(bash("sed -i 's/a/b/' x.js; cat src/*.js; cat <<EOF > out.txt")), []);
    assert.deepEqual(readPaths(bash("FOO=1 cat ./d.md")), ["d.md"]);
  });
});

describe("#4410 toolStats", () => {
  it("null on no tool uses", () => {
    assert.equal(toolStats([]), null); assert.equal(toolStats(null), null); assert.equal(toolStats(undefined), null);
  });
  it("counts calls, distinct-message turns, per_turn, and paths read 3+ times once each", () => {
    const uses = [
      bash("sed -n 1,30p hb.sh", "m1"), { msg: "m1", name: "Read", path: "hb.sh" }, bash("grep -n x hb.sh", "m1"),
      bash("sed -n 30,60p hb.sh", "m2"),
      bash("cat once.sh", "m3"), { msg: "m3", name: "Edit", path: "hb.sh" },
    ];
    const s = toolStats(uses);
    assert.equal(REREAD_MIN, 3);
    assert.equal(s.calls, 6); assert.equal(s.turns, 3); assert.equal(s.per_turn, 2);
    assert.equal(s.rereads, 1);
    assert.deepEqual(s.top, [{ path: "hb.sh", reads: 3 }]);
  });
  it("one call per turn is per_turn 1 and no re-reads under the threshold", () => {
    const s = toolStats([bash("cat a", "1"), bash("cat a", "2"), bash("cat b", "3")]);
    assert.deepEqual(s, { calls: 3, turns: 3, per_turn: 1, rereads: 0, top: [] });
  });
});
