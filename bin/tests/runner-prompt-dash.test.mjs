// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// A prompt that starts with "-" (a review brief opening with `---` front matter) must not be an argv word: the
// claude CLI parses it as an option and exits 1 ("unknown option '---'"); release reviewers never posted (#5389).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promptGoesViaStdin } from "../runner.mjs";

describe("promptGoesViaStdin: leading dash", () => {
  it("sends a front-matter prompt over stdin", () => {
    assert.equal(promptGoesViaStdin("---\nuser-invocable: false\n---\n# Review", [], "linux"), true);
    assert.equal(promptGoesViaStdin("  -p is a flag", [], "linux"), true);
  });
  it("keeps a small ordinary prompt as an argument", () => {
    assert.equal(promptGoesViaStdin("Review PR #7 --- carefully", [], "linux"), false);
  });
});
