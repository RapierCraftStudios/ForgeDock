// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { patchEcho, mutationsOf, runReproMutations, classifyRepro, addedLines } from "./reproquality.mjs";

const srcDiff = `--- a/src/strat.js
+++ b/src/strat.js
@@ -1,2 +1,5 @@
 const a = 1;
+function pick(url) {
+  if (url.includes("reddit.com")) {
+    return "https://old.reddit.com/x";
+  }
 }
`;
const echoTest = `--- /dev/null
+++ b/test/strat.test.js
@@ -0,0 +1,2 @@
+test("rewrite", () => {
+  assert.equal(strategy.rewrite_url, "https://old.reddit.com/x");
`;
const behaviourTest = `--- /dev/null
+++ b/test/strat.test.js
@@ -0,0 +1,2 @@
+test("rewrite", () => {
+  assert.equal(pick("https://www.reddit.com/r/a"), "https://old.reddit.com/x");
`;

test("patch-echo test is flagged", () => assert.equal(patchEcho({ testDiff: echoTest, srcDiff }), true));
test("behavioural test is not flagged", () => assert.equal(patchEcho({ testDiff: behaviourTest, srcDiff }), false));
test("addedLines tracks new-file line numbers", () => assert.equal(addedLines(srcDiff)[0].line, 2));
test("mutationsOf flips conditions and caps at 3", () => {
  const ms = mutationsOf(srcDiff);
  assert.ok(ms.length >= 1 && ms.length <= 3);
  assert.match(ms[0].to, /if \(!\(url\.includes\("reddit\.com"\)\)\) \{/);
  assert.equal(mutationsOf(echoTest).length, 0);
});

const fakeEnv = (rcs, { dirty = false } = {}) => {
  const files = { "/w/src/strat.js": "const a = 1;\nfunction pick(url) {\n  if (url.includes(\"reddit.com\")) {\n    return 1;\n  }\n}" };
  const orig = { ...files };
  let i = 0;
  return {
    files,
    opts: {
      cwd: "/w", command: "t", mutations: [{ file: "src/strat.js", line: 3, text: files["/w/src/strat.js"].split("\n")[2], to: "  if (!(x)) {" }],
      git: async (a) => { if (a[0] === "checkout") { files["/w/src/strat.js"] = orig["/w/src/strat.js"]; return ""; } if (a[0] === "status") return dirty ? " M x" : ""; return ""; },
      runCommand: async () => ({ rc: rcs[i++] }),
      readFile: async (p) => files[p], writeFile: async (p, c) => { files[p] = c; },
    },
  };
};
test("mutation survivor is flagged, tree restored", async () => {
  const e = fakeEnv([0]);
  const r = await runReproMutations(e.opts);
  assert.equal(r.results[0].status, "survived");
  assert.match(e.files["/w/src/strat.js"], /reddit\.com/);
  assert.equal(classifyRepro({ repro_test: { path: "t" }, mutations: r.results }), "mutation_survivor");
});
test("killed mutation is behavioural; dirty tree and timeout skip", async () => {
  const r = await runReproMutations(fakeEnv([1]).opts);
  assert.equal(classifyRepro({ repro_test: {}, mutations: r.results }), "behavioural");
  assert.equal((await runReproMutations(fakeEnv([0], { dirty: true }).opts)).skipped, "working tree not clean");
  assert.equal((await runReproMutations(fakeEnv([124]).opts)).results[0].status, "skipped");
});
test("classify: none and patch_echo", () => {
  assert.equal(classifyRepro({ repro_test: "none" }), "none");
  assert.equal(classifyRepro({ repro_test: {}, echo: true }), "patch_echo");
});

import { reproQualityFailures } from "./conformance.mjs";
import { reproFlagNote } from "./prompts.mjs";
test("enforce blocks a mutation survivor; shadow and patch_echo do not", () => {
  assert.equal(reproQualityFailures({ quality: "mutation_survivor", enforce: true })[0].kind, "repro_mutation_survivor");
  assert.equal(reproQualityFailures({ quality: "mutation_survivor", enforce: false }).length, 0);
  assert.equal(reproQualityFailures({ quality: "patch_echo", enforce: true }).length, 0);
  assert.equal(reproQualityFailures({}).length, 0);
});
test("reviewer prompt note appears only for flagged repros", () => {
  assert.match(reproFlagNote("patch_echo"), /Accept or reject it explicitly/);
  assert.match(reproFlagNote("mutation_survivor"), /mutated/);
  assert.equal(reproFlagNote("behavioural"), "");
  assert.equal(reproFlagNote(null), "");
});
