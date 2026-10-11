// Spec-contract test (forge#3725): the build.md B0 resume block must re-enter
// B6.5 when the newest acceptance-gate marker is blocked (see latestGateState
// in phases.mjs), instead of returning ALREADY_DONE.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("latestGateState / ACCEPTANCE_GATE spec contract (forge#3725)", () => {
  it("build.md B0 gate resume re-enters B6.5 before returning ALREADY_DONE", () => {
    const spec = readFileSync(path.join(ROOT, "commands/work-on/build.md"), "utf8");
    const start = spec.indexOf("**Resume check**");
    const end = spec.indexOf("- If there is no `<!-- FORGE:INVESTIGATOR -->`", start);
    assert.ok(start >= 0 && end > start, "B0 resume block found");
    const b0 = spec.slice(start, end);
    assert.match(b0, /ACCEPTANCE_GATE:(FAILED|BLOCKED)/);
    assert.match(b0, /BUILD_BLOCKED/);
    assert.match(b0, /re-enter at \*\*Phase B6\.5\*\*/);
    assert.ok(b0.indexOf("Gate resume") < b0.indexOf("status: ALREADY_DONE"), "gate resume precedes ALREADY_DONE");
  });
});
