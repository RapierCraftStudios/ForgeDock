// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchAccount } from "./account-watch.mjs";

const fakeTimers = () => { const q = []; return { q, setTimer: (fn) => { const t = { fn, cleared: false }; q.push(t); return t; }, clearTimer: (t) => { t.cleared = true; }, run: () => { const t = q.shift(); if (t && !t.cleared) t.fn(); } }; };

describe("#5268 watchAccount", () => {
  it("resolves once the shim has exec'd (null reads first), then stops polling", () => {
    const ft = fakeTimers(); let n = 0, got = null;
    const w = watchAccount(() => (++n >= 3 ? 2 : null), { setTimer: ft.setTimer, clearTimer: ft.clearTimer, onFound: (a) => { got = a; } });
    assert.equal(w.current(), null);
    ft.run(); assert.equal(w.current(), null);
    ft.run(); assert.equal(w.current(), 2); assert.equal(got, 2);
    assert.equal(ft.q.length, 0, "no further timer");
  });
  it("gives up after maxMs and never throws on a failing read", () => {
    const ft = fakeTimers();
    const w = watchAccount(() => { throw new Error("gone"); }, { intervalMs: 100, maxMs: 300, setTimer: ft.setTimer, clearTimer: ft.clearTimer });
    for (let i = 0; i < 10; i++) ft.run();
    assert.equal(w.current(), null); assert.equal(ft.q.length, 0);
  });
  it("stop() clears the pending timer; refresh() re-reads once", () => {
    const ft = fakeTimers(); let v = null;
    const w = watchAccount(() => v, { setTimer: ft.setTimer, clearTimer: ft.clearTimer });
    const t = ft.q[0]; w.stop(); assert.equal(t.cleared, true);
    v = 3; assert.equal(w.refresh(), 3); assert.equal(w.current(), 3);
  });
});
