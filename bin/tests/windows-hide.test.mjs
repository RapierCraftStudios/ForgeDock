// A detached child on Windows gets its own visible console unless windowsHide: true (#4764).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".mjs") && !/\.test\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("detached spawns hide their Windows console (#4764)", () => {
  it("every `detached: true` in bin/ and scripts/ has windowsHide: true on the same line", () => {
    const bad = [];
    for (const dir of ["bin", "scripts"]) {
      for (const f of sources(join(root, dir))) {
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (/detached:\s*true/.test(line) && !/windowsHide:\s*true/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${f.slice(root.length + 1)}:${i + 1}`);
        });
      }
    }
    assert.deepEqual(bad, []);
  });
});
