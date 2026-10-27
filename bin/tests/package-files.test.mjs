// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);

describe("#4751: npm package ships the bot-token refresh script", () => {
  it("package.json files includes scripts/ without excluding refresh-bot-token.sh", () => {
    const { files } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    assert.ok(files.includes("scripts/"));
    assert.ok(!files.some((f) => f.startsWith("!") && f.includes("refresh-bot-token")));
    assert.ok(existsSync(new URL("scripts/refresh-bot-token.sh", root)));
  });
});
