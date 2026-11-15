#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Measures how a lane gets its dependency trees from the env store, on this machine's filesystem:
 *   node bin/env/bench.mjs [--files 19677] [--dir <scratch dir>]
 * Builds a synthetic node_modules of N small files, publishes it, then times stage (pool host, outside jobs), a claim
 * of a staged copy (rename) and a claim with nothing staged (hardlink per file). File size does not matter to either:
 * no file data is read or written after publish. Prints one JSON line.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDepCache } from "../lean/depcache.mjs";
import { makeEnvStore } from "./env.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const files = Number(arg("--files", "19677"));
const base = mkdtempSync(join(arg("--dir", tmpdir()), "fd-env-bench-"));
try {
  const wt = join(base, "build"), nm = join(wt, "node_modules");
  for (let i = 0; i < files; i++) {
    const d = join(nm, `pkg-${i % 1200}`, `lib-${i % 7}`);
    if (i < 8400) mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${i}.js`), "module.exports = 1;\n");
  }
  const deps = makeDepCache({ root: join(base, "depcache"), exec: async () => "", env: {} });
  const store = makeEnvStore({ root: join(base, "store"), linkTree: deps.linkTree, readOnly: deps.readOnly });
  const key = "0123456789abcdef";
  const ms = (fn) => { const t = process.hrtime.bigint(); const r = fn(); return [Number((process.hrtime.bigint() - t) / 1000000n), r]; };
  const [publishMs, man] = ms(() => store.publish({ key, wt, trees: ["node_modules"] }));
  const [stageMs] = ms(() => store.stage({ key, count: 1 }));
  rmSync(nm, { recursive: true });
  const [renameMs, a] = ms(() => store.claim({ key, wt }));
  rmSync(nm, { recursive: true });
  const [linkMs, b] = ms(() => store.claim({ key, wt }));
  process.stdout.write(JSON.stringify({ files: man.files, publish_ms: publishMs, stage_ms: stageMs, claim_staged: { mode: a.mode, ms: renameMs }, claim_unstaged: { mode: b.mode, ms: linkMs } }) + "\n");
} finally { rmSync(base, { recursive: true, force: true }); }
