#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gen_big.mjs <repo dir>: writes the TypeScript refactor:split fixture used by scripts/symbol-move-ts.test.sh
// (forge#4212): src/big.ts (~700 lines: exported consts, non-exported helpers each used only by its exported
// function, interfaces, classes, async functions, kept code that uses moved names, a relative import), src/util.ts
// and a node:test suite in test/big.test.ts (one skipped test). Specifiers carry the .ts extension so Node runs
// the sources with type stripping.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) { process.stderr.write("usage: gen_big.mjs <dir>\n"); process.exit(2); }
const N = 20;
const pad = (i) => String(i).padStart(2, "0");
const out = [];
out.push("// SPDX-License-Identifier: MIT", "// big.ts: a hotspot module for the split fixture.", "",
  'import { clamp, type Unit } from "./util.ts";', "");
for (let i = 0; i < N; i++) out.push(`export const LIMIT_${pad(i)} = ${100 + i};`);
out.push("");
for (let i = 0; i < N; i++) {
  out.push(`// scale step ${i}`, `function _scale_${pad(i)}(x: number): number {`, `  const factor = ${i + 1};`, "  return x * factor;", "}", "");
  out.push(`/** compute ${i}: scaled and clamped. */`, `export function compute_${pad(i)}(x: number): number {`, `  const scaled = _scale_${pad(i)}(x);`,
    `  return clamp(scaled, 0, LIMIT_${pad(i)});`, "}", "");
}
for (let i = 0; i < N; i++) {
  out.push(`export interface Item_${pad(i)} {`, "  id: number;", "  unit: Unit;", "}", "");
  out.push(`export class Store_${pad(i)} {`, `  items: Item_${pad(i)}[] = [];`, `  add(item: Item_${pad(i)}): number {`, "    this.items.push(item);",
    `    return compute_${pad(i)}(item.id);`, "  }", "", "  size(): number {", "    return this.items.length;", "  }", "}", "");
}
for (let i = 0; i < N; i++) {
  out.push(`export async function fetch_${pad(i)}(x: number): Promise<number> {`, "  await Promise.resolve();", `  return compute_${pad(i)}(x) + 1;`, "}", "");
}
out.push("// kept code that uses moved names", "export function summary(): number {", "  return compute_00(1) + LIMIT_01 + new Store_02().size();", "}", "",
  "function _shared(x: number): number {", "  return x + 1;", "}", "", "export function kept_total(x: number): number {", "  return _shared(x) * 2;", "}", "",
  "export function ping(n: number): number {", "  return n <= 0 ? 0 : pong(n - 1);", "}", "", "export function pong(n: number): number {", "  return n <= 0 ? 1 : ping(n - 1);", "}");

const test = [
  'import { test } from "node:test";', 'import assert from "node:assert/strict";',
  'import { compute_03, LIMIT_05, Store_04, fetch_06, summary, kept_total, ping } from "../src/big.ts";', "",
  'test("compute clamps", () => { assert.equal(compute_03(1000), 103); assert.equal(compute_03(2), 8); });',
  'test("limits", () => { assert.equal(LIMIT_05, 105); });',
  'test("store", () => { const s = new Store_04(); assert.equal(s.add({ id: 2, unit: "m" }), 10); assert.equal(s.size(), 1); });',
  'test("fetch", async () => { assert.equal(await fetch_06(1), 8); });',
  'test("kept", () => { assert.equal(summary(), 1 + 101 + 0); assert.equal(kept_total(1), 4); assert.equal(ping(3), 1); });',
  'test("later", { skip: "not yet" }, () => {});', "",
];

mkdirSync(path.join(root, "src"), { recursive: true });
mkdirSync(path.join(root, "test"), { recursive: true });
writeFileSync(path.join(root, "src/big.ts"), out.join("\n") + "\n");
writeFileSync(path.join(root, "src/util.ts"),
  'export type Unit = "m" | "s";\n\nexport function clamp(x: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, x));\n}\n');
writeFileSync(path.join(root, "test/big.test.ts"), test.join("\n"));
writeFileSync(path.join(root, "package.json"), '{ "name": "split-fixture", "private": true, "type": "module" }\n');
