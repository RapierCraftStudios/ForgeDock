// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4782: `forgedock guide` and a help screen that fits the terminal, plain in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guideText, guideWidth, useAnsi, wrap } from "../guide.mjs";
import { table } from "../tui.mjs";

const CLI = fileURLToPath(new URL("../forgedock.mjs", import.meta.url));
const ESC = "\x1b";
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORGEDOCK_NO_UPDATE_CHECK: "1" }, stdio: ["ignore", "pipe", "ignore"] });
const widest = (s) => Math.max(...s.split("\n").map((l) => l.length));

test("guide covers the promise, core commands, lifecycle to main, terminal states, resume and the next step", () => {
  const g = guideText({ width: 100 });
  for (const s of ["What ForgeDock does", "Core commands", "Lifecycle", "Where a run ends", "Resume and retry", "Next step"]) assert.match(g, new RegExp(`^${s}$`, "m"), s);
  for (const s of ["/work-on <N>", "orchestrate <N...>", "/review-pr-staging", "staging-to-main", "never into main", "needs-human", "workflow:engine-error", "--retry", "--resume <id>"]) assert.ok(g.includes(s), s);
});

test("guide fits the width and is plain text unless ANSI is allowed", () => {
  for (const w of [60, 80, 100, 120]) assert.ok(widest(guideText({ width: w })) <= w, `width ${w}`);
  assert.ok(!guideText({ width: 80 }).includes(ESC));
  assert.ok(guideText({ width: 80, ansi: true }).includes(`${ESC}[1m`));
});

test("width and ANSI follow the output: TTY width clamped to 60..120, 100 and plain for a pipe, NO_COLOR, TERM=dumb", () => {
  assert.equal(guideWidth({ isTTY: false }), 100);
  assert.equal(guideWidth({ isTTY: true, columns: 40 }), 60);
  assert.equal(guideWidth({ isTTY: true, columns: 300 }), 120);
  assert.equal(guideWidth({ isTTY: true, columns: 90 }), 90);
  assert.equal(useAnsi({ isTTY: false }, {}), false);
  assert.equal(useAnsi({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(useAnsi({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(useAnsi({ isTTY: true }, { TERM: "xterm" }), true);
});

test("wrap keeps words whole and indents continuation lines", () => {
  assert.deepEqual(wrap("aa bb cc dd", 5, "  "), ["aa bb", "  cc", "  dd"]); // the indent counts toward the width
});

test("table maxWidth wraps the widest column into continuation rows and never cuts a short word", () => {
  const rows = [["Command", "Description"], ["npx x", "one two three four five six seven eight nine ten"]];
  const out = table(rows, { maxWidth: 30 }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(widest(out.trimEnd()) <= 30, out);
  assert.match(out, /npx x\s+one two/);
  assert.ok(out.split("\n").some((l) => /^\s+\S/.test(l) && l.includes("ten")), out);
  assert.equal(table(rows), table(rows, { maxWidth: 0 })); // no maxWidth: unchanged
});

test("CLI: `guide` and `help` fit 100 columns with no ANSI on a pipe; help points to the guide", () => {
  const g = run(["guide"]);
  assert.match(g, /^ForgeDock: how the workflow fits together/);
  assert.ok(widest(g) <= 100 && !g.includes(ESC));
  const h = run(["help"]);
  assert.ok(widest(h) <= 100, `help is ${widest(h)} columns wide`);
  assert.match(h, /npx forgedock guide/);
});
