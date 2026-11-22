// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// The install opens with the forgedock-splash scene on interactive truecolor terminals only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { introScene } from "../journey.mjs";
import { LAST } from "../splash-scene.mjs";

const tty = (extra = {}) => {
  const out = [];
  return { out, stdout: { columns: 120, rows: 40, write: (s) => { out.push(s); } }, mode: "truecolor", motion: true, argv: [], env: {}, ...extra };
};
const fast = { wait: async () => {} };

test("plays every frame, hides then restores the cursor, and erases itself", async () => {
  const ctx = tty();
  assert.equal(await introScene(ctx, fast), true);
  const all = ctx.out.join("");
  assert.ok(all.startsWith("\x1b[?25l"));
  assert.ok(all.endsWith("\x1b[?25h"));
  assert.match(all, /\x1b\[J/);
  assert.equal(ctx.out.filter((s) => s.includes("\x1b[K")).length, LAST + 1); // one write per frame
});

for (const [why, extra] of [
  ["motion off (non-TTY, CI, --fast)", { motion: false }],
  ["no truecolor", { mode: "256" }],
  ["--no-splash", { argv: ["--no-splash"] }],
  ["FORGEDOCK_NO_SPLASH=1", { env: { FORGEDOCK_NO_SPLASH: "1" } }],
]) {
  test(`skips when ${why}`, async () => {
    const ctx = tty(extra);
    assert.equal(await introScene(ctx, fast), false);
    assert.equal(ctx.out.length, 0);
  });
}

test("skips when the terminal is too small", async () => {
  const ctx = tty();
  ctx.stdout.columns = 50;
  assert.equal(await introScene(ctx, fast), false);
});

test("never throws if the scene cannot load", async () => {
  assert.equal(await introScene(tty(), { ...fast, load: async () => { throw new Error("nope"); } }), false);
});
