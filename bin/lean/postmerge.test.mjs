// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { postMergeCommands, declaredExports, duplicateExports } from "./postmerge.mjs";

const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const gitIn = (cwd) => async (a) => sh(cwd, ...a);
const put = (root, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); } };
/** A repo with `base` committed on main and `lane` committed on a lane branch. */
function repo(base, lane) {
  const d = tmpDir("postmerge-");
  sh(d, "init", "-q", "-b", "main");
  put(d, base); sh(d, "add", "-A"); sh(d, "commit", "-qm", "base");
  sh(d, "checkout", "-q", "-b", "lane");
  put(d, lane); sh(d, "add", "-A"); sh(d, "commit", "-qm", "lane");
  return d;
}
const dups = (d) => duplicateExports({ git: gitIn(d), cwd: d, base: "main" });

const BASE = {
  "apps/web/package.json": "{}",
  "apps/web/inbox/actions.ts": "export async function undoActivityAction() {}\nexport async function reassignCaptureAction() {}\n",
  "packages/x/package.json": "{}",
  "packages/x/src/feed.ts": "export function feedOnly() {}\n",
};

describe("duplicate exports (#4406)", () => {
  it("a lane export another module of the same app declares is a finding with both paths", async () => {
    const d = repo(BASE, { "apps/web/feed/actions.ts": "export async function undoActivityAction() {}\nexport async function undoFeedActivityAction() {}\n" });
    assert.deepEqual(await dups(d), [{ symbol: "undoActivityAction", path: "apps/web/feed/actions.ts", others: ["apps/web/inbox/actions.ts"] }]);
  });

  it("another package, a barrel re-export, a test file and an export the file already had are not findings", async () => {
    const d = repo({ ...BASE, "apps/web/feed/old.ts": "export function keepMe() {}\n", "apps/web/feed/twin.ts": "export function keepMe() {}\n" }, {
      "packages/x/src/actions.ts": "export async function undoActivityAction() {}\n",
      "apps/web/index.ts": "export { undoActivityAction } from './inbox/actions';\nexport * from './inbox/actions';\n",
      "apps/web/__tests__/actions.test.ts": "export const undoActivityAction = 1;\n",
      "apps/web/feed/old.ts": "export function keepMe() {}\nexport const touched = 1;\n",
    });
    assert.deepEqual(await dups(d), []);
  });

  it("a name 3+ other modules declare is a convention, not a collision; default is never one", async () => {
    const route = "export async function GET() {}\nexport default function Page() {}\n";
    const d = repo({ ...BASE, "apps/web/a/route.ts": route, "apps/web/b/route.ts": route, "apps/web/c/route.ts": route }, { "apps/web/d/route.ts": route });
    assert.deepEqual(await dups(d), []);
  });

  it("Python modules of one package collide too; unreadable git yields []", async () => {
    const d = repo({ "svc/pyproject.toml": "", "svc/a.py": "def resolve_tenant():\n  pass\n" }, { "svc/b.py": "def resolve_tenant():\n  pass\n" });
    assert.deepEqual(await dups(d), [{ symbol: "resolve_tenant", path: "svc/b.py", others: ["svc/a.py"] }]);
    assert.deepEqual(await duplicateExports({ git: async () => { throw new Error("boom"); }, cwd: d, base: "main" }), []);
  });

  it("declaredExports drops re-exports and default", () => {
    assert.deepEqual(declaredExports("export { a } from './a';\nexport * as ns from './n';\nexport default function x() {}\nexport const b = 1;\nconst c = 2;\nexport { c };\n", "m.ts").sort(), ["b", "c"]);
  });
});

describe("post-merge commands (#4406)", () => {
  const SCOPED = [
    { kind: "typecheck", command: "pnpm exec tsc -p .", cwd: "apps/web", mode: "scoped" },
    { kind: "typecheck", command: "", cwd: "packages/x", mode: "skip" },
    { kind: "typecheck", command: "pnpm run typecheck", cwd: ".", mode: "full" },
    { kind: "lint", command: "eslint .", cwd: ".", mode: "scoped" },
  ];
  it("verify.post_merge wins; else the non-skip scoped typecheck rows in their package dir; ci mode runs none", () => {
    assert.deepEqual(postMergeCommands({ configured: " make check ", scoped: SCOPED, mode: "ci" }), ["make check"]);
    assert.deepEqual(postMergeCommands({ scoped: SCOPED, mode: "local" }), ["cd apps/web && pnpm exec tsc -p .", "pnpm run typecheck"]);
    assert.deepEqual(postMergeCommands({ scoped: SCOPED, mode: "hybrid" }).length, 2);
    assert.deepEqual(postMergeCommands({ scoped: SCOPED, mode: "ci" }), []);
    assert.deepEqual(postMergeCommands({ scoped: null }), []);
  });
});
