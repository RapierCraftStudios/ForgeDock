import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkStamp, stampText, stampRule } from "./stagestamp.mjs";

describe("stage stamps (#5333)", () => {
  it("stampText carries the issue and the contract hash, `-` before the freeze", () => {
    assert.equal(stampText({ issue: 7, hash: "abc123def456" }), "forge-stamp: issue=7 contract=abc123def456");
    assert.equal(stampText({ issue: 7 }), "forge-stamp: issue=7 contract=-");
  });
  it("a matching stamp passes and is stripped", () => {
    const c = checkStamp("forge-stamp: issue=7 contract=abc123\n### Approach\nx", { issue: 7, hash: "abc123" });
    assert.deepEqual(c, { ok: true, md: "### Approach\nx" });
  });
  it("another issue's stamp is refused (the stash-pop case)", () => {
    const c = checkStamp("forge-stamp: issue=37641 contract=ffff\ncurl_cffi", { issue: 40194, hash: "abc123" });
    assert.equal(c.ok, false);
    assert.match(c.reason, /issue #37641, run is #40194/);
  });
  it("same issue, other contract hash is refused; an unknown run hash or `-` is not checked", () => {
    assert.equal(checkStamp("forge-stamp: issue=7 contract=aaa\nx", { issue: 7, hash: "bbb" }).ok, false);
    assert.equal(checkStamp("forge-stamp: issue=7 contract=aaa\nx", { issue: 7, hash: null }).ok, true);
    assert.equal(checkStamp("forge-stamp: issue=7 contract=-\nx", { issue: 7, hash: "bbb" }).ok, true);
  });
  it("an unstamped note is accepted unchanged", () => {
    assert.deepEqual(checkStamp("### Approach\nx", { issue: 7 }), { ok: true, md: "### Approach\nx" });
    assert.equal(checkStamp(null, { issue: 7 }).md, "");
  });
  it("stampRule names the stamp, empty without one", () => {
    assert.match(stampRule("forge-stamp: issue=7 contract=-"), /first line[\s\S]*forge-stamp: issue=7/);
    assert.equal(stampRule(null), "");
  });
});
