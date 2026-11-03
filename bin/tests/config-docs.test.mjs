import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Config keys a function source reads: `y?.<section>?.<key>` -> section.key, `e.<key>` (e = y.env) -> env.<key>. */
export function readKeys(src) {
  const keys = new Set();
  for (const m of src.matchAll(/\by\?\.(\w+)\?\.(\w+)/g)) keys.add(`${m[1]}.${m[2]}`);
  for (const m of src.matchAll(/\be\.(\w+)/g)) keys.add(`env.${m[1]}`);
  return [...keys];
}
function fnSource(file, name) {
  const s = readFileSync(join(root, file), "utf8");
  const i = s.indexOf(`export function ${name}(`);
  assert.ok(i >= 0, `${name} not found`);
  const j = s.indexOf("\nexport ", i + 1);
  return s.slice(i, j < 0 ? undefined : j);
}
const documented = (docs, key) => docs.includes(`\`${key}\``) || docs.includes(`\`${key.split(".")[1]}\``) && docs.includes(key.split(".")[1] + ":");

describe("docs/CONFIG.md key coverage", () => {
  it("extractor finds the readEnvConfig keys", () => {
    const keys = readKeys(fnSource("bin/engine-cli.mjs", "readEnvConfig"));
    for (const k of ["verification.test_runners", "env.setup", "env.toolchain", "env.sparse_max_kb"]) assert.ok(keys.includes(k), k);
  });
  it("flags an undocumented key", () => {
    assert.ok(readKeys("const z = y?.verification?.brand_new_key;").includes("verification.brand_new_key"));
    assert.equal(documented("`other`", "verification.brand_new_key"), false);
  });
  it("readEnvConfig keys are documented in docs/CONFIG.md", () => {
    const docs = readFileSync(join(root, "docs/CONFIG.md"), "utf8");
    const missing = readKeys(fnSource("bin/engine-cli.mjs", "readEnvConfig")).filter((k) => !documented(docs, k));
    assert.deepEqual(missing, [], `keys read by readEnvConfig but absent from docs/CONFIG.md: ${missing.join(", ")}`);
  });
});
