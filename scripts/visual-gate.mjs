#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/visual-gate.mjs (#5369, #5330): the review-pr-staging visual gate. A thin CLI over bin/lean/design-gate.mjs, the same
 * gate the lane precheck runs (no copy): it lists the new or changed user-visible routes of a staging bundle, then judges them
 * against the rendered evidence (screenshots at every design.viewports width and the design-render-critique-loop verdict).
 *
 * Usage:
 *   node scripts/visual-gate.mjs --list   [--config forge.yaml] (--files-file PATH|- | --base REF --head REF) [--root DIR]
 *   node scripts/visual-gate.mjs          [same] [--spec yes|no | --specs-json PATH] [--evidence PATH] [--comment]
 *
 *   --list           print the routes to render ({routes, viewports, gate}) and exit 0; the reviewer renders them first
 *   --spec yes|no    every route has (yes) or lacks (no) an approved FORGE:DESIGN_SPEC; default no
 *   --specs-json     {"<route>": true|false} per route, resolved from each route's issue
 *   --evidence       {"<route>": {"screenshots": ["shots/x-390.png", ...], "verdict": "PASS|ITERATE|BUDGET-EXHAUSTED"}}
 *   --comment        print the FORGE:VISUAL_GATE comment markdown instead of JSON
 * The deterministic source critique (empty boxes, placeholder copy, a text-only hero) always runs over the page files under --root.
 * Exit: 0 PASS, ADVISORY or SKIP (design.routes unset: today's behaviour); 1 FAIL (design.gate: blocking and a finding) -> GATE_FAILURE; 2 usage.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseForgeYaml } from "../bin/forge-utils.mjs";
import { parseDesignConfig, designOn, designPages, visualGate, visualGateComment } from "../bin/lean/design-gate.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1] ?? ""); };
const has = (n) => argv.includes(n);
const usage = (m) => { process.stderr.write(`visual-gate: ${m}\n`); process.exit(2); };
const known = new Set(["--config", "--root", "--files-file", "--base", "--head", "--spec", "--specs-json", "--evidence", "--list", "--comment"]);
for (const a of argv) if (a.startsWith("--") && !known.has(a)) usage(`unknown argument: ${a}`);

const root = flag("--root") ?? process.cwd();
const confPath = flag("--config") ?? join(root, "forge.yaml");
const readJson = (p, what) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return usage(`cannot read ${what} ${p}: ${e.message}`); } };

let cfg = null;
try { cfg = parseDesignConfig(parseForgeYaml(readFileSync(confPath, "utf8"))?.design); } catch { cfg = null; }
if (!designOn(cfg)) { process.stdout.write(`${JSON.stringify({ gate: null, verdict: "SKIP", routes: [], rows: [], reason: "design.routes is unset" })}\n`); process.exit(0); }

let files;
if (flag("--files-file") != null) {
  const p = flag("--files-file");
  files = String(p === "-" ? readFileSync(0, "utf8") : readFileSync(p, "utf8")).split("\n").map((x) => x.trim()).filter(Boolean);
} else if (flag("--base") && flag("--head")) {
  try { files = execFileSync("git", ["diff", "--name-only", `${flag("--base")}...${flag("--head")}`], { cwd: root, encoding: "utf8", timeout: 30000 }).split("\n").map((x) => x.trim()).filter(Boolean); }
  catch (e) { usage(`git diff failed: ${String(e.message).split("\n")[0]}`); }
} else usage("give --files-file PATH|- or --base REF --head REF");

if (has("--list")) {
  const g = visualGate({ cfg, files });
  process.stdout.write(`${JSON.stringify({ gate: cfg.gate, viewports: cfg.viewports, directionsParam: cfg.directionsParam, routes: g.routes })}\n`);
  process.exit(0);
}

const sources = {};
for (const f of designPages(files, cfg)) { const p = join(root, f); if (existsSync(p)) { try { sources[f] = readFileSync(p, "utf8"); } catch { /* unreadable: no source critique for it */ } } }
const specFlag = flag("--spec");
const specs = flag("--specs-json") ? readJson(flag("--specs-json"), "specs") : /^(?:yes|true|1)$/i.test(specFlag ?? "");
const evidence = flag("--evidence") ? readJson(flag("--evidence"), "evidence") : {};
const g = visualGate({ cfg, files, specs, sources, evidence, rendered: true });
process.stdout.write(has("--comment") ? `${visualGateComment(g, evidence)}\n` : `${JSON.stringify(g)}\n`);
process.exit(g.verdict === "FAIL" ? 1 : 0);
