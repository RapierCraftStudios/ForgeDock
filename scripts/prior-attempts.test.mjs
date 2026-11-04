// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main, parseArgs, renderPriorAttempts } from "./prior-attempts.mjs";

const cap = () => { const o = { out: [], err: [] }; return { o, io: { out: (s) => o.out.push(s), err: (s) => o.err.push(s) } }; };
const item = (n, title, extra = {}) => JSON.stringify({ number: n, title, state_reason: "completed", pr: false, merged: false, ...extra });

describe("#5085: prior-attempts.mjs", () => {
  it("prints a ## Prior Attempts table from closed issues and merged PRs found by subject terms, not files", async () => {
    const { o, io } = cap();
    const queries = [];
    const gh = async (a) => { const q = a.find((x) => String(x).startsWith("q=")); queries.push(q);
      return q.includes('"tls.bypass_misclassified"') ? [item(34683, "TLS bypass counted as block"), item(35204, "Retry TLS | bypass", { pr: true, merged: true }), item(34935, "won't fix", { state_reason: "not_planned" })].join("\n") : ""; };
    const git = async () => `\x1e${"a".repeat(40)}\x1fMerge pull request #34735 from o/x\x1fClassify tls.bypass_misclassified as success\n`;
    const code = await main(["--repo", "o/r", "--title", "fix: TLS bypass misclassified", "--body-file", "b.md", "--issue", "38355"], { ...io, gh, git, read: () => "Ends as `tls.bypass_misclassified` in src/a.ts" });
    assert.equal(code, 0, o.err.join("\n"));
    const t = o.out.join("\n");
    assert.match(t, /^## Prior Attempts\n\n\| Issue\/PR \| What it changed \| Shipped\? \| Why it didn't hold \|/);
    assert.ok(t.includes("| #35204 Retry TLS \\| bypass (PR, merged) | ? | yes | ? |"), t);
    assert.ok(t.includes("| #34935 won't fix (issue, not_planned) | ? | no | ? |"), t);
    assert.ok(t.includes("| #34683 TLS bypass counted as block (issue, completed) | ? | closed | ? |"), t);
    assert.ok(t.includes("| #34735 Classify tls.bypass_misclassified as success (PR, merged) | ? | yes | ? |"), t);
    assert.ok(t.includes("Search terms: tls.bypass_misclassified, bypass, misclassified"), t);
    assert.ok(queries.every((q) => q.startsWith("q=repo:o/r is:closed ")) && !queries.some((q) => q.includes("src/a.ts")));
  });

  it("nothing found prints the heading and the terms; a failed search exits 1 with a warning", async () => {
    assert.equal(renderPriorAttempts({ terms: ["x.y"], rows: [] }), "## Prior Attempts\n\nNone found (terms: x.y).");
    const { o, io } = cap();
    assert.equal(await main(["--repo", "o/r", "--title", "Thin content billing"], { ...io, gh: async () => { throw new Error("HTTP 403"); }, git: async () => "" }), 1);
    assert.ok(o.out[0].startsWith("## Prior Attempts") && o.err.some((e) => e.startsWith("WARNING: attempts: subject search")));
  });

  it("usage errors exit 2; --json prints the raw rows", async () => {
    const { io } = cap();
    assert.equal(await main(["--title", "x"], io), 2);
    assert.equal(await main(["--repo", "o/r", "--bogus"], io), 2);
    assert.throws(() => parseArgs(["--repo"]), /needs a value/);
    const c = cap();
    assert.equal(await main(["--repo", "o/r", "--title", "Thin content billing", "--json"], { ...c.io, gh: async () => item(9, "thin"), git: async () => "" }), 0);
    assert.deepEqual(JSON.parse(c.o.out[0]).rows.map((r) => r.number), [9]);
  });
});
