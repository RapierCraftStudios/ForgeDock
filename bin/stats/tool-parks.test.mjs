// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manifestToolParks } from "./tool-parks.mjs";

const manifest = { tools: [{ name: "shellcheck", binary: "shellcheck" }] };
const now = Date.parse("2026-11-26T00:00:00Z");
const park = (o) => ({ issue: 1, code: "env.tool_missing", detail: "Remote sandbox lacks shellcheck, and no recipe", ts: "2026-11-25T00:00:00Z", ...o });

describe("#6037 zero-park metric", () => {
  it("no parks is ok", () => assert.deepEqual(manifestToolParks([], manifest, { now }), { count: 0, offenders: [], ok: true }));
  it("a recent manifest-tool park is an offender", () => {
    const r = manifestToolParks([park()], manifest, { now });
    assert.deepEqual([r.ok, r.count, r.offenders], [false, 1, [{ issue: 1, tool: "shellcheck" }]]);
  });
  it("old, non-manifest or other-code parks are ignored", () => {
    const r = manifestToolParks([park({ ts: "2026-11-01T00:00:00Z" }), park({ detail: "Remote sandbox lacks ripgrep" }), park({ code: "other" })], manifest, { now });
    assert.equal(r.ok, true);
  });
});
