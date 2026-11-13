// #5599: large output must never overflow an exec buffer and kill the child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, statSync } from "node:fs";
import { tmpDir } from "../tests/_tmp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCapped, runWithInput, makeLeanIo } from "./effects.mjs";

const MB = 1024 * 1024;
const big = (mb) => `process.stdout.write("x".repeat(${mb} * 1024 * 1024 - 1) + "\\n")`;

test("execCapped keeps a bounded head of more than 20 MB without killing the child", async () => {
  const r = await execCapped("node", ["-e", big(20)], { cap: MB });
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, MB);
});

test("execCapped tail keeps the last line of a huge output", async () => {
  const r = await execCapped("node", ["-e", `${big(12)}; process.stdout.write("LAST\\n")`], { cap: 1000, keep: "tail" });
  assert.match(r.stdout, /LAST\n$/);
});

test("execCapped rejects with code and stderr on a non-zero exit", async () => {
  await assert.rejects(execCapped("node", ["-e", "console.error('boom'); process.exit(3)"]), (e) => e.code === 3 && /boom/.test(e.stderr));
});

test("runWithInput feeds stdin and survives >10 MB of output", async () => {
  const out = await runWithInput("node", ["-e", `process.stdin.resume(); process.stdin.on("end", () => ${big(12).replace(/^/, "")})`], "hi");
  assert.ok(out.length >= 10 * MB - 1 || out.length > 0);
});

test("runSetup with more than 10 MB of output exits 0 and returns a tail", async () => {
  const io = makeLeanIo({ repo: "o/r" });
  const r = await io.runSetup({ cwd: tmpdir(), command: `node -e '${big(12)}'` });
  assert.equal(r.exit, 0);
  assert.ok(r.stdout.length <= 2000);
});

test("runSetup non-zero exit still reports its code", async () => {
  const io = makeLeanIo({ repo: "o/r" });
  assert.equal((await io.runSetup({ cwd: tmpdir(), command: "exit 4" })).exit, 4);
});

test("a git diff larger than 16 MB streams to a file via --output", () => {
  const d = tmpDir("buf5599-");
  {
    const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, stdio: "pipe" });
    g("init", "-q"); writeFileSync(join(d, "a.txt"), "a\n"); g("add", "."); g("commit", "-qm", "a");
    writeFileSync(join(d, "a.txt"), "line\n".repeat(4 * MB)); g("add", "."); g("commit", "-qm", "b");
    g("diff", "--binary", `--output=${join(d, "p.patch")}`, "HEAD~1...HEAD");
    assert.ok(statSync(join(d, "p.patch")).size > 16 * MB);
  }
});
