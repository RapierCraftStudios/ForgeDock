// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// "Start a new project with ForgeDock" guide (#4178): the worked example must stay valid against the real
// validator, spike-doc check and dry-run preview, so the docs cannot drift from scripts/bootstrap-*.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlan } from "../../scripts/bootstrap-validate.mjs";
import { planPreview, checkSpikeDoc } from "../../scripts/bootstrap-create.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const GUIDE = "docs/site/start-a-new-project.md";
const guidePath = join(root, GUIDE);

/** Bodies of the fenced blocks with the given info string, in order. */
function fenced(text, lang) {
  const re = new RegExp("^```" + lang + "[ \\t]*\\n([\\s\\S]*?)^```[ \\t]*$", "gm");
  return [...text.matchAll(re)].map((m) => m[1]);
}

describe("Start a new project guide (#4178)", () => {
  test("exists with the title and walks idea → /bootstrap → dry run → /orchestrate", () => {
    assert.ok(existsSync(guidePath), `${GUIDE} is missing`);
    const text = readFileSync(guidePath, "utf8");
    assert.match(text, /^# Start a new project with ForgeDock$/im);
    for (const s of ["/bootstrap", "npx forgedock bootstrap", "--dry-run", "/orchestrate milestone", "--plan plan.json"]) {
      assert.ok(text.includes(s), `guide does not mention ${s}`);
    }
  });

  test("README.md links the guide", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.ok(readme.includes(`](${GUIDE})`), "README.md has no link to the guide");
  });

  test("the worked example plan passes bootstrap-validate", () => {
    const [json] = fenced(readFileSync(guidePath, "utf8"), "json");
    assert.ok(json, "guide has no ```json plan block");
    const v = validatePlan(JSON.parse(json));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });

  test("the worked example spike doc passes the spike-doc check", () => {
    const [doc] = fenced(readFileSync(guidePath, "utf8"), "markdown");
    assert.ok(doc, "guide has no ```markdown spike doc block");
    assert.deepEqual(checkSpikeDoc(doc), { ok: true, missing: [], noRationale: [] });
  });

  test("the printed dry-run preview is exactly what planPreview prints for the plan", () => {
    const text = readFileSync(guidePath, "utf8");
    const plan = JSON.parse(fenced(text, "json")[0]);
    const preview = fenced(text, "text").find((b) => b.startsWith("## Bootstrap plan preview"));
    assert.ok(preview, "guide has no dry-run preview block");
    assert.equal(preview.trim(), planPreview(plan).trim());
  });
});
