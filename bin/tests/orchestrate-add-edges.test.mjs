// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4773: `forgedock orchestrate --add` reports the Blocked by / Depends on edges the added issues create.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./_tmp.mjs";
import { openBatch, newBatchId } from "../lean/batch.mjs";
import { orchestrateFromCli } from "../engine-cli.mjs";

const issues = {
  5: { state: "OPEN", body: "Blocked by #6\nDepends on #7 and #8", authorAssociation: "OWNER", author: { login: "o" } },
  6: { state: "OPEN", body: "", authorAssociation: "OWNER", author: { login: "o" } },
  7: { state: "CLOSED" }, // closed target: no edge
  9: { state: "OPEN", body: "Blocked by #6", authorAssociation: "NONE", author: { login: "x" } }, // untrusted author: no edge
};
const io = { gh: async (a) => { const v = issues[a[a.indexOf("view") + 1]]; if (!v) throw new Error("not found"); return JSON.stringify(v); } };

describe("#4773: --add reports the edges it created", () => {
  it("lists trusted Blocked by / Depends on edges to open targets; closed, unresolved and untrusted ones are no-ops", async () => {
    const root = tmpDir("add-edges-"), prev = process.env.FORGEDOCK_BATCH_DIR;
    process.env.FORGEDOCK_BATCH_DIR = root;
    try {
      const id = newBatchId();
      openBatch(root, id).writePlan({ repo: "o/r" });
      const lines = [], log = console.log;
      console.log = (l) => lines.push(String(l));
      let out;
      try { out = await orchestrateFromCli(["--add", id, "5", "6", "9"], { io }); } finally { console.log = log; }
      assert.deepEqual(out.edges, [{ from: 5, to: 6 }]);
      assert.ok(lines.some((l) => l === `batch ${id}: edges #5 blocked by #6`), lines.join("\n"));
    } finally { if (prev === undefined) delete process.env.FORGEDOCK_BATCH_DIR; else process.env.FORGEDOCK_BATCH_DIR = prev; }
  });
});
