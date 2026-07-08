#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * scripts/build-spec-graph.mjs — ForgeDock Spec Knowledge Graph builder
 *
 * Builds a queryable, zero-dependency self-map of ForgeDock's own command
 * specs (commands/*.md), scripts (scripts/*.sh), and devdocs (devdocs/**\/*.md)
 * into a single JSON document at `.forgedock/graph/spec-graph.json`.
 *
 * The graph lets agents load only task-relevant specs and run impact analysis
 * on the pipeline's information flow (which command writes which FORGE
 * annotation, which command reads it, which labels a command transitions, etc).
 *
 * ZERO DEPENDENCIES: Node.js built-ins only (fs, path, url). No rg/jq
 * subprocess, no tree-sitter, no SQLite, no MCP. The `rg`-equivalent scan is
 * done in-process so the builder is a single portable artifact.
 *
 * Usage:
 *   node scripts/build-spec-graph.mjs [--root <repo-root>] [--out <path>] [--stdout] [--hash] [--quiet] [--help]
 *
 * Options:
 *   --root <dir>   Repo root to scan (default: parent of this script's dir)
 *   --out <path>   Output JSON path (default: <root>/.forgedock/graph/spec-graph.json)
 *   --stdout       Print the graph JSON to stdout instead of writing a file
 *   --hash         Print ONLY the input fingerprint (sha256 of the scanned spec
 *                  corpus) to stdout and exit. No graph is built or written.
 *                  This is the cheap staleness-probe used by graph-query.sh.
 *   --quiet        Suppress the summary + self-check output on stderr
 *   --help         Show this help
 *
 * Output node types:
 *   command   — a top-level commands/*.md spec
 *   sub-phase — a nested commands/<cmd>/.../*.md spec (e.g. work-on:build:implement)
 *   annotation— a distinct FORGE:* HTML-comment marker
 *   label     — a distinct workflow:* label
 *   script    — a scripts/*.sh file on disk
 *   devdoc    — a devdocs/**\/*.md reference doc
 *
 * Output edge types (all command/sub-phase -> X):
 *   WRITES      — command posts a FORGE annotation (gh ... comment --body "<!-- FORGE:X -->")
 *   READS       — command consumes a FORGE annotation (contains("FORGE:X") / "read the FORGE:X")
 *   TRANSITIONS — command sets a workflow label (--add-label "workflow:X")
 *   CONTAINS    — command -> sub-phase (directory nesting + Skill(skill="X") invocations)
 *   INVOKES     — command runs a script (references a real scripts/*.sh file)
 *   REQUIRES    — command/spec must read a devdoc (authority: required)
 *   SHARED_BLOCK — two command/sub-phase files share an identical normalized content block
 *               (heading-delimited section; hash match after whitespace + heading-number strip).
 *               Evidence carries { file, section, hash, siblingFile, siblingSection }.
 *               Used by validate-spec-graph.sh --changed-files for clone-drift detection.
 *
 * Determinism: all node/edge arrays are sorted by a stable composite key and
 * JSON is emitted with sorted object keys, so re-runs produce byte-identical
 * output (idempotent). See docs/spec-graph-schema.md for the full schema.
 *
 * Staleness: the graph carries `builtFromHash`, a sha256 fingerprint of the
 * scanned input corpus (every commands/scripts/devdocs file's repo-relative
 * path + content, in sorted order). It is purely input-derived — no timestamps
 * or absolute paths — so identical inputs yield an identical hash and the output
 * stays byte-identical. graph-query.sh recomputes this hash (via `--hash`) on
 * query and rebuilds the graph if the persisted fingerprint no longer matches.
 * No daemon / file-watcher: staleness is checked pull-based, on demand.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = { root: null, out: null, stdout: false, quiet: false, hash: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--help" || a === "-h") {
    printHelp();
    process.exit(0);
  } else if (a === "--root") {
    opts.root = args[++i];
  } else if (a === "--out") {
    opts.out = args[++i];
  } else if (a === "--stdout") {
    opts.stdout = true;
  } else if (a === "--hash") {
    opts.hash = true;
  } else if (a === "--quiet") {
    opts.quiet = true;
  } else {
    console.error(`Unknown argument: ${a}`);
    printHelp();
    process.exit(2);
  }
}

function printHelp() {
  // Print the leading JSDoc block (between the first /** and */).
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const m = self.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) {
    console.log(
      m[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*?/, "").trimEnd())
        .join("\n")
        .trim(),
    );
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = opts.root ? opts.root : dirname(SCRIPT_DIR);
const OUT = opts.out ? opts.out : join(ROOT, ".forgedock", "graph", "spec-graph.json");

// ---------------------------------------------------------------------------
// Filesystem helpers (zero-dependency recursive glob)
// ---------------------------------------------------------------------------

/** Recursively list files under `dir` matching `predicate(relPath)`. Returns
 *  repo-relative POSIX paths, sorted. Missing dirs return []. */
function walk(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      out.push(...walk(full, predicate));
    } else if (ent.isFile()) {
      const rel = toPosix(relative(ROOT, full));
      if (predicate(rel)) out.push(rel);
    }
  }
  return out.sort();
}

function toPosix(p) {
  return p.split(sep).join("/");
}

function readFile(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
}

function exists(rel) {
  try {
    statSync(join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input discovery + fingerprint (shared by the full build and `--hash` mode)
// ---------------------------------------------------------------------------

/**
 * Discover the three input corpora the graph is built from. The full build and
 * the `--hash` staleness probe MUST call this same helper so their file sets
 * can never drift (drift would make every query false-positive as stale).
 * Returns { commandFiles, scriptFiles, devdocFiles } — each a sorted array of
 * repo-relative POSIX paths.
 */
function discoverInputFiles() {
  return {
    commandFiles: walk(join(ROOT, "commands"), (rel) => rel.endsWith(".md")),
    scriptFiles: walk(join(ROOT, "scripts"), (rel) => rel.endsWith(".sh")),
    devdocFiles: walk(join(ROOT, "devdocs"), (rel) => rel.endsWith(".md")),
  };
}

/**
 * Compute the deterministic input fingerprint over a discovered file set.
 *
 * The hash is sha256 over each file's repo-relative path + content, in a single
 * sorted order across all three corpora, with NUL separators so no path/content
 * boundary is ambiguous. It is purely input-derived: no timestamps, no mtimes,
 * no absolute paths — so identical inputs always yield the same hash and the
 * emitted graph stays byte-identical (idempotent).
 */
function computeInputHash(files) {
  const allRel = [...files.commandFiles, ...files.scriptFiles, ...files.devdocFiles].sort();
  const h = createHash("sha256");
  for (const rel of allRel) {
    h.update(rel);
    h.update("\0");
    h.update(readFile(rel));
    h.update("\0");
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Node-id derivation
// ---------------------------------------------------------------------------

/**
 * Derive a command/sub-phase node id from a `commands/...` markdown relpath.
 *   commands/work-on.md                  -> { id: "cmd:work-on", type: "command",   name: "work-on" }
 *   commands/work-on/build.md            -> { id: "cmd:work-on:build", type: "sub-phase", name: "work-on:build" }
 *   commands/work-on/build/implement.md  -> { id: "cmd:work-on:build:implement", type: "sub-phase", name: "work-on:build:implement" }
 */
function commandNodeFromPath(rel) {
  // strip "commands/" prefix and ".md" suffix
  const stem = rel.replace(/^commands\//, "").replace(/\.md$/, "");
  const parts = stem.split("/");
  const name = parts.join(":");
  const isTopLevel = parts.length === 1;
  return {
    id: `cmd:${name}`,
    type: isTopLevel ? "command" : "sub-phase",
    name,
    path: rel,
  };
}

/** Map a Skill(skill="X") target to a command node id. The skill name uses the
 *  same `:`-delimited convention as our sub-phase names (e.g. "work-on:build").
 *  Specs also write the `/`-delimited form (e.g. "work-on/review"); normalize it
 *  to the colon form so both resolve to the same node (kept in sync with the
 *  dangling-ref check in validate-spec-graph.sh). */
function skillTargetToId(skill) {
  return `cmd:${skill.replace(/\//g, ":")}`;
}

// ---------------------------------------------------------------------------
// Block fingerprinting — shared-block edge detection
// ---------------------------------------------------------------------------

/**
 * Minimum normalized line count for a block to be considered a shared-block
 * candidate. Tiny boilerplate sections (e.g. single-line headings with no
 * body) produce false positives — require at least this many non-empty lines.
 */
const SHARED_BLOCK_MIN_LINES = 10;

/**
 * Normalize a block of content for fingerprinting.
 *
 * Normalization rules (cosmetic divergence must NOT alarm):
 *   1. Strip leading/trailing whitespace from every line.
 *   2. Collapse runs of blank lines to a single blank line.
 *   3. Strip heading-number prefixes from the first line of a section heading
 *      (e.g. "### 3B: Foo" → "### Foo", "## 0B.1: Bar" → "## Bar").
 *   4. Lowercase the entire content so spelling-case divergence is invisible.
 *
 * Structural divergence (different prose, reordered bullets) IS retained and
 * WILL produce a different hash, triggering no edge — as intended.
 */
function normalizeBlock(lines) {
  const stripped = lines
    .map((l) => l.trim())
    // Strip heading-number prefixes: "### 0B.1: text" → "### text",
    // "## 3C.5: text" → "## text", "### 1A: text" → "### text".
    .map((l) => l.replace(/^(#{1,6}\s+)[0-9]+[A-Z]?(?:\.[0-9]+)?(?:\.[0-9]+)?:\s+/, "$1"))
    .join("\n")
    // Collapse runs of ≥2 blank lines to a single blank line.
    .replace(/\n{3,}/g, "\n\n")
    .toLowerCase()
    .trim();
  return stripped;
}

/**
 * Split `text` (a command/sub-phase spec file) into heading-delimited blocks.
 *
 * Each block starts at a `##` or `###` heading and runs until the next
 * heading of the same or higher level (or end of file). The heading line is
 * included in the block so the section title participates in the hash.
 *
 * Returns an array of { heading, lines[], normalized, hash } objects.
 * Blocks below SHARED_BLOCK_MIN_LINES (after normalization) are omitted to
 * avoid false positives from tiny boilerplate sections.
 */
function splitIntoBlocks(text) {
  const rawLines = text.split("\n");
  const blocks = [];
  let currentHeading = null;
  let currentLines = [];

  const flushBlock = () => {
    if (!currentHeading) return;
    const normalized = normalizeBlock(currentLines);
    const nonEmpty = normalized.split("\n").filter((l) => l.trim().length > 0);
    if (nonEmpty.length >= SHARED_BLOCK_MIN_LINES) {
      const hash = createHash("sha256").update(normalized).digest("hex");
      blocks.push({ heading: currentHeading, lines: currentLines.slice(), normalized, hash });
    }
  };

  for (const line of rawLines) {
    // Match ## or ### headings (but NOT #### and deeper — too granular).
    if (/^#{2,3}\s/.test(line)) {
      flushBlock();
      currentHeading = line.trim();
      currentLines = [line];
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }
  flushBlock();
  return blocks;
}

/**
 * Fingerprint all command files and emit SHARED_BLOCK edges between any two
 * (file, section) pairs whose normalized block hash matches.
 *
 * A SHARED_BLOCK edge is directional: from the lexically-first file to the
 * lexically-second file (so each pair produces exactly one edge, not two).
 * The evidence payload carries both files and both section headings so the
 * validator can name them precisely in its warning.
 *
 * This function is called ONLY from build() — NOT from the --hash probe path.
 * The --hash path exits before build() is called.
 */
function fingerprintBlocks(commandFiles, allSpecText, addEdge, nodes) {
  // Build a map: hash -> [ { file, heading } ]
  const hashMap = new Map();

  for (let ci = 0; ci < commandFiles.length; ci++) {
    const rel = commandFiles[ci];
    const text = allSpecText[ci];
    const blocks = splitIntoBlocks(text);
    for (const block of blocks) {
      const entry = { file: rel, heading: block.heading, hash: block.hash };
      if (!hashMap.has(block.hash)) hashMap.set(block.hash, []);
      hashMap.get(block.hash).push(entry);
    }
  }

  // For each hash with ≥2 matches, emit SHARED_BLOCK edges between all pairs.
  for (const [hash, entries] of hashMap) {
    if (entries.length < 2) continue;
    // Sort by file path for determinism (lexically earlier file is `from`).
    const sorted = [...entries].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const fromId = `cmd:${a.file.replace(/^commands\//, "").replace(/\.md$/, "").split("/").join(":")}`;
        const toId = `cmd:${b.file.replace(/^commands\//, "").replace(/\.md$/, "").split("/").join(":")}`;
        // Only emit if both nodes exist in the graph.
        if (nodes.has(fromId) && nodes.has(toId)) {
          addEdge(fromId, "SHARED_BLOCK", toId, {
            file: a.file,
            section: a.heading,
            siblingFile: b.file,
            siblingSection: b.heading,
            hash: hash.slice(0, 16), // truncated for readability in graph JSON
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build the graph
// ---------------------------------------------------------------------------

function build() {
  const nodes = new Map(); // id -> node object
  const edgeSet = new Set(); // dedupe key -> true
  const edges = [];

  function addNode(node) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id);
  }

  function addEdge(from, type, to, evidence) {
    const key = `${from}|${type}|${to}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from, type, to, ...(evidence ? { evidence } : {}) });
  }

  // --- Discover files -------------------------------------------------------
  // Use the shared discovery helper so the full build and the `--hash` probe
  // operate on an identical file set (otherwise queries false-positive stale).
  const inputFiles = discoverInputFiles();
  const { commandFiles, scriptFiles, devdocFiles } = inputFiles;

  // Input fingerprint — sha256 of the scanned corpus (path+content, sorted).
  const builtFromHash = computeInputHash(inputFiles);

  // Known real script basenames (for INVOKES resolution).
  const realScripts = new Set(scriptFiles.map((rel) => basename(rel)));

  // --- Command / sub-phase nodes -------------------------------------------
  const commandNodes = commandFiles.map(commandNodeFromPath);
  for (const n of commandNodes) addNode(n);

  // --- Script nodes ---------------------------------------------------------
  for (const rel of scriptFiles) {
    addNode({ id: `script:${basename(rel)}`, type: "script", name: basename(rel), path: rel });
  }

  // --- Devdoc nodes ---------------------------------------------------------
  for (const rel of devdocFiles) {
    addNode({ id: `devdoc:${rel}`, type: "devdoc", name: rel.replace(/^devdocs\//, ""), path: rel });
  }

  // Regexes (module-level reuse is fine; we recreate with /g per-scan to reset lastIndex)
  const ANNOTATION_RE = /FORGE:[A-Z][A-Z0-9_]*/g;
  const LABEL_RE = /workflow:[a-z][a-z0-9-]*/g;

  // --- First pass: register all annotation + label nodes from the whole corpus
  //     (so even annotations that are only ever READ get a node). ------------
  const allSpecText = commandFiles.map(readFile);
  for (const text of allSpecText) {
    for (const m of text.matchAll(ANNOTATION_RE)) {
      addNode({ id: `ann:${m[0]}`, type: "annotation", name: m[0] });
    }
    for (const m of text.matchAll(LABEL_RE)) {
      addNode({ id: `label:${m[0]}`, type: "label", name: m[0] });
    }
  }

  // --- Second pass: per-command edge extraction ----------------------------
  for (let ci = 0; ci < commandFiles.length; ci++) {
    const rel = commandFiles[ci];
    const node = commandNodes[ci];
    const fromId = node.id;
    const text = allSpecText[ci];
    const lines = text.split("\n");

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const next = li + 1 < lines.length ? lines[li + 1] : "";

      // WRITES: command posts a FORGE annotation via `gh ... comment --body`.
      // The marker may be on the same line as --body or on the next line.
      if (/gh\s+(issue|pr)\s+comment[\s\S]*--body/.test(line)) {
        const window = line + "\n" + next;
        // Only count a FORGE marker that appears inside an HTML comment posted
        // as the comment body (i.e. immediately after --body, possibly quoted).
        const bodyTail = window.slice(window.indexOf("--body"));
        // Match both the plain marker `<!-- FORGE:X -->` and the value-carrying
        // handshake form `<!-- FORGE:X: <value> -->` (e.g. FORGE:KNOWLEDGE_GIST,
        // FORGE:MILESTONE_INDEX, FORGE:PRIOR_GIST). The `:\s+` (colon + space)
        // requirement distinguishes a value handshake from a `:COMPLETE`/`:PARTIAL`
        // sentinel suffix (e.g. `FORGE:PHASE:COMPLETE`), which is NOT a write.
        for (const m of bodyTail.matchAll(/<!--\s*(FORGE:[A-Z][A-Z0-9_]*)\s*(?::\s+[^>]*?)?\s*-->/g)) {
          addEdge(fromId, "WRITES", `ann:${m[1]}`, { file: rel, line: li + 1 });
        }
      }

      // READS: command consumes a FORGE annotation.
      //   jq forms:  contains("FORGE:X"), contains("FORGE:X:"),
      //              test("<!-- FORGE:X: ..."), capture("<!-- FORGE:X: ...")
      //   prose form: read[s]/re-read the FORGE:X
      // The `[^"']*?` prefix lets the value-carrying handshake forms (which embed
      // the marker after `<!-- `) be recognized, not just bare contains().
      for (const m of line.matchAll(/\b(?:contains|test|capture)\(\s*["'][^"']*?(FORGE:[A-Z][A-Z0-9_]*)/g)) {
        addEdge(fromId, "READS", `ann:${m[1]}`, { file: rel, line: li + 1 });
      }
      for (const m of line.matchAll(/\bre-?reads?\b[^.\n]*?(FORGE:[A-Z][A-Z0-9_]*)/gi)) {
        addEdge(fromId, "READS", `ann:${m[1]}`, { file: rel, line: li + 1 });
      }

      // TRANSITIONS: command sets a workflow label.
      for (const m of line.matchAll(/--add-label\s+["']([^"']*workflow:[a-z0-9-]+[^"']*)["']/g)) {
        // a single --add-label may carry a comma-separated list
        for (const lm of m[1].matchAll(LABEL_RE)) {
          addEdge(fromId, "TRANSITIONS", `label:${lm[0]}`, { file: rel, line: li + 1 });
        }
      }

      // CONTAINS (Skill invocation): command -> sub-command/skill it invokes.
      // Matches all invocation forms — positional Skill("X"), keyword
      // Skill(skill="X"), and colon Skill(skill: "X") — with `/`-delimited
      // sub-phase targets and uppercase/leading-digit names. Kept in sync with
      // the dangling-ref check in validate-spec-graph.sh.
      for (const m of line.matchAll(/Skill\(\s*(?:skill\s*[:=]\s*)?["']([A-Za-z0-9][A-Za-z0-9:_/-]*)["']/g)) {
        const targetId = skillTargetToId(m[1]);
        // Only link if the target resolves to a known command/sub-phase node.
        if (nodes.has(targetId)) {
          addEdge(fromId, "CONTAINS", targetId, { file: rel, line: li + 1, via: "skill" });
        }
      }

      // INVOKES: command references a real scripts/*.sh file.
      for (const m of line.matchAll(/\b([A-Za-z0-9_-]+\.sh)\b/g)) {
        if (realScripts.has(m[1])) {
          addEdge(fromId, "INVOKES", `script:${m[1]}`, { file: rel, line: li + 1 });
        }
      }

      // REQUIRES: command/spec must read a devdoc (authority: required).
      // Heuristic: a line that both references a devdocs/*.md path AND carries a
      // requirement verb (Read/REQUIRED/before/must read).
      const devdocRefs = [...line.matchAll(/devdocs\/[A-Za-z0-9/_-]+\.md/g)];
      if (devdocRefs.length && /\b(read|required|must|before)\b/i.test(line)) {
        for (const m of devdocRefs) {
          const ddId = `devdoc:${m[0]}`;
          if (nodes.has(ddId)) {
            addEdge(fromId, "REQUIRES", ddId, { file: rel, line: li + 1, authority: "required" });
          }
        }
      }
    }
  }

  // --- CONTAINS (directory nesting): parent spec -> nested sub-phase --------
  // e.g. cmd:work-on -> cmd:work-on:build -> cmd:work-on:build:implement.
  for (const n of commandNodes) {
    if (n.type !== "sub-phase") continue;
    const parts = n.name.split(":");
    const parentName = parts.slice(0, -1).join(":");
    const parentId = `cmd:${parentName}`;
    if (nodes.has(parentId)) {
      addEdge(parentId, "CONTAINS", n.id, { via: "directory" });
    }
  }

  // --- SHARED_BLOCK: cross-spec content clone detection --------------------
  // Fingerprint heading-delimited blocks across all command files. Emit
  // SHARED_BLOCK edges between any two (file, section) pairs whose normalized
  // content hash matches. Used by validate-spec-graph.sh --changed-files for
  // clone-drift detection pre-commit and in CI.
  fingerprintBlocks(commandFiles, allSpecText, addEdge, nodes);

  // --- Finalize: deterministic ordering ------------------------------------
  const nodeArr = [...nodes.values()].sort((a, b) => cmp(a.id, b.id));
  const edgeArr = edges.sort(
    (a, b) => cmp(a.from, b.from) || cmp(a.type, b.type) || cmp(a.to, b.to),
  );

  const counts = {};
  for (const n of nodeArr) counts[n.type] = (counts[n.type] || 0) + 1;
  const edgeCounts = {};
  for (const e of edgeArr) edgeCounts[e.type] = (edgeCounts[e.type] || 0) + 1;

  return {
    graph: {
      schemaVersion: SCHEMA_VERSION,
      generator: "build-spec-graph.mjs",
      root: toPosix(relative(ROOT, ROOT)) || ".",
      builtFromHash,
      stats: {
        nodes: nodeArr.length,
        edges: edgeArr.length,
        nodesByType: sortObj(counts),
        edgesByType: sortObj(edgeCounts),
      },
      nodes: nodeArr,
      edges: edgeArr,
    },
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

/** Deterministic JSON.stringify with recursively sorted object keys. */
function stableStringify(value, indent = 2) {
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  }
  return JSON.stringify(sortKeys(value), null, indent);
}

// ---------------------------------------------------------------------------
// Self-check: assert the acceptance spot-checks hold.
// ---------------------------------------------------------------------------

function selfCheck(graph, quiet) {
  const edges = graph.graph.edges;
  const has = (from, type, to) =>
    edges.some((e) => e.from === from && e.type === type && e.to === to);

  const hash = graph.graph.builtFromHash;
  const checks = [
    ["work-on WRITES FORGE:TRAJECTORY", has("cmd:work-on", "WRITES", "ann:FORGE:TRAJECTORY")],
    ["review-pr READS FORGE:CONTRACT", has("cmd:review-pr", "READS", "ann:FORGE:CONTRACT")],
    ["builtFromHash is a sha256 hex digest", typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)],
  ];

  // Informational log: how many SHARED_BLOCK edges were found. A count of 0
  // means the corpus has no identical blocks right now (all specs have diverged),
  // which is valid — the detection mechanism is still active and will fire when
  // a future edit creates a shared clone. Not a hard assertion because the
  // corpus can legitimately have zero shared blocks at any point in time.
  const sharedBlockCount = graph.graph.edges.filter((e) => e.type === "SHARED_BLOCK").length;
  if (!quiet) {
    console.error(`  INFO  shared-block edges in corpus: ${sharedBlockCount} (clone-drift detection active)`);
  }

  let allPass = true;
  for (const [label, ok] of checks) {
    if (!ok) allPass = false;
    if (!quiet) console.error(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  return allPass;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// `--hash`: cheap staleness probe — print just the input fingerprint and exit.
// No graph is built or written. graph-query.sh uses this to detect a stale
// persisted graph without paying for a full build on the no-change path.
if (opts.hash) {
  process.stdout.write(computeInputHash(discoverInputFiles()) + "\n");
  process.exit(0);
}

const t0 = Date.now();
const graph = build();
const json = stableStringify(graph) + "\n";

if (opts.stdout) {
  process.stdout.write(json);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
}

if (!opts.quiet) {
  const ms = Date.now() - t0;
  const s = graph.graph.stats;
  console.error(`spec-graph: ${s.nodes} nodes, ${s.edges} edges in ${ms}ms`);
  console.error(`  nodesByType: ${JSON.stringify(s.nodesByType)}`);
  console.error(`  edgesByType: ${JSON.stringify(s.edgesByType)}`);
  if (!opts.stdout) console.error(`  written -> ${toPosix(relative(ROOT, OUT))}`);
}

const ok = selfCheck(graph, opts.quiet);
if (!ok) {
  console.error("spec-graph: SELF-CHECK FAILED — acceptance spot-checks did not hold");
  process.exit(1);
}
