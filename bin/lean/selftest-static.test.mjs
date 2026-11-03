// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJsonFields, parseHelpFields, staticCheck, formatStatic } from "./selftest-static.mjs";

const HELP = "Usage\n\nJSON FIELDS\n  author, body, number,\n  title\n\nARGUMENTS\n  none\n";
const gh = (args) => { if (args[0] === "issue" || args[0] === "pr") return HELP; throw new Error("no"); };

describe("selftest static check (#4865)", () => {
  it("extracts only gh issue|pr view|list field lists", () => {
    const t = `x\nawait io.gh(["issue", "view", String(n), "--json", "body,title"]);\nrun(["repo", "view", "--json", "nameWithOwner"]);\ngh(["pr", "list", "--json", "number"])`;
    assert.deepEqual(extractJsonFields(t), [{ cmd: "issue view", fields: ["body", "title"], line: 2 }, { cmd: "pr list", fields: ["number"], line: 4 }]);
  });
  it("parses the JSON FIELDS section of the help", () => {
    assert.deepEqual(parseHelpFields(HELP), ["author", "body", "number", "title"]);
  });
  it("fails on a bogus field (#4859 authorAssociation) and names file:line", () => {
    const r = staticCheck({ root: "/bin", io: { gh, list: () => ["/bin/a.mjs"], read: () => 'gh(["issue", "list", "--json", "number,authorAssociation"])' } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, [{ file: "/bin/a.mjs", line: 1, cmd: "issue list", field: "authorAssociation" }]);
    assert.match(formatStatic(r), /a\.mjs:1: gh issue list --json field "authorAssociation"/);
  });
  it("passes when every field is offered", () => {
    const r = staticCheck({ root: "/bin", io: { gh, list: () => ["/bin/a.mjs"], read: () => 'gh(["pr", "view", "1", "--json", "title,body"])' } });
    assert.equal(r.ok, true); assert.equal(r.checked, 1);
  });
  it("fails closed when gh help cannot be read", () => {
    const r = staticCheck({ root: "/bin", io: { gh: () => { throw new Error("no gh"); }, list: () => ["/a.mjs"], read: () => 'x(["pr", "view", "--json", "title"])' } });
    assert.equal(r.ok, false);
  });
});
