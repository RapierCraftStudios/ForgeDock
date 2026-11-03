// A detached child on Windows gets its own console window unless `windowsHide: true` is set (#4764).
// Scans non-test sources under bin/ and scripts/ for a `detached: true` options object without it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "tests", ".claude"]);

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) sources(join(dir, e.name), out); continue; }
    if (/\.(mjs|js|cjs)$/.test(e.name) && !/\.test\.(mjs|js|cjs)$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** The enclosing `{ ... }` of the offset (brace matching outward, strings ignored: good enough for option literals). */
function enclosingObject(text, at) {
  let depth = 0, start = -1;
  for (let i = at; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") { if (depth === 0) { start = i; break; } depth--; }
  }
  if (start < 0) return text.slice(at, at + 200);
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

export function findViolations(text, file = "<src>") {
  const bad = [];
  const re = /\bdetached:\s*true\b/g;
  let m;
  while ((m = re.exec(text))) {
    if (!/\bwindowsHide:\s*true\b/.test(enclosingObject(text, m.index))) bad.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
  }
  return bad;
}

describe("#4764: detached spawns hide the Windows console", () => {
  it("scanner flags a detached spawn without windowsHide and passes one with it", () => {
    assert.equal(findViolations(`spawn("x", [], { detached: true, stdio: "ignore" });`).length, 1);
    assert.equal(findViolations(`spawn("x", [], { detached: true, windowsHide: true, stdio: "ignore" });`).length, 0);
    assert.equal(findViolations(`spawn("x", [], {\n  stdio: "ignore",\n  windowsHide: true,\n  detached: true,\n});`).length, 0);
    assert.deepEqual(findViolations(`a();\nspawn("x", [], { env: { A: 1 }, detached: true });`, "f.mjs"), ["f.mjs:2"]);
  });

  it("every non-test detached spawn under bin/ and scripts/ passes windowsHide: true", () => {
    const files = [...sources(join(ROOT, "bin")), ...sources(join(ROOT, "scripts"))];
    assert.ok(files.length > 50, "the scan found the sources");
    const bad = files.flatMap((f) => findViolations(readFileSync(f, "utf8"), f.slice(ROOT.length + 1)));
    assert.deepEqual(bad, [], `detached: true without windowsHide: true:\n${bad.join("\n")}`);
  });
});
