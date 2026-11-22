// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// The GitHub App step must not leak ANSI codes when color is off (stray "[22m" after the URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../journey.mjs";

const run = async (mode, yes) => {
  let out = "";
  await connect({ mode, stdout: { write: (s) => { out += s; } }, confirmFn: async () => yes, openFn: () => {} });
  return out;
};

for (const yes of [false, true]) {
  test(`connect (${yes ? "open" : "skip"}) writes no escape codes when mode is none`, async () => {
    const out = await run("none", yes);
    assert.ok(!out.includes("\x1b"), JSON.stringify(out));
    assert.match(out, /installations\/new/);
  });
  test(`connect (${yes ? "open" : "skip"}) still dims text in color mode`, async () => {
    assert.match(await run("truecolor", yes), /\x1b\[2m[\s\S]*\x1b\[22m/);
  });
}
