// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #4859: `authorAssociation` is not a `gh issue view|list --json` field; trust reads come from REST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../tests/_tmp.mjs";
import { ISSUE_JSON_FIELDS, issueAssociation, listAssociations, viewIssue } from "./gh-assoc.mjs";
import { openBatch, newBatchId } from "./batch.mjs";
import { orchestrateFromCli } from "../engine-cli.mjs";
import { tick, validateWatch } from "./issuewatch.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) return f === "node_modules" || f === "fixtures" ? [] : sources(p);
  return /\.mjs$/.test(f) && !/\.test\.mjs$/.test(f) ? [p] : [];
});

/** Strict gh: rejects unknown --json fields the way gh does; REST serves the association. */
const strictGh = (issues) => async (a) => {
  const j = a.indexOf("--json");
  if (j >= 0) for (const f of a[j + 1].split(",")) if (!ISSUE_JSON_FIELDS.includes(f)) throw new Error(`Unknown JSON field: "${f}"`);
  if (a[0] === "api") {
    const m = /issues\/(\d+)$/.exec(a[1]);
    if (m) { if (!issues[m[1]]) throw new Error("404"); return `${issues[m[1]].assoc}\n`; }
    return Object.entries(issues).map(([n, v]) => `${n}\t${v.assoc}`).join("\n");
  }
  if (a[1] === "view") { const v = issues[a[2]]; if (!v) throw new Error("not found"); return JSON.stringify({ state: "OPEN", body: v.body ?? "", author: { login: "u" } }); }
  if (a[1] === "list") return JSON.stringify(Object.entries(issues).map(([n, v]) => ({ number: +n, title: "t", body: v.body ?? "", labels: [], milestone: null, author: { login: "u" }, createdAt: "2026-10-30T00:00:00Z" })));
  return "";
};

test("gh issue --json field lists stay within the gh allowlist", () => {
  const seen = [];
  for (const p of sources(BIN)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/\[\s*"issue",\s*"(?:view|list)"[^\]]*?"--json",\s*"([^"]+)"/g)) seen.push([p, m[1]]);
  }
  assert.ok(seen.length >= 4, `found the gh issue --json calls (${seen.length})`);
  for (const [p, list] of seen) for (const f of list.split(",")) {
    assert.notEqual(f, "authorAssociation", `${p} asks gh for authorAssociation`);
    assert.ok(ISSUE_JSON_FIELDS.includes(f), `${p}: "${f}" is not a gh issue field`);
  }
});

test("helpers read the association from REST and fail closed", async () => {
  const gh = strictGh({ 5: { assoc: "OWNER" }, 6: { assoc: "NONE" } });
  assert.equal(await issueAssociation(gh, "o/r", 5), "OWNER");
  assert.equal(await issueAssociation(gh, "o/r", 99), undefined);
  assert.equal(await issueAssociation(async () => { throw new Error("x"); }, null, 5), undefined);
  assert.deepEqual([...(await listAssociations(gh, "o/r"))], [[5, "OWNER"], [6, "NONE"]]);
  assert.equal((await listAssociations(async () => { throw new Error("x"); }, "o/r")).size, 0);
  assert.equal((await viewIssue(gh, "o/r", 5, "body,author")).authorAssociation, "OWNER");
  assert.equal((await viewIssue(async (a) => (a[0] === "api" ? Promise.reject(new Error("x")) : gh(a)), "o/r", 5, "body")).authorAssociation, undefined);
});

test("orchestrate --add adds an open issue on a gh that rejects unknown fields", async () => {
  const root = tmpDir("assoc-add-"), prev = process.env.FORGEDOCK_BATCH_DIR;
  process.env.FORGEDOCK_BATCH_DIR = root;
  const log = console.log; console.log = () => {};
  try {
    const id = newBatchId();
    openBatch(root, id).writePlan({ repo: "o/r" });
    const io = { gh: strictGh({ 5: { assoc: "OWNER", body: "Blocked by #6" }, 6: { assoc: "OWNER" }, 9: { assoc: "NONE", body: "Blocked by #6" } }) };
    const out = await orchestrateFromCli(["--add", id, "5", "6", "9"], { io });
    assert.ok(!out.skipped.some((s) => s.reason === "unreadable"), JSON.stringify(out.skipped));
    assert.deepEqual(out.added, [5, 6, 9]);
    assert.deepEqual(out.edges, [{ from: 5, to: 6 }]); // the untrusted #9 adds no edge
  } finally { console.log = log; if (prev === undefined) delete process.env.FORGEDOCK_BATCH_DIR; else process.env.FORGEDOCK_BATCH_DIR = prev; }
});

test("issue watch tick claims a trusted author's issue and skips an untrusted one on the strict gh", async () => {
  const dir = tmpDir("assoc-watch-");
  const watch = validateWatch("w", { milestone: "none" });
  const launched = [];
  const io = { env: { FORGEDOCK_WATCH_DIR: dir }, now: () => Date.parse("2026-10-30T00:00:00Z"), sleep: async () => {}, gh: strictGh({ 1: { assoc: "OWNER" }, 2: { assoc: "NONE" } }),
    launch: (n, lane) => { launched.push(n); return { poll: () => null }; }, batch: {} };
  const state = { claimed: [], inflight: [], merged: [], verified: [], failed: [], lanes: {}, folded: [], started: null, phase: "running" };
  await tick({ watch, repo: "o/r", io, state, dir, handles: new Map() });
  assert.deepEqual(launched, [1]);
});
