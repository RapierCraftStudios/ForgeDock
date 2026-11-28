// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #6238: the shared dedupe helper for engine-filed issues.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureFiledIssue, plainToken, parseWaiters, withWaiters, updateWaiters } from "./filed-issue.mjs";

const tracker = () => {
  const issues = [], comments = [];
  const ghc = async (a) => {
    const n = Number(a[2]);
    if (a[1] === "list") return JSON.stringify(issues);
    if (a[1] === "create") { issues.push({ number: issues.length + 1, state: "OPEN", closedAt: null, body: a[a.indexOf("--body") + 1] }); return `https://x/issues/${issues.length}`; }
    if (a[1] === "reopen") { issues.find((i) => i.number === n).state = "OPEN"; return ""; }
    if (a[1] === "comment") { comments.push({ body: a[a.indexOf("--body") + 1] }); return ""; }
    if (a[1] === "view") return JSON.stringify({ state: issues.find((i) => i.number === n).state, body: issues.find((i) => i.number === n).body, comments });
    if (a[1] === "edit") { issues.find((i) => i.number === n).body = a[a.indexOf("--body") + 1]; return ""; }
    return "";
  };
  return { issues, comments, ghc };
};
const KEY = "<!-- FORGE:ENVSIG abc.123 -->";
const call = (t, extra = {}) => ensureFiledIssue({ ghc: t.ghc, repo: "o/r", key: KEY, title: "t", body: `b\n${KEY}`, ...extra });

describe("#6238 ensureFiledIssue", () => {
  it("plainToken is alphanumeric only", () => assert.equal(plainToken(KEY), "FORGEENVSIGabc123"));
  it("N identical calls with a search that ignores markers create one issue", async () => {
    const t = tracker();
    const nos = [await call(t), await call(t), await call(t)];
    assert.deepEqual(nos, [1, 1, 1]);
    assert.equal(t.issues.length, 1);
  });
  it("a body without the exact marker is not a match", async () => {
    const t = tracker();
    t.issues.push({ number: 7, state: "OPEN", body: "<!-- FORGE:ENVSIG abc -->" });
    assert.equal(await call(t), 2);
  });
  it("a recently closed match is reopened; an old closure files a new issue", async () => {
    const t = tracker();
    await call(t);
    t.issues[0].state = "CLOSED"; t.issues[0].closedAt = new Date().toISOString();
    assert.equal(await call(t), 1);
    assert.equal(t.issues[0].state, "OPEN");
    t.issues[0].state = "CLOSED"; t.issues[0].closedAt = "2020-01-01T00:00:00Z";
    assert.equal(await call(t), 2);
  });
  it("an occurrence is appended once", async () => {
    const t = tracker();
    await call(t, { occurrence: "seen in #5" });
    await call(t, { occurrence: "seen in #5" });
    await call(t, { occurrence: "seen in #5" });
    assert.equal(t.comments.length, 1);
  });
});

describe("#6238 waiter list", () => {
  it("renders, parses, adds and removes waiters", async () => {
    assert.equal(parseWaiters("no block"), null);
    const b = withWaiters(`x\n${KEY}`, [2, 1, 2]);
    assert.deepEqual(parseWaiters(b), [1, 2]);
    assert.deepEqual(parseWaiters(withWaiters(b, [3])), [3]);
    const t = tracker();
    t.issues.push({ number: 1, state: "OPEN", body: b });
    assert.deepEqual((await updateWaiters({ ghc: t.ghc, repo: "o/r", number: 1, add: [3] })).waiters, [1, 2, 3]);
    const r = await updateWaiters({ ghc: t.ghc, repo: "o/r", number: 1, remove: [1, 2, 3] });
    assert.deepEqual(r.waiters, []);
    assert.deepEqual(parseWaiters(t.issues[0].body), []);
  });
});
